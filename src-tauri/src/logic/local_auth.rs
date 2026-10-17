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
        .unwrap_or_else(|_| "https://kawai-worker.akuntestinguntukseto.workers.dev".into())
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
    let url = format!("{}{path}", worker_base_url());
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
    eprintln!(
        "[auth] {path} → {status} in {}ms: {}",
        started.elapsed().as_millis(),
        text
    );
    Ok((status, json))
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
            eprintln!("[auth] failed to create data root {}: {e}", parent.display());
        }
    }
    if let Err(e) = std::fs::write(&pointer, user_email) {
        eprintln!("[auth] failed to write session pointer {}: {e}", pointer.display());
    }
    let dir = kawai_paths::user_data_dir(user_email);
    if std::fs::create_dir_all(&dir).is_ok() {
        let path = kawai_paths::auth_token(user_email);
        if let Err(e) = kawai_paths::write_private_file(&path, token) {
            eprintln!("[auth] failed to write auth token {}: {e}", path.display());
        }
    }
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
    if sub != email || exp <= std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() {
        return None;
    }
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
        eprintln!("[auth] welcome email to {} failed: {e}", email);
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

    #[test]
    fn derive_credential_is_deterministic_and_password_dependent() {
        // Same salt + password must reproduce the server-side credential on
        // every device; a different password must not.
        let a = derive_credential("abcd1234", "hunter2");
        assert_eq!(a, derive_credential("abcd1234", "hunter2"));
        assert_ne!(a, derive_credential("abcd1234", "hunter3"));
    }
}
