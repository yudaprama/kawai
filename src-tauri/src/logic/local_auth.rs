//! Remote email+password auth shim → kawai-server worker (Cloudflare).
//!
//! Directory user terpusat di D1 (`kawai-auth`); password tidak pernah
//! dikirim. Logic `kawai-vault` lokal tetap inti derivasi kredensial:
//!
//!   credential = SHA-256( hex(salt) || kawai_vault::encode_string(password) )
//!
//! - `encode_string` deterministik → credential sama di device manapun,
//!   jadi email yang sama bisa dipakai lintas device tanpa duplikasi akun.
//! - Salt (16 byte hex) dibuat klien saat sign-up, disimpan server, dan
//!   dikembalikan lewat `POST /auth/salt` saat sign-in.
//! - Sign-up/sign-in yang berhasil mengembalikan Ed25519 bearer token
//!   (7 hari) yang disimpan di `<user_data_dir>/auth.token` untuk
//!   pemanggilan endpoint worker lain (mis. `/transfer`), plus pointer
//!   `<data_root>/last_session` untuk auto-restore sesi saat startup.
//!
//! The legacy `kawai-auth::Store` (local `auth.db` directory) is no longer
//! part of the sign-up/sign-in flow — only its `Session` type and
//! `load_dotenv` are consumed from the crate.

use kawai_auth::UserRecord;

use crate::logic::email;
use sha2::{Digest, Sha256};

/// Base URL worker (env `KAWAI_WORKER_URL`, fallback ke deployment resmi).
/// `pub` for the other worker-proxy modules (`logic::topup`); callers inside
/// this module are unchanged.
pub fn worker_base_url() -> String {
    std::env::var("KAWAI_WORKER_URL")
        .unwrap_or_else(|_| "https://api.kawai.pro".into())
        .trim_end_matches('/')
        .to_string()
}

/// Bounded HTTP client for every worker call (auth, topup, dyntoken).
///
/// The previous `reqwest::Client::new()` had NO connect and NO overall
/// timeout: on a phone network (captive portal, IPv6-first DNS, a blocked
/// edge) the TCP connect sat in the OS retry loop for ~2 minutes and the
/// caller's spinner never resolved — a login that hangs with no error and no
/// log line. These bounds turn that into a surfaced failure. The transport
/// error text is preserved in the returned message (previously discarded by
/// `map_err(|_| "… unreachable")`), so a DNS/TLS/timeout cause is visible.
pub fn worker_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Transport-error message that keeps the historical prefix (callers and
/// tests match on `"auth server unreachable"` / `"worker unreachable"`) and
/// appends the real cause.
///
/// Also emits a `tracing::warn!` — Loki's layer is a TRACING layer, so a
/// plain `eprintln!` reaches the local file/logcat but NOT Grafana Cloud. An
/// un-instrumented auth failure on a phone (no USB, no logcat) was therefore
/// invisible everywhere; the device has no terminal to fall back on. The
/// `user_id_hash` field is what Loki groups its streams by — the raw email
/// must never become a label (cardinality + privacy).
fn transport_error(prefix: &str, e: reqwest::Error) -> String {
    let msg = format!("{prefix}: {e}");
    tracing::warn!(
        component = "auth",
        error = %e,
        is_timeout = e.is_timeout(),
        "worker transport failure"
    );
    msg
}

/// Deterministik — identik dengan skema server (lihat worker/src/auth.rs).
fn derive_credential(salt_hex: &str, password: &str) -> String {
    let encoded = kawai_vault::encode_string(password);
    let mut h = Sha256::new();
    h.update(salt_hex.as_bytes());
    h.update(encoded.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Random 16-byte hex salt (client-side, dikirim bersama credential sign-up).
fn random_salt() -> std::result::Result<String, String> {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::rng().fill_bytes(&mut buf);
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

async fn post_json(path: &str, body: serde_json::Value) -> std::result::Result<(u16, serde_json::Value), String> {
    post_json_at(&worker_base_url(), path, body).await
}

/// `post_json` against an explicit base URL — the seam the reset tests use
/// (a mock listener on 127.0.0.1) without touching the process-wide env.
async fn post_json_at(base: &str, path: &str, body: serde_json::Value) -> std::result::Result<(u16, serde_json::Value), String> {
    let url = format!("{base}{path}");
    eprintln!("[auth] POST {url}");
    let started = std::time::Instant::now();
    let resp = worker_client()
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| transport_error("auth server unreachable", e))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    // NEVER log the body. `/auth/sign_in` and `/auth/sign_up` answer with
    // `{ token, email }`, and `eprintln!` is teed into `app.log` (see
    // `logging.rs`) — logging it would leave a 7-day bearer in plaintext on
    // disk/logcat. Success logs describe the shape (keys only); failure logs
    // carry the worker's bounded error text, which never contains the token.
    let elapsed = started.elapsed().as_millis();
    if status < 400 {
        eprintln!(
            "[auth] {path} → {status} in {elapsed}ms ({} bytes, keys {})",
            text.len(),
            json_shape(&json)
        );
    } else {
        eprintln!(
            "[auth] {path} → {status} in {elapsed}ms ({} bytes): {}",
            text.len(),
            short_error(status, &json)
        );
    }
    Ok((status, json))
}

/// Keys-only description of a JSON body for logging. Values are never
/// printed: the auth responses carry the session bearer, and a value in the
/// log is a credential in the log.
fn json_shape(json: &serde_json::Value) -> String {
    match json {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
            keys.sort_unstable();
            format!("[{}]", keys.join(","))
        }
        serde_json::Value::Array(items) => format!("[array of {}]", items.len()),
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(_) => "bool".to_string(),
        serde_json::Value::Number(_) => "number".to_string(),
        serde_json::Value::String(_) => "string".to_string(),
    }
}

/// Worker error text, bounded — a gateway HTML page must not dump into the
/// log, and the auth line stays readable.
fn short_error(status: u16, json: &serde_json::Value) -> String {
    let msg = error_text(status, json);
    const CAP: usize = 200;
    if msg.chars().count() <= CAP {
        msg
    } else {
        let mut out: String = msg.chars().take(CAP).collect();
        out.push('…');
        out
    }
}

fn error_text(status: u16, json: &serde_json::Value) -> String {
    json.as_str()
        .map(|s| s.to_string())
        .or_else(|| json["error"].as_str().map(|s| s.to_string()))
        .or_else(|| json["message"].as_str().map(|s| s.to_string()))
        .or_else(|| json["detail"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| match status {
            400 => "invalid request".into(),
            401 => "incorrect password".into(),
            404 => "no account found for this email".into(),
            409 => "an account with this email already exists".into(),
            _ => format!("auth server error (HTTP {status})"),
        })
}

/// Persist the bearer token for future worker calls (0600, per-user dir).
/// The per-user dir is created on demand — a fresh sign-in on a new device
/// receives its token before any other data exists.
fn persist_token(user_email: &str, token: &str) {
    // Remember the last signed-in email so `restore_session` can find the
    // token after a restart.
    let pointer = kawai_paths::last_session();
    // The data root itself may not exist yet (first-ever sign-up on a fresh
    // machine) — create it before writing the pointer.
    if let Some(parent) = pointer.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::error!(component = "auth", "failed to create data root {}: {e}", parent.display());
        }
    }
    if let Err(e) = std::fs::write(&pointer, user_email) {
        tracing::error!(component = "auth", "failed to write session pointer {}: {e}", pointer.display());
    }
    let dir = kawai_paths::user_data_dir(user_email);
    if std::fs::create_dir_all(&dir).is_ok() {
        let path = kawai_paths::auth_token(user_email);
        if let Err(e) = kawai_paths::write_private_file(&path, token) {
            tracing::error!(component = "auth", "failed to write auth token {}: {e}", path.display());
        }
    }
    // The freshly minted bearer also unlocks the worker's model-routed LLM
    // gateway (`remote-llm` reads this per turn).
    remote_llm::set_gateway_bearer(Some(token.to_string()));
}

/// Drop the locally persisted session for `user_email` (token file, restore
/// pointer, gateway bearer). Unlike the logout path there is nothing to
/// revoke at the worker: the password reset already killed every outstanding
/// bearer server-side (session epoch bump).
pub fn clear_stored_token(user_email: &str) {
    let _ = std::fs::remove_file(kawai_paths::auth_token(user_email));
    let _ = std::fs::remove_file(kawai_paths::last_session());
    remote_llm::set_gateway_bearer(None);
}

/// Read the stored bearer token for a signed-in user, if any.
pub fn stored_token(user_email: &str) -> Option<String> {
    std::fs::read_to_string(kawai_paths::auth_token(user_email))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Restore a previous session from the persisted token: reads the
/// last-session pointer (`<data_root>/last_session`), loads that user's
/// token, and checks the embedded `sub`/`exp` claims client-side (decode
/// only — the token was server-signed when minted, and the worker re-verifies
/// it on every authorized call). Returns the email to re-establish the
/// session with, so a restart no longer forces a password prompt.
pub fn restore_session() -> Option<String> {
    use base64::Engine;
    let email = std::fs::read_to_string(kawai_paths::last_session())
        .ok()?
        .trim()
        .to_lowercase();
    if email.is_empty() {
        return None;
    }
    let token = stored_token(&email)?;
    let (body, _) = token.split_once('.')?;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(body)
        .ok()?;
    let payload: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    let sub = payload["sub"].as_str()?.to_lowercase();
    let exp = payload["exp"].as_u64()?;
    // The worker rejects tokens without a `jti` (its revocation handle), so
    // restoring one would produce a session that fails on its first worker
    // call — send the user to the login screen instead.
    if payload["jti"].as_str().unwrap_or_default().is_empty() {
        return None;
    }
    if sub != email || exp <= std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() {
        return None;
    }
    // Restored bearer unlocks the worker's model-routed LLM gateway until the
    // next teardown (`clear_local_session`) or sign-in refresh.
    remote_llm::set_gateway_bearer(Some(token));
    Some(email)
}

/// Resolve a bearer token to its email via the worker (`POST /auth/whoami`).
/// Used by the web session middleware to validate the cookie.
pub async fn resolve_bearer(token: &str) -> Option<String> {
    let url = format!("{}/auth/whoami", worker_base_url());
    let resp = worker_client()
        .post(url)
        .bearer_auth(token)
        .send()
        .await
        .ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    json["email"]
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Outcome of server-checking a bearer. The distinction matters at session
/// restore: an explicit rejection must end the local session, while an
/// unreachable worker must not — offline use is a supported mode.
#[derive(Debug)]
pub enum BearerCheck {
    /// The worker accepted the token; carries the verified email.
    Verified(String),
    /// The worker explicitly rejected it (revoked, expired, malformed —
    /// includes a missing stored token). The local session must be dropped.
    Rejected(String),
    /// The worker could not be reached. Keep the local identity; the next
    /// online call re-checks.
    Unreachable(String),
}

/// Server-verify the bearer stored for `user_email`. Identity is only ever
/// resolved through the auth worker — a locally decoded payload is a hint,
/// never a proof.
pub async fn verify_stored_bearer(user_email: &str) -> BearerCheck {
    match stored_token(user_email) {
        Some(token) => verify_bearer(&token).await,
        None => BearerCheck::Rejected("no stored token".into()),
    }
}

/// Check one bearer against the worker (`POST /auth/whoami`).
pub async fn verify_bearer(token: &str) -> BearerCheck {
    verify_bearer_at(&worker_base_url(), token).await
}

/// `verify_bearer` against an explicit base URL — the seam the tests use (a
/// mock listener on 127.0.0.1) without touching the process-wide env.
async fn verify_bearer_at(base: &str, token: &str) -> BearerCheck {
    let url = format!("{base}/auth/whoami");
    let resp = match worker_client().post(url).bearer_auth(token).send().await {
        Ok(resp) => resp,
        Err(e) => return BearerCheck::Unreachable(transport_error("worker unreachable", e)),
    };
    let status = resp.status().as_u16();
    if status != 200 {
        let text = resp.text().await.unwrap_or_default();
        let json: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        return BearerCheck::Rejected(short_error(status, &json));
    }
    let email = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|j| j["email"].as_str().map(str::to_string))
        .filter(|s| !s.is_empty());
    match email {
        Some(email) => BearerCheck::Verified(email),
        None => BearerCheck::Rejected("worker returned no identity".into()),
    }
}

/// Revoke a bearer at the worker (`POST /auth/logout`).
///
/// Dropping the local copy — a token file on desktop, the session cookie on
/// web — only forgets the token on THIS device. The signed value itself stays
/// valid for its whole 7-day TTL anywhere else it exists, so logout has to
/// tell the worker to denylist it. Callers treat this as best-effort: a
/// network failure must never leave the user unable to sign out locally.
pub async fn revoke_token(token: &str) -> std::result::Result<(), String> {
    let url = format!("{}/auth/logout", worker_base_url());
    let started = std::time::Instant::now();
    let resp = worker_client()
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| transport_error("worker unreachable", e))?;
    let status = resp.status().as_u16();
    if status >= 400 {
        let text = resp.text().await.unwrap_or_default();
        let json: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        return Err(format!(
            "logout rejected ({status}): {}",
            short_error(status, &json)
        ));
    }
    tracing::info!(
        component = "auth",
        elapsed_ms = started.elapsed().as_millis() as u64,
        "session bearer revoked"
    );
    Ok(())
}

/// Authorized call to a worker endpoint on behalf of a signed-in user:
/// reads the stored token and sends it as `Authorization: Bearer`.
/// Returns (status, body-json).
pub async fn worker_post(
    user_email: &str,
    path: &str,
    body: serde_json::Value,
) -> std::result::Result<(u16, serde_json::Value), String> {
    let token = stored_token(user_email)
        .ok_or_else(|| "not authenticated (no token — sign in first)".to_string())?;
    let url = format!("{}{path}", worker_base_url());
    let resp = worker_client()
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| transport_error("worker unreachable", e))?;
    let status = resp.status().as_u16();
    let json: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok((status, json))
}

/// POST to an auth endpoint, check status, persist the token, and return the
/// user record. Shared by sign-up and sign-in.
async fn post_auth_and_persist(
    path: &str,
    body: serde_json::Value,
    email: &str,
) -> std::result::Result<UserRecord, String> {
    let (status, json) = post_json(path, body).await?;
    if status != 200 {
        return Err(error_text(status, &json));
    }
    let token = json["token"].as_str().unwrap_or_default().to_string();
    if !token.is_empty() {
        persist_token(email, &token);
    }
    Ok(UserRecord {
        email: email.to_string(),
    })
}

/// Register a new account on the centralized directory: fail when the email
/// already exists, then send a welcome email (best-effort).
pub async fn auth_sign_up(email_addr: &str, password: &str) -> std::result::Result<UserRecord, String> {
    // Validasi lokal dulu supaya errornya sama dengan dulu (sebelum network).
    if !email_addr.contains('@') {
        return Err("invalid email address".into());
    }
    if password.is_empty() {
        return Err("password must not be empty".into());
    }
    let email = email_addr.trim().to_lowercase();
    let salt = random_salt()?;
    let credential = derive_credential(&salt, password);

    let user = post_auth_and_persist(
        "/auth/sign_up",
        serde_json::json!({ "email": email, "salt": salt, "credential": credential }),
        &email,
    )
    .await?;

    // Fire-and-forget welcome email — never blocks or fails signup.
    if let Err(e) = email::send_welcome_email(&email).await {
        tracing::warn!(component = "auth", "welcome email to {} failed: {e}", email);
    }
    Ok(user)
}

/// Verify email+password against the centralized directory.
///
/// The outcome is emitted as a `tracing` event because that is the ONLY
/// channel that reaches Grafana Cloud (Loki's layer is a tracing layer). A
/// phone has no terminal and no adb, so an uninstrumented failure here is
/// invisible everywhere. `user_id_hash` — never the raw email — is the field
/// Loki groups streams by.
pub async fn auth_sign_in(email_addr: &str, password: &str) -> std::result::Result<UserRecord, String> {
    let email = email_addr.trim().to_lowercase();
    let hash = user_hash(&email);
    let started = std::time::Instant::now();

    // 1. Ambil salt publik untuk email ini.
    let (status, json) = post_json("/auth/salt", serde_json::json!({ "email": email })).await?;
    if status != 200 {
        let msg = error_text(status, &json);
        tracing::warn!(
            component = "auth",
            user_id_hash = %hash,
            stage = "salt",
            status,
            "sign-in rejected at salt lookup"
        );
        return Err(msg);
    }
    let salt = match json["salt"].as_str() {
        Some(s) => s.to_string(),
        None => {
            tracing::warn!(
                component = "auth",
                user_id_hash = %hash,
                stage = "salt",
                "salt response missing the salt field"
            );
            return Err("malformed salt response".into());
        }
    };

    // 2. Derive credential dan verifikasi.
    let credential = derive_credential(&salt, password);
    let result = post_auth_and_persist(
        "/auth/sign_in",
        serde_json::json!({ "email": email, "salt": salt, "credential": credential }),
        &email,
    )
    .await;
    match &result {
        // INFO, not WARN: a successful sign-in is not an operational event and
        // must not ship to Loki (which only carries WARN/ERROR).
        Ok(_) => tracing::info!(
            component = "auth",
            user_id_hash = %hash,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "sign-in accepted"
        ),
        Err(e) => tracing::warn!(
            component = "auth",
            user_id_hash = %hash,
            elapsed_ms = started.elapsed().as_millis() as u64,
            error = %e,
            "sign-in failed"
        ),
    }
    result
}

/// Kick off a password reset: the WORKER generates the 6-digit code and
/// emails it — the code never passes through this client. Verification
/// happens server-side because it only means something there: the reset
/// updates an EXISTING account, so anyone who knows the email could call
/// the confirm endpoint directly, and a code verified on-device proves
/// nothing (the sign-up pattern gets away with it only because the worker's
/// 409-on-duplicates is the actual gate). The caller cannot learn whether
/// the email exists from the response.
pub async fn auth_reset_request(email_addr: &str) -> std::result::Result<(), String> {
    auth_reset_request_at(&worker_base_url(), email_addr).await
}

/// `auth_reset_request` against an explicit base URL — the seam the tests
/// use (a mock listener on 127.0.0.1) without touching the process-wide env.
async fn auth_reset_request_at(base: &str, email_addr: &str) -> std::result::Result<(), String> {
    let email = email_addr.trim().to_lowercase();
    if !email.contains('@') {
        return Err("invalid email address".into());
    }
    let hash = user_hash(&email);
    let (status, json) =
        post_json_at(base, "/auth/reset_request", serde_json::json!({ "email": email })).await?;
    if status != 200 {
        let msg = error_text(status, &json);
        // The rate-limit text IS worth surfacing (the user must wait); an
        // unknown email looks exactly like a known one — generic either way.
        tracing::warn!(
            component = "auth",
            user_id_hash = %hash,
            stage = "reset_request",
            status,
            "reset request rejected"
        );
        return Err(msg);
    }
    tracing::info!(component = "auth", user_id_hash = %hash, "reset code requested");
    Ok(())
}

/// Complete a password reset with the emailed code. The client derives the
/// new credential exactly like sign-up (fresh 16-byte salt, same
/// `SHA-256(hex(salt) || vault::encode_string(password))` scheme) and the
/// worker — which just verified the code — installs it. Success revokes
/// every outstanding bearer at the worker (session epoch bump), so this
/// device's stored token must go too: the user signs in again with the new
/// password.
pub async fn auth_reset_confirm(
    email_addr: &str,
    code: &str,
    new_password: &str,
) -> std::result::Result<(), String> {
    auth_reset_confirm_at(&worker_base_url(), email_addr, code, new_password).await
}

/// `auth_reset_confirm` against an explicit base URL — the tests' seam.
async fn auth_reset_confirm_at(
    base: &str,
    email_addr: &str,
    code: &str,
    new_password: &str,
) -> std::result::Result<(), String> {
    let email = email_addr.trim().to_lowercase();
    if !email.contains('@') {
        return Err("invalid email address".into());
    }
    if new_password.is_empty() {
        return Err("password must not be empty".into());
    }
    let hash = user_hash(&email);
    let salt = random_salt()?;
    let credential = derive_credential(&salt, new_password);
    let (status, json) = post_json_at(
        base,
        "/auth/reset_confirm",
        serde_json::json!({
            "email": email,
            "code": code.trim(),
            "salt": salt,
            "credential": credential
        }),
    )
    .await?;
    if status != 200 {
        let msg = error_text(status, &json);
        tracing::warn!(
            component = "auth",
            user_id_hash = %hash,
            stage = "reset_confirm",
            status,
            "reset confirm rejected"
        );
        return Err(msg);
    }
    // All other bearers died at the worker — drop this device's copy so the
    // next launch lands on the sign-in screen instead of a dead session.
    clear_stored_token(&email);
    tracing::info!(
        component = "auth",
        user_id_hash = %hash,
        "password reset confirmed; stored session dropped"
    );
    Ok(())
}

/// Short, stable, non-reversible per-user tag for telemetry grouping. The raw
/// email must never become a Loki label (cardinality + privacy), and it must
/// not be a plain digest either — this is for correlating a device's logs,
/// not for authenticating anything.
fn user_hash(email: &str) -> String {
    use sha2::Digest;
    let digest = Sha256::digest(email.as_bytes());
    digest[..6].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One-shot mock worker: accepts a single connection, answers `status` /
    /// `body`, and returns its base URL for `verify_bearer_at`.
    fn spawn_mock_worker(status: &'static str, body: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    /// Regression (restore trust): `whoami` must be able to tell "worker says
    /// no" (session dead — drop it) apart from "worker unreachable" (offline —
    /// keep the local session). All three outcomes off one endpoint.
    #[tokio::test]
    async fn verify_bearer_classifies_worker_answers() {
        let ok = spawn_mock_worker("200 OK", r#"{"email":"a@b.c"}"#);
        match verify_bearer_at(&ok, "tok").await {
            BearerCheck::Verified(email) => assert_eq!(email, "a@b.c"),
            other => panic!("expected Verified, got {other:?}"),
        }

        let rejected = spawn_mock_worker("401 Unauthorized", r#"{"error":"token revoked"}"#);
        match verify_bearer_at(&rejected, "tok").await {
            BearerCheck::Rejected(reason) => assert!(reason.contains("revoked"), "{reason}"),
            other => panic!("expected Rejected, got {other:?}"),
        }

        // Port with no listener → transport failure, NOT a rejection.
        let unreachable = verify_bearer_at("http://127.0.0.1:1", "tok").await;
        assert!(
            matches!(unreachable, BearerCheck::Unreachable(_)),
            "connection refused must read as Unreachable: {unreachable:?}"
        );
    }

    /// A 200 whose body carries no usable email is a rejection, not a Verified
    /// with an empty identity.
    #[tokio::test]
    async fn verify_bearer_rejects_an_identity_less_ok_response() {
        let base = spawn_mock_worker("200 OK", r#"{"ok":true}"#);
        match verify_bearer_at(&base, "tok").await {
            BearerCheck::Rejected(reason) => assert!(reason.contains("identity"), "{reason}"),
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    /// Regression: every worker call used `reqwest::Client::new()` (no
    /// connect/overall timeout), so an unreachable worker on a phone network
    /// left the login spinner running for the OS TCP retry window with no
    /// error surfaced. Behavioral check: a server that ACCEPTS the connection
    /// and never replies must fail with the transport error instead of hanging
    /// — `start_paused` lets the runtime auto-advance to the client timeout.
    #[tokio::test(start_paused = true)]
    async fn worker_client_times_out_on_a_stalled_worker() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            // Accept one connection, read the request, then never answer.
            if let Ok((mut sock, _)) = listener.accept() {
                use std::io::Read;
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf);
                std::thread::sleep(std::time::Duration::from_secs(3600));
            }
        });

        let err = worker_client()
            .post(format!("http://{addr}/auth/salt"))
            .json(&serde_json::json!({ "email": "a@b.c" }))
            .send()
            .await
            .expect_err("a stalled worker must not answer");
        let msg = transport_error("auth server unreachable", err);
        assert!(msg.starts_with("auth server unreachable: "), "{msg}");
        assert!(
            msg.len() > "auth server unreachable: ".len(),
            "no cause: {msg}"
        );
    }

    /// A transport failure must keep the historical prefix (callers match on
    /// it) AND carry the real cause — the old `map_err(|_| "… unreachable")`
    /// discarded it, which is why a phone-side hang had nothing to report.
    #[tokio::test]
    async fn transport_error_keeps_prefix_and_adds_cause() {
        // Drive a real reqwest failure: an invalid host cannot resolve.
        let msg = match worker_client().get("http://kawai.invalid./").send().await {
            Ok(_) => panic!("expected a transport failure for an invalid host"),
            Err(e) => transport_error("auth server unreachable", e),
        };
        assert!(
            msg.starts_with("auth server unreachable: "),
            "prefix lost: {msg}"
        );
        assert!(
            msg.len() > "auth server unreachable: ".len(),
            "no cause: {msg}"
        );
    }

    /// Same prefix contract for the worker-proxy path.
    #[tokio::test]
    async fn transport_error_prefix_is_stable_for_worker_post() {
        let msg = match worker_client().get("http://kawai.invalid./").send().await {
            Ok(_) => panic!("expected a transport failure for an invalid host"),
            Err(e) => transport_error("worker unreachable", e),
        };
        assert!(msg.starts_with("worker unreachable: "), "prefix lost: {msg}");
    }

    #[test]
    fn error_text_keeps_worker_messages() {
        let json = serde_json::json!({ "error": "incorrect password" });
        assert_eq!(error_text(401, &json), "incorrect password");
        assert_eq!(error_text(404, &serde_json::json!({})), "no account found for this email");
    }

    /// Regression: `post_json` used to `eprintln!` the whole worker response.
    /// Sign-in/sign-up answer with `{ token, email }` — the Ed25519 bearer —
    /// so every login wrote a 7-day credential into `app.log`. The log line
    /// must describe the body without ever printing a value.
    #[test]
    fn json_shape_never_leaks_a_token_value() {
        let body = serde_json::json!({ "token": "super-secret-bearer", "email": "a@b.c" });
        let shape = json_shape(&body);
        assert_eq!(shape, "[email,token]");
        assert!(!shape.contains("super-secret-bearer"));
        assert!(!shape.contains("a@b.c"));
    }

    #[test]
    fn json_shape_covers_non_object_bodies() {
        assert_eq!(json_shape(&serde_json::Value::Null), "null");
        assert_eq!(json_shape(&serde_json::json!(["x"])), "[array of 1]");
        assert_eq!(json_shape(&serde_json::json!("token")), "string");
        assert_eq!(json_shape(&serde_json::json!(1)), "number");
        assert_eq!(json_shape(&serde_json::json!(true)), "bool");
    }

    #[test]
    fn short_error_passes_through_and_bounds_oversized_bodies() {
        // A normal worker error is unchanged.
        let small = serde_json::json!({ "error": "incorrect password" });
        assert_eq!(short_error(401, &small), "incorrect password");
        // An oversized body (e.g. a gateway HTML page) is capped.
        let huge = serde_json::json!({ "error": "x".repeat(5_000) });
        let msg = short_error(500, &huge);
        assert_eq!(msg.chars().count(), 201); // 200 chars + the ellipsis
    }

    #[test]
    fn derive_credential_is_deterministic_and_password_dependent() {
        // Same salt + password must reproduce the server-side credential on
        // every device; a different password must not.
        let a = derive_credential("abcd1234", "hunter2");
        assert_eq!(a, derive_credential("abcd1234", "hunter2"));
        assert_ne!(a, derive_credential("abcd1234", "hunter3"));
    }

    /// Mock that CAPTURES the request body so a test can pin the exact JSON
    /// the worker receives (normalized email, trimmed code, fresh salt,
    /// derived credential).
    fn spawn_capturing_worker(
        status: &'static str,
        body: &'static str,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Option<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let captured: std::sync::Arc<std::sync::Mutex<Option<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        let sink = captured.clone();
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut buf = [0u8; 8192];
                let n = sock.read(&mut buf).unwrap_or(0);
                let raw = String::from_utf8_lossy(&buf[..n]).to_string();
                if let Some(payload) = raw.split("\r\n\r\n").nth(1) {
                    *sink.lock().unwrap() = Some(payload.to_string());
                }
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes());
            }
        });
        (format!("http://{addr}"), captured)
    }

    /// 200 → ok; 429 → the worker's rate-limit text passes through (the user
    /// must wait), everything the worker says stays the user-facing message.
    #[tokio::test]
    async fn auth_reset_request_maps_worker_answers() {
        let ok = spawn_mock_worker("200 OK", r#"{"ok":true}"#);
        auth_reset_request_at(&ok, "a@b.c")
            .await
            .expect("a 200 must pass");

        let limited = spawn_mock_worker(
            "429 Too Many Requests",
            r#"{"error":"too many reset requests — try again later"}"#,
        );
        let err = auth_reset_request_at(&limited, "a@b.c")
            .await
            .expect_err("429 must fail");
        assert!(err.contains("too many reset requests"), "{err}");
    }

    /// The confirm payload must carry the normalized email, the trimmed code,
    /// a FRESH 16-byte salt, and the credential derived with the sign-up
    /// scheme — the worker validates the shape and installs exactly this.
    #[tokio::test]
    async fn auth_reset_confirm_sends_code_salt_and_credential() {
        let (base, captured) = spawn_capturing_worker("200 OK", r#"{"ok":true}"#);
        auth_reset_confirm_at(&base, " A@B.C ", " 123456 ", "hunter2")
            .await
            .expect("confirm must pass");
        let raw = captured
            .lock()
            .unwrap()
            .clone()
            .expect("request body captured");
        let json: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(json["email"], "a@b.c");
        assert_eq!(json["code"], "123456");
        let salt = json["salt"].as_str().expect("salt is a string");
        assert_eq!(salt.len(), 32, "salt must be 16-byte hex");
        assert!(salt.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(json["credential"], derive_credential(salt, "hunter2"));
    }

    /// A wrong-code 400 surfaces the worker's GENERIC text verbatim — the
    /// client must not add anything that distinguishes wrong from expired
    /// from consumed.
    #[tokio::test]
    async fn auth_reset_confirm_surfaces_the_generic_rejection() {
        let base = spawn_mock_worker(
            "400 Bad Request",
            r#"{"error":"code is invalid or expired"}"#,
        );
        let err = auth_reset_confirm_at(&base, "a@b.c", "000000", "hunter2")
            .await
            .expect_err("400 must fail");
        assert_eq!(err, "code is invalid or expired");
    }
}
