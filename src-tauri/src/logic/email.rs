//! Client-side email verification — generate a 6-digit code and email it via
//! the Brevo SMTP relay ([`kawai_email`]). The caller keeps the returned code
//! and checks the user's input locally; the auth server is never involved.

/// Generate a uniformly random 6-digit numeric code (OS entropy via `rand`).
pub fn generate_verification_code() -> String {
    use rand::Rng;
    let n: u32 = rand::rng().random_range(0..1_000_000);
    format!("{n:06}")
}

/// Errors that can occur during email operations.
#[derive(Debug, thiserror::Error)]
pub enum EmailError {
    #[error("Failed to send email: {0}")]
    SendFailed(String),
    #[error("Verification store unavailable")]
    StoreUnavailable,
    #[error("Invalid email address: {0}")]
    InvalidAddress(String),
    /// Per-address cooldown or the process-wide send budget is exhausted.
    #[error("please wait a moment before requesting another code")]
    TooManyRequests,
}

/// Generate a code and email it to `to`. Returns the code so the caller can
/// verify the user's input locally.
pub async fn send_verification_email(to: &str) -> Result<String, EmailError> {
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
        .map_err(|e| EmailError::SendFailed(e.to_string()))?;
    Ok(code)
}

/// Best-effort confirmation email sent after a successful local sign-up
/// (no code — the account is already active).
pub async fn send_welcome_email(to: &str) -> Result<(), EmailError> {
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
        .map_err(|e| EmailError::SendFailed(e.to_string()))
}

// ── Sign-up verification codes (client-side flow, desktop option A) ─────────

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A pending sign-up code for one address.
#[derive(Debug)]
struct PendingCode {
    /// Empty while the send is in flight (the slot is reserved first, so a
    /// second request inside the cooldown cannot race a second email out).
    code: String,
    sent_at: Instant,
    attempts: u8,
}

/// email → pending code. In-memory only: restarting the app invalidates
/// pending codes, which is acceptable for a sign-up flow.
fn codes() -> &'static Mutex<HashMap<String, PendingCode>> {
    static CODES: OnceLock<Mutex<HashMap<String, PendingCode>>> = OnceLock::new();
    CODES.get_or_init(|| Mutex::new(HashMap::new()))
}

const CODE_TTL: Duration = Duration::from_secs(10 * 60);
/// One code per address per minute — the endpoint is public, and a resend loop
/// otherwise turns this app into an SMTP relay for the address in question.
const RESEND_COOLDOWN: Duration = Duration::from_secs(60);
/// A code dies after this many wrong entries, so a 6-digit space cannot be
/// walked brute-force one attempt at a time.
const MAX_ATTEMPTS: u8 = 5;
/// Hard cap on live entries: distinct addresses must not grow the map without
/// bound on a public endpoint.
const MAX_PENDING: usize = 4096;
/// Process-wide send budget (rolling hour). The per-address cooldown bounds
/// one address; this bounds an attacker who iterates addresses.
const SEND_WINDOW: Duration = Duration::from_secs(60 * 60);
const MAX_SENDS_PER_WINDOW: u32 = 120;

struct SendBudget {
    window_start: Instant,
    sent: u32,
}

/// Consume one slot of the process-wide send budget. `false` = exhausted.
fn consume_send_budget() -> bool {
    static BUDGET: OnceLock<Mutex<SendBudget>> = OnceLock::new();
    let Ok(mut budget) = BUDGET
        .get_or_init(|| Mutex::new(SendBudget { window_start: Instant::now(), sent: 0 }))
        .lock()
    else {
        return false;
    };
    if budget.window_start.elapsed() >= SEND_WINDOW {
        budget.window_start = Instant::now();
        budget.sent = 0;
    }
    if budget.sent >= MAX_SENDS_PER_WINDOW {
        return false;
    }
    budget.sent += 1;
    true
}

/// Reserve (or refresh) the pending slot for `to`, pruning dead entries first.
/// Returns the entry the reservation REPLACED (if any) so a send that never
/// happens can put it back — an address must not lose a code it already
/// received because a later resend failed.
///
/// Pure over the map and the clock so the guards are testable without SMTP.
fn reserve_slot(
    map: &mut HashMap<String, PendingCode>,
    to: &str,
    now: Instant,
) -> Result<Option<PendingCode>, EmailError> {
    map.retain(|_, pending| now.duration_since(pending.sent_at) < CODE_TTL);
    if let Some(pending) = map.get(to) {
        if now.duration_since(pending.sent_at) < RESEND_COOLDOWN {
            return Err(EmailError::TooManyRequests);
        }
    }
    if map.len() >= MAX_PENDING && !map.contains_key(to) {
        if let Some(oldest) = map.iter().min_by_key(|(_, p)| p.sent_at).map(|(k, _)| k.clone()) {
            map.remove(&oldest);
        }
    }
    let previous = map.insert(
        to.to_string(),
        PendingCode { code: String::new(), sent_at: now, attempts: 0 },
    );
    Ok(previous)
}

/// Undo a reservation whose mail never went out: put the previous code back
/// (or clear the slot when there was none) so the address is neither stuck in
/// cooldown nor stripped of a code it already holds.
fn release_slot(to: &str, previous: Option<PendingCode>) {
    if let Ok(mut map) = codes().lock() {
        match previous {
            Some(pending) => {
                map.insert(to.to_string(), pending);
            }
            None => {
                map.remove(to);
            }
        }
    }
}

/// Email a 6-digit code to `to` and remember it for later
/// [`verify_sign_up_code`].
pub async fn send_sign_up_code(to: &str) -> Result<(), EmailError> {
    let to = to.trim().to_lowercase();
    if !to.contains('@') {
        return Err(EmailError::InvalidAddress(to));
    }
    // Reserve before sending: two concurrent requests for the same address
    // must not both pass the cooldown check and both hit the relay.
    let previous = codes()
        .lock()
        .map_err(|_| EmailError::StoreUnavailable)
        .and_then(|mut map| reserve_slot(&mut map, &to, Instant::now()))?;
    if !consume_send_budget() {
        // Roll the reservation back so the address is not stuck in cooldown
        // for a mail that was never sent.
        release_slot(&to, previous);
        return Err(EmailError::TooManyRequests);
    }
    let code = match send_verification_email(&to).await {
        Ok(code) => code,
        Err(e) => {
            // A failed send must not leave a phantom entry behind — and the
            // code the address already held (a retried resend) stays valid.
            release_slot(&to, previous);
            return Err(e);
        }
    };
    if let Ok(mut map) = codes().lock() {
        if let Some(pending) = map.get_mut(&to) {
            pending.code = code;
            pending.sent_at = Instant::now();
        }
    }
    Ok(())
}

/// Check the user's input against the pending code (case/space tolerant).
/// A match consumes the code (single use); a miss burns one of
/// [`MAX_ATTEMPTS`] and the code is dropped when they run out. Codes expire
/// after [`CODE_TTL`].
pub fn verify_sign_up_code(to: &str, code: &str) -> bool {
    let to = to.trim().to_lowercase();
    let input = code.trim();
    let Ok(mut map) = codes().lock() else {
        return false;
    };
    enum Verdict {
        Accept,
        Drop,
        Miss,
    }
    let verdict = match map.get_mut(&to) {
        None => return false,
        Some(pending) => {
            if pending.sent_at.elapsed() >= CODE_TTL {
                Verdict::Drop
            } else if pending.code.is_empty() {
                // The mail is still in flight (`reserve_slot` holds the slot
                // with an empty code). Dropping here removed the entry, so the
                // send's `get_mut` found nothing and the code it had just
                // emailed was discarded — the address could not verify until
                // the cooldown expired. A miss leaves the entry untouched.
                Verdict::Miss
            } else if pending.code == input {
                Verdict::Accept
            } else {
                pending.attempts += 1;
                if pending.attempts >= MAX_ATTEMPTS {
                    Verdict::Drop
                } else {
                    Verdict::Miss
                }
            }
        }
    };
    match verdict {
        Verdict::Accept => {
            map.remove(&to);
            true
        }
        Verdict::Drop => {
            map.remove(&to);
            false
        }
        Verdict::Miss => false,
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A code is always six ASCII digits (the UI and the sign-up form assume it).
    #[test]
    fn generated_code_is_six_digits() {
        for _ in 0..256 {
            let code = generate_verification_code();
            assert_eq!(code.len(), 6, "{code}");
            assert!(code.chars().all(|c| c.is_ascii_digit()), "{code}");
        }
    }

    /// The happy path: the pending code matches (email lowercased, both sides
    /// trimmed) and is consumed — the same code never verifies twice.
    #[test]
    fn pending_code_verifies_once() {
        let email = "seed-once@example.com";
        codes().lock().unwrap().insert(
            email.into(),
            PendingCode { code: "123456".into(), sent_at: Instant::now(), attempts: 0 },
        );

        assert!(verify_sign_up_code(" Seed-Once@Example.com ", " 123456 "));
        assert!(!verify_sign_up_code(email, "123456"), "code is single use");
    }

    /// Expired codes, wrong codes and unknown emails are rejected — and a wrong
    /// code must not consume the pending one.
    #[test]
    fn expired_wrong_and_unknown_codes_are_rejected() {
        let stale = "stale@example.com";
        let old = Instant::now() - (CODE_TTL + Duration::from_secs(1));
        codes().lock().unwrap().insert(
            stale.into(),
            PendingCode { code: "654321".into(), sent_at: old, attempts: 0 },
        );
        assert!(!verify_sign_up_code(stale, "654321"));

        let live = "live@example.com";
        codes().lock().unwrap().insert(
            live.into(),
            PendingCode { code: "111111".into(), sent_at: Instant::now(), attempts: 0 },
        );
        assert!(!verify_sign_up_code(live, "222222"));
        assert!(verify_sign_up_code(live, "111111"), "a miss must not consume");

        assert!(!verify_sign_up_code("nobody@example.com", "000000"));
    }

    /// A verify that lands while the mail is still in flight (the reservation
    /// holds an EMPTY code) must not consume the slot: the send would then
    /// find no entry and discard the code it just mailed, leaving the address
    /// unverifiable for the whole cooldown.
    #[test]
    fn in_flight_reservation_survives_a_verify() {
        let email = "in-flight@example.com";
        // Exactly what `reserve_slot` inserts before the SMTP round-trip.
        codes().lock().unwrap().insert(
            email.into(),
            PendingCode { code: String::new(), sent_at: Instant::now(), attempts: 0 },
        );
        assert!(!verify_sign_up_code(email, "123456"));

        // The send completes and stores the code on the SAME entry.
        {
            let mut map = codes().lock().unwrap();
            let pending = map.get_mut(email).expect("reservation was not dropped");
            assert!(pending.code.is_empty(), "a miss must not burn attempts");
            assert_eq!(pending.attempts, 0);
            pending.code = "123456".into();
        }
        assert!(verify_sign_up_code(email, "123456"), "the emailed code must verify");
    }

    /// The 6-digit space is walkable one guess at a time, so a wrong entry
    /// must burn an attempt and the code must die after `MAX_ATTEMPTS` —
    /// otherwise a public endpoint is an oracle.
    #[test]
    fn wrong_attempts_burn_the_code() {
        let email = "burn@example.com";
        codes().lock().unwrap().insert(
            email.into(),
            PendingCode { code: "999999".into(), sent_at: Instant::now(), attempts: 0 },
        );
        for _ in 0..MAX_ATTEMPTS {
            assert!(!verify_sign_up_code(email, "000000"));
        }
        // The correct code no longer works: the entry was dropped.
        assert!(!verify_sign_up_code(email, "999999"));
    }

    /// A second reservation inside the cooldown is refused (no second email),
    /// and reserving again after it succeeds. Pruning drops expired entries.
    #[test]
    fn reserve_slot_enforces_cooldown_and_prunes() {
        let mut map: HashMap<String, PendingCode> = HashMap::new();
        let now = Instant::now();
        assert!(reserve_slot(&mut map, "a@b.c", now).is_ok());
        assert!(matches!(
            reserve_slot(&mut map, "a@b.c", now + RESEND_COOLDOWN / 2),
            Err(EmailError::TooManyRequests)
        ));
        assert!(reserve_slot(&mut map, "a@b.c", now + RESEND_COOLDOWN + Duration::from_secs(1)).is_ok());

        map.insert(
            "dead@b.c".into(),
            PendingCode {
                code: "123456".into(),
                sent_at: now - (CODE_TTL + Duration::from_secs(1)),
                attempts: 0,
            },
        );
        assert!(reserve_slot(&mut map, "live@b.c", now).is_ok());
        assert!(!map.contains_key("dead@b.c"), "an expired entry must be pruned");
    }

    /// The entry a reservation replaced comes back out, so a resend whose mail
    /// never goes out can restore it — an address must not lose a code it
    /// already holds because a later send failed.
    #[test]
    fn reserve_slot_hands_back_the_replaced_code() {
        let mut map: HashMap<String, PendingCode> = HashMap::new();
        let now = Instant::now();
        assert!(reserve_slot(&mut map, "a@b.c", now)
            .expect("first reservation")
            .is_none());
        map.insert(
            "a@b.c".into(),
            PendingCode { code: "111111".into(), sent_at: now, attempts: 0 },
        );
        let replaced = reserve_slot(
            &mut map,
            "a@b.c",
            now + RESEND_COOLDOWN + Duration::from_secs(1),
        )
        .expect("resend past the cooldown")
        .expect("the previous entry comes back");
        assert_eq!(replaced.code, "111111");
    }
}