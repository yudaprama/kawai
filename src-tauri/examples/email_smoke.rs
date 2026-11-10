// Headless smoke test for the client-side sign-up verification mail path
// (logic::email): send a real 6-digit code through the Brevo SMTP relay, then
// exercise the in-memory store — a bogus code must be rejected, and the code
// you type from the inbox must be accepted (and consumed).
//
// Usage:
//   cargo run --example email_smoke                       # KAWAI_ADMIN_EMAIL from .env
//   cargo run --example email_smoke -- you@example.com
use std::io::Write;

use kawai_lib::logic::email;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();

    let to = std::env::args().nth(1).unwrap_or_else(|| {
        std::env::var("KAWAI_ADMIN_EMAIL")
            .expect("usage: email_smoke <email> (or set KAWAI_ADMIN_EMAIL)")
    });
    let to = to.trim().to_lowercase();

    println!("sending a verification code to {to} via the Brevo SMTP relay ...");
    match email::send_sign_up_code(&to).await {
        Ok(()) => println!("relay accepted the message — check the inbox"),
        Err(e) => {
            eprintln!("send failed: {e}");
            std::process::exit(1);
        }
    }

    // The store must reject a code that was never issued.
    let bogus = if email::generate_verification_code() == "000000" {
        "000001"
    } else {
        "000000"
    };
    assert!(
        !email::verify_sign_up_code(&to, bogus),
        "a code that was never issued must be rejected"
    );
    println!("bogus code rejected — the store is wired");

    print!("paste the 6-digit code from the email (empty = skip): ");
    let _ = std::io::stdout().flush();
    let mut input = String::new();
    if std::io::stdin().read_line(&mut input).is_err() || input.trim().is_empty() {
        println!("skipped the accept check");
        return;
    }
    if email::verify_sign_up_code(&to, &input) {
        println!("ACCEPTED — auth_verify_code would now let auth_sign_up create the account");
    } else {
        eprintln!("REJECTED — wrong or expired code");
        std::process::exit(1);
    }
}
