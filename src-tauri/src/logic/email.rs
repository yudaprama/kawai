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
