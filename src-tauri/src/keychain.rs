//! OS-native storage for device-scoped secrets (e.g. the Monad hot-wallet
//! key). The session itself is in-memory only — nothing session-related
//! persists here.

const SERVICE: &str = "pro.kawai.app";

/// Entry under the service with a caller-chosen account key.
fn entry_for(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| format!("keychain unavailable: {e}"))
}

pub fn store_for(account: &str, value: &str) -> Result<(), String> {
    entry_for(account)?.set_password(value).map_err(|e| format!("keychain write failed: {e}"))
}

pub fn load_for(account: &str) -> Result<Option<String>, String> {
    match entry_for(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

pub fn clear_for(account: &str) -> Result<(), String> {
    match entry_for(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

