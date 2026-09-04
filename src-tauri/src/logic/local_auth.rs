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
fn worker_base_url() -> String {
    std::env::var("KAWAI_WORKER_URL")
        .unwrap_or_else(|_| "https://kawai-worker.akuntestinguntukseto.workers.dev".into())
        .trim_end_matches('/')
        .to_string()
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
    let url = format!("{}{path}", worker_base_url());
    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("auth server unreachable: {e}"))?;
    let status = resp.status().as_u16();
    let json: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok((status, json))
}

fn error_text(status: u16, json: &serde_json::Value) -> String {
    json.as_str()
        .map(|s| s.to_string())
        .or_else(|| json["error"].as_str().map(|s| s.to_string()))
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
    let _ = std::fs::write(kawai_paths::data_root().join("last_session"), user_email);
    let dir = kawai_paths::user_data_dir(user_email);
    if std::fs::create_dir_all(&dir).is_ok() {
        let path = dir.join("auth.token");
        if std::fs::write(&path, token).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
}

/// Read the stored bearer token for a signed-in user, if any.
pub fn stored_token(user_email: &str) -> Option<String> {
    std::fs::read_to_string(kawai_paths::user_data_dir(user_email).join("auth.token"))
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
    let email = std::fs::read_to_string(kawai_paths::data_root().join("last_session"))
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
    if sub != email || exp <= std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() {
        return None;
    }
    Some(email)
}

/// Resolve a bearer token to its email via the worker (`POST /auth/whoami`).
/// Used by the web session middleware to validate the cookie.
pub async fn resolve_bearer(token: &str) -> Option<String> {
    let url = format!("{}/auth/whoami", worker_base_url());
    let resp = reqwest::Client::new()
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
    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("worker unreachable: {e}"))?;
    let status = resp.status().as_u16();
    let json: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok((status, json))
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

    let (status, json) = post_json(
        "/auth/sign_up",
        serde_json::json!({ "email": email, "salt": salt, "credential": credential }),
    )
    .await?;
    if status != 200 {
        return Err(error_text(status, &json));
    }
    let token = json["token"].as_str().unwrap_or_default().to_string();
    if !token.is_empty() {
        persist_token(&email, &token);
    }

    // Fire-and-forget welcome email — never blocks or fails signup.
    if let Err(e) = email::send_welcome_email(&email).await {
        eprintln!("[auth] welcome email to {} failed: {e}", email);
    }
    Ok(UserRecord { email })
}

/// Verify email+password against the centralized directory.
pub async fn auth_sign_in(email_addr: &str, password: &str) -> std::result::Result<UserRecord, String> {
    let email = email_addr.trim().to_lowercase();

    // 1. Ambil salt publik untuk email ini.
    let (status, json) = post_json("/auth/salt", serde_json::json!({ "email": email })).await?;
    if status != 200 {
        return Err(error_text(status, &json));
    }
    let salt = json["salt"].as_str().ok_or("malformed salt response")?.to_string();

    // 2. Derive credential dan verifikasi.
    let credential = derive_credential(&salt, password);
    let (status, json) = post_json(
        "/auth/sign_in",
        serde_json::json!({ "email": email, "salt": salt, "credential": credential }),
    )
    .await?;
    if status != 200 {
        return Err(error_text(status, &json));
    }
    let token = json["token"].as_str().unwrap_or_default().to_string();
    if !token.is_empty() {
        persist_token(&email, &token);
    }
    Ok(UserRecord { email })
}
