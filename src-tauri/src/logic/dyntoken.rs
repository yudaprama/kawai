//! Dyntoken shim — seal/verify server-defined key-tokens for the signed-in
//! user, using the `(vault_key, vault_secret)` pair the worker returns at
//! sign-in (persisted by `local_auth::persist_vault_keys`).
//!
//! Semantics (kawai-dyntoken): a token is valid ⟔ decode reproduces exactly
//! the server-defined `vault_key` AND `|now − embedded_ts| ≤ 5 s`
//! (`MAX_SKEW_SECS`). The token is deterministic — the same
//! `(secret, key, timestamp)` always seals to the same string, so both sides
//! can regenerate it without storage.
//!
//! Pure helpers (no tauri/axum types) — wrappers for the real consumer op are
//! added when a feature actually ships this.

use crate::logic::local_auth::stored_vault_keys;

/// Seal a dyntoken for `user_email` at unix `timestamp`: encodes the
/// server-defined key with the server-defined secret. Errors when the user
/// has no stored pair (never signed in on this device, or signed in against
/// a worker predating `DYNTOKEN_SECRET`).
pub fn seal_for_user(user_email: &str, timestamp: u64) -> Result<String, String> {
    let (key, secret) = stored_vault_keys(user_email)
        .ok_or_else(|| "no vault key/secret stored — sign in first".to_string())?;
    kawai_dyntoken::seal_key(secret.as_bytes(), key.as_bytes(), timestamp)
        .map_err(|e| format!("seal failed: {e}"))
}

/// Verify a dyntoken for `user_email` against the stored server-defined key:
/// integrity + `|now − ts| ≤ 5 s` + constant-time key match.
/// `Ok(true)` = valid, `Ok(false)` = well-formed but the decoded key differs,
/// `Err(_)` = tampered / wrong secret / stale timestamp / no stored pair.
pub fn verify_for_user(user_email: &str, token: &str, now_secs: u64) -> Result<bool, String> {
    let (key, secret) = stored_vault_keys(user_email)
        .ok_or_else(|| "no vault key/secret stored — sign in first".to_string())?;
    kawai_dyntoken::verify_key(secret.as_bytes(), token, key.as_bytes(), now_secs)
        .map_err(|e| format!("verify failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kawai_paths::set_data_root;

    fn test_user(tag: &str) -> String {
        let root = std::env::temp_dir().join(format!(
            "kawai-dyntoken-test-{}",
            std::process::id()
        ));
        set_data_root(root);
        format!("dyntoken-test-{tag}@example.com")
    }

    fn write_pair(email: &str, key: &str, secret: &str) {
        let dir = kawai_paths::user_data_dir(email);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(kawai_paths::vault_keys(email), format!("{key}\n{secret}\n")).unwrap();
    }

    #[test]
    fn seal_verify_roundtrip_with_stored_pair() {
        let email = test_user("roundtrip");
        let key = format!("{:064}", 0xAAAA);
        let secret = format!("{:064}", 0xBBBB);
        write_pair(&email, &key, &secret);
        let ts = 1_800_000_000;

        let tok = seal_for_user(&email, ts).unwrap();
        assert!(verify_for_user(&email, &tok, ts).unwrap());
        assert!(verify_for_user(&email, &tok, ts + kawai_dyntoken::MAX_SKEW_SECS).unwrap());
        // 6 s late → rejected
        assert!(verify_for_user(&email, &tok, ts + kawai_dyntoken::MAX_SKEW_SECS + 1).is_err());
    }

    #[test]
    fn mismatched_key_fails_verification() {
        let email = test_user("mismatch");
        write_pair(&email, &format!("{:064}", 0xAAAA), &format!("{:064}", 0xBBBB));
        let ts = 1_800_000_000;
        let tok = seal_for_user(&email, ts).unwrap();
        // A different stored key → decoded key no longer matches → Ok(false).
        let other = format!("other-{}", &"0".repeat(58));
        write_pair(&email, &other, &format!("{:064}", 0xBBBB));
        assert_eq!(verify_for_user(&email, &tok, ts).unwrap(), false);
    }

    #[test]
    fn seal_without_pair_errors() {
        let email = test_user("nopair");
    }
}
