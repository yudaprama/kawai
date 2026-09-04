//! Client-side email verification — generate a 6-digit code and email it via
//! the Brevo SMTP relay ([`kawai_email`]). The caller keeps the returned code
//! and checks the user's input locally; the auth server is never involved.

/// Generate a uniformly random 6-digit numeric code (OS entropy via `rand`).
pub fn generate_verification_code() -> String {
    use rand::Rng;
    let n: u32 = rand::rng().random_range(0..1_000_000);
    format!("{n:06}")
}

/// Generate a code and email it to `to`. Returns the code so the caller can
/// verify the user's input locally.
pub async fn send_verification_email(to: &str) -> Result<String, String> {
    let code = generate_verification_code();
    let subject = "Kawai — your verification code";
    let text = format!("Your Kawai verification code is: {code}\n\nIt expires when you close the app.");
    let html = format!(
        "<p>Your Kawai verification code is:</p>\
         <p style=\"font-size:28px;letter-spacing:6px;font-weight:700\">{code}</p>\
         <p>Enter this code in the app to finish creating your account.</p>"
    );
    kawai_email::send_email_html(to, subject, &text, &html)
        .await
        .map_err(|e| e.to_string())?;
    Ok(code)
}

/// Best-effort confirmation email sent after a successful local sign-up
/// (no code — the account is already active).
pub async fn send_welcome_email(to: &str) -> Result<(), String> {
    let subject = "Welcome to Kawai";
    let text = format!(
        "Your Kawai account ({to}) has been created.\n\nIf this wasn't you, you can ignore this email."
    );
    let html = format!(
        "<p>Your <strong>Kawai</strong> account ({to}) has been created.</p>\
         <p>If this wasn't you, you can ignore this email.</p>"
    );
    kawai_email::send_email_html(to, subject, &text, &html)
        .await
        .map_err(|e| e.to_string())
}

// ── Sign-up verification codes (client-side flow, desktop option A) ─────────

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// email → (code, sent-at). In-memory only: restarting the app invalidates
/// pending codes, which is acceptable for a sign-up flow.
fn codes() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static CODES: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    CODES.get_or_init(|| Mutex::new(HashMap::new()))
}

const CODE_TTL: Duration = Duration::from_secs(10 * 60);

/// Email a 6-digit code to `to` and remember it for later [`verify_code`].
pub async fn send_sign_up_code(to: &str) -> Result<(), String> {
    let to = to.trim().to_lowercase();
    let code = send_verification_email(&to).await?;
    codes()
        .lock()
        .map_err(|_| "verification store unavailable".to_string())?
        .insert(to, (code, Instant::now()));
    Ok(())
}

/// Check the user's input against the pending code (case/space tolerant).
/// A match consumes the code (single use). Codes expire after 10 minutes.
pub fn verify_sign_up_code(to: &str, code: &str) -> bool {
    let to = to.trim().to_lowercase();
    let input = code.trim();
    let Ok(mut map) = codes().lock() else {
        return false;
    };
    match map.get(&to) {
        Some((expected, sent_at))
            if sent_at.elapsed() < CODE_TTL && expected == input =>
        {
            map.remove(&to);
            true
        }
        _ => false,
    }
}
