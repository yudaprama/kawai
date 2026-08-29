//! OS-native storage for the authenticated session token.
//!
//! The token is deliberately not stored in libSQL: the OS credential store
//! provides the platform protection and does not require a second wrapping key.

const SERVICE: &str = "pro.kawai.app";
const ACCOUNT: &str = "session-token";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain unavailable: {e}"))
}

pub fn store(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| format!("keychain write failed: {e}"))
}

pub fn load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}
