//! Local email+password auth shim → `kawai-auth` (pure crate).
//!
//! The user directory (`<data_root>/auth.db`) is keyed by email — the email
//! IS the identity. The same email can never register twice. Passwords ride
//! `kawai-vault` encoding.

pub use kawai_auth::*;

use crate::logic::email;

/// Register a new account: fail when the email already exists, then send a
/// confirmation email (best-effort — registration succeeds even if the relay
/// is unreachable).
pub async fn auth_sign_up(email_addr: &str, password: &str) -> std::result::Result<UserRecord, String> {
    let store = open_store().await.map_err(|e| e.to_string())?;
    let user = store
        .sign_up(email_addr, password)
        .await
        .map_err(|e| e.to_string())?;
    // Fire-and-forget confirmation email — never blocks or fails signup.
    if let Err(e) = email::send_welcome_email(&user.email).await {
        eprintln!("[auth] welcome email to {} failed: {e}", user.email);
    }
    Ok(user)
}

/// Verify email+password and return the user.
pub async fn auth_sign_in(email_addr: &str, password: &str) -> std::result::Result<UserRecord, String> {
    let store = open_store().await.map_err(|e| e.to_string())?;
    store
        .sign_in(email_addr, password)
        .await
        .map_err(|e| e.to_string())
}
