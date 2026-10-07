//! Dyntoken shim — app-level gate for the LLM gateway. One global
//! `(key, secret)` pair, defined by kawai-server (`DYNTOKEN_SECRET`
//! derivation, no user involved) and fetched once from
//! `GET /dyntoken/keys`, cached at `<data_root>/vault.keys`.
//!
//! Semantics (kawai-dyntoken): a token is valid ⟔ decode reproduces exactly
//! the defined `key` AND `|now − embedded_ts| ≤ 5 s` (`MAX_SKEW_SECS`). The
//! token is deterministic — the same `(secret, key, timestamp)` always seals
//! to the same string.
//!
//! Pure helpers (no tauri/axum types) — wrappers for the real consumer op
//! are added when the LLM gateway feature actually ships.

use kawai_dyntoken::Error as DyntokenError;

/// Fetch-and-cache the app-level `(key, secret)` from the worker. Missing
/// local file → fetch → persist (0600). Returns `(key, secret)` hex strings.
async fn ensure_keys() -> Result<(String, String), String> {
    if let Some(pair) = stored_keys() {
        return Ok(pair);
    }
    let url = format!("{}/dyntoken/keys", crate::logic::local_auth::worker_base_url());
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|_| "auth server unreachable".to_string())?;
    if resp.status().as_u16() != 200 {
        return Err(format!("dyntoken/keys → HTTP {}", resp.status().as_u16()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;
    let key = json["vault_key"]
        .as_str()
        .ok_or("malformed dyntoken/keys response")?
        .to_string();
    let secret = json["vault_secret"]
        .as_str()
        .ok_or("malformed dyntoken/keys response")?
        .to_string();
    let path = kawai_paths::vault_keys();
    if let Err(e) = kawai_paths::write_private_file(&path, &format!("{key}\n{secret}\n")) {
        eprintln!("[dyntoken] failed to cache keys {}: {e}", path.display());
    }
    Ok((key, secret))
}

/// Read the cached app-level `(key, secret)` pair, if present.
fn stored_keys() -> Option<(String, String)> {
    let raw = std::fs::read_to_string(kawai_paths::vault_keys()).ok()?;
    let mut lines = raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty());
    let key = lines.next()?;
    let secret = lines.next()?;
    Some((key, secret))
}

/// Seal a dyntoken for the LLM gateway at unix `timestamp` (usually "now").
pub async fn seal(timestamp: u64) -> Result<String, String> {
    let (key, secret) = ensure_keys().await?;
    kawai_dyntoken::seal_key(secret.as_bytes(), key.as_bytes(), timestamp)
        .map_err(|e| format!("seal failed: {e}"))
}

/// Verify a dyntoken from the LLM gateway side: integrity +
/// `|now − ts| ≤ 5 s` + constant-time key match against the stored pair.
/// `Ok(true)` = valid, `Ok(false)` = well-formed but the key differs,
/// `Err(_)` = tampered / stale / no cached pair.
pub async fn verify(token: &str, now_secs: u64) -> Result<bool, String> {
    let (key, secret) = ensure_keys().await?;
    kawai_dyntoken::verify_key(secret.as_bytes(), token, key.as_bytes(), now_secs)
        .map_err(|e: DyntokenError| format!("verify failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kawai_paths::set_data_root;
    use std::sync::{Mutex, MutexGuard};

    /// `vault.keys` resolves through `kawai_paths`, whose data root is a
    /// process-global `OnceLock` — the first `set_data_root` in the test
    /// binary wins and every later call is a no-op (same contract as
    /// `logic.rs`). So these tests cannot pick their own roots: they share
    /// one `vault.keys` and must not run concurrently. The lock is what
    /// makes the "missing" assertion safe — without it the roundtrip test's
    /// write landed between the delete and the assert.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> MutexGuard<'static, ()> {
        // A poisoned lock only means some other test panicked; the state it
        // guards (one file on disk) is reset by each test that takes it.
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn test_root() {
        let root = std::env::temp_dir().join(format!(
            "kawai-dyntoken-test-{}",
            std::process::id()
        ));
        set_data_root(root);
    }

    fn write_pair(key: &str, secret: &str) {
        let path = kawai_paths::vault_keys();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("{key}\n{secret}\n")).unwrap();
    }

    #[test]
    fn stored_keys_roundtrip() {
        let _guard = serial();
        test_root();
        write_pair(&format!("{:064}", 0xAAAA), &format!("{:064}", 0xBBBB));
        let (key, secret) = stored_keys().unwrap();
        assert_eq!(key, format!("{:064}", 0xAAAA));
        assert_eq!(secret, format!("{:064}", 0xBBBB));
    }

    #[test]
    fn stored_keys_missing_returns_none() {
        let _guard = serial();
        test_root();
        let path = kawai_paths::vault_keys();
        if path.exists() {
            std::fs::remove_file(&path).unwrap();
        }
        assert!(stored_keys().is_none());
    }
}
