//! Pure auth module: verify OIDC JWTs and hold the in-process session.
//!
//! Transport-agnostic — no `tauri`/`axum` imports here. Both wrappers
//! (`commands.rs`, `web.rs`) call [`Verifier::verify`] to resolve a [`Claims`],
//! then pass `claims.sub` into `logic.rs` as the `user_id` param. This keeps
//! the "pure logic, thin wrappers" invariant intact: identity is resolved at
//! the transport edge, business logic just receives a user id.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use jsonwebtoken::{decode_header, jwk::Jwk, DecodingKey, Validation};
use serde::Deserialize;
use serde_json::Value;

/// JWT claims. `sub` is the stable user id used to route to the per-user
/// libsql replica / Turso tenant. Any other claim is preserved in `extra`.
#[derive(Clone, Debug, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub iss: Option<String>,
    pub aud: Option<Value>,
    pub exp: Option<u64>,
    pub iat: Option<u64>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug)]
pub enum AuthError {
    InvalidToken(String),
    Expired,
    NoKid,
    NoKey(String),
    JwksNotConfigured,
    FetchJwks(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::InvalidToken(m) => write!(f, "invalid token: {m}"),
            AuthError::Expired => write!(f, "token expired"),
            AuthError::NoKid => write!(f, "token header has no kid"),
            AuthError::NoKey(k) => write!(f, "no key for kid={k} in JWKS"),
            AuthError::JwksNotConfigured => write!(f, "JWKS URI not configured"),
            AuthError::FetchJwks(m) => write!(f, "JWKS fetch failed: {m}"),
        }
    }
}

impl std::error::Error for AuthError {}

impl From<jsonwebtoken::errors::Error> for AuthError {
    fn from(e: jsonwebtoken::errors::Error) -> Self {
        let msg = e.to_string();
        if msg.to_lowercase().contains("exp") {
            AuthError::Expired
        } else {
            AuthError::InvalidToken(msg)
        }
    }
}

/// Verifies OIDC JWTs (any algorithm declared in the token header) against a
/// JWKS endpoint, with optional issuer/audience validation. Provider-agnostic:
/// works with Clerk, Auth0, WorkOS, Keycloak, etc.
#[derive(Clone)]
pub struct Verifier {
    jwks_uri: Option<String>,
    issuer: Option<String>,
    audience: Option<String>,
    dev_user_id: Option<String>,
    /// kid -> raw JWK object, cached after first fetch.
    keys: Arc<RwLock<HashMap<String, Value>>>,
}

impl Verifier {
    pub fn new(
        jwks_uri: Option<String>,
        issuer: Option<String>,
        audience: Option<String>,
        dev_user_id: Option<String>,
    ) -> Self {
        Self {
            jwks_uri,
            issuer,
            audience,
            dev_user_id,
            keys: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Read config from env:
    /// - `KAWAI_AUTH_JWKS_URI`    — JWKS endpoint (required for real verification)
    /// - `KAWAI_AUTH_ISSUER`      — optional expected `iss`
    /// - `KAWAI_AUTH_AUDIENCE`    — optional expected `aud`
    /// - `KAWAI_AUTH_DEV_USER_ID` — if set, ANY token verifies as this user.
    ///   Dev only; never set in production.
    pub fn from_env() -> Self {
        let nonempty = |v: Result<String, std::env::VarError>| v.ok().filter(|s| !s.is_empty());
        Self::new(
            nonempty(std::env::var("KAWAI_AUTH_JWKS_URI")),
            nonempty(std::env::var("KAWAI_AUTH_ISSUER")),
            nonempty(std::env::var("KAWAI_AUTH_AUDIENCE")),
            nonempty(std::env::var("KAWAI_AUTH_DEV_USER_ID")),
        )
    }

    pub fn has_dev_bypass(&self) -> bool {
        self.dev_user_id.is_some()
    }

    pub async fn verify(&self, token: &str) -> Result<Claims, AuthError> {
        if let Some(uid) = &self.dev_user_id {
            return Ok(dev_claims(uid));
        }

        let header = decode_header(token)?;
        let kid = header.kid.ok_or(AuthError::NoKid)?;
        let alg = header.alg;

        let jwk_value = self.jwk_for(&kid).await?;
        let jwk: Jwk = serde_json::from_value(jwk_value)
            .map_err(|e| AuthError::InvalidToken(e.to_string()))?;
        let key =
            DecodingKey::from_jwk(&jwk).map_err(|e| AuthError::InvalidToken(e.to_string()))?;

        let mut validation = Validation::new(alg);
        validation.validate_exp = true;
        if let Some(iss) = &self.issuer {
            validation.set_issuer(&[iss]);
        }
        if let Some(aud) = &self.audience {
            validation.set_audience(&[aud]);
        }

        let data = jsonwebtoken::decode::<Claims>(token, &key, &validation)?;
        Ok(data.claims)
    }

    /// Return the cached JWK for `kid`, fetching the JWKS once on miss.
    async fn jwk_for(&self, kid: &str) -> Result<Value, AuthError> {
        if let Some(jwk) = self.keys.read().unwrap().get(kid).cloned() {
            return Ok(jwk);
        }
        let jwks_uri = self.jwks_uri.as_ref().ok_or(AuthError::JwksNotConfigured)?;
        let body: Value = reqwest::get(jwks_uri)
            .await
            .map_err(|e| AuthError::FetchJwks(e.to_string()))?
            .json()
            .await
            .map_err(|e| AuthError::FetchJwks(e.to_string()))?;
        let arr = body
            .get("keys")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AuthError::FetchJwks("JWKS has no keys[] array".into()))?;
        {
            let mut cache = self.keys.write().unwrap();
            for k in arr {
                if let Some(this_kid) = k.get("kid").and_then(|v| v.as_str()) {
                    cache.insert(this_kid.to_string(), k.clone());
                }
            }
        }
        self.keys
            .read()
            .unwrap()
            .get(kid)
            .cloned()
            .ok_or_else(|| AuthError::NoKey(kid.to_string()))
    }
}

fn dev_claims(uid: &str) -> Claims {
    Claims {
        sub: uid.to_string(),
        iss: Some("dev".to_string()),
        aud: None,
        exp: None,
        iat: None,
        extra: HashMap::new(),
    }
}

/// Best-effort load of the project-root `.env` at startup, so `KAWAI_AUTH_*`
/// can live next to the Vite env without shell juggling. No-op if absent
/// (e.g. in a packaged app). The path is baked at compile time via
/// `CARGO_MANIFEST_DIR`, so it resolves regardless of the runtime CWD.
pub fn load_dotenv() {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env");
    let _ = dotenvy::from_path(&p);
}

/// In-process session for desktop/mobile. Web does NOT use this — it is
/// stateless: the cookie carries the JWT, re-verified each request by the
/// Axum middleware. Defined here so both wrappers share one identity type.
///
/// TODO: this is in-memory and does NOT survive an app restart. For real
/// desktop/mobile persistence, back it with the OS keychain
/// (`tauri-plugin-stronghold` / keyring) so the token is reloaded on launch.
pub type Session = Arc<RwLock<Option<Claims>>>;

pub fn new_session() -> Session {
    Arc::new(RwLock::new(None))
}
