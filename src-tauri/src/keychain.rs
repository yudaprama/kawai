//! OS-native storage for device-scoped secrets (e.g. the Monad hot-wallet
//! key). The session itself is in-memory only — nothing session-related
//! persists here.

const SERVICE: &str = "pro.kawai.app";

/// Errors that can occur during keychain operations.
#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("Keychain unavailable: {0}")]
    Unavailable(String),
    #[error("Write failed: {0}")]
    WriteFailed(String),
    #[error("Read failed: {0}")]
    ReadFailed(String),
    #[error("Delete failed: {0}")]
    DeleteFailed(String),
}

/// Entry under the service with a caller-chosen account key.
fn entry_for(account: &str) -> Result<keyring::Entry, KeychainError> {
    keyring::Entry::new(SERVICE, account).map_err(|e| KeychainError::Unavailable(e.to_string()))
}

pub fn store_for(account: &str, value: &str) -> Result<(), KeychainError> {
    entry_for(account)?.set_password(value).map_err(|e| KeychainError::WriteFailed(e.to_string()))
}

pub fn load_for(account: &str) -> Result<Option<String>, KeychainError> {
    match entry_for(account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(KeychainError::ReadFailed(e.to_string())),
    }
}

pub fn clear_for(account: &str) -> Result<(), KeychainError> {
    match entry_for(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(KeychainError::DeleteFailed(e.to_string())),
    }
}