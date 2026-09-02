//! Per-user Monad hot wallet — key lifecycle orchestration (pure, `monad`
//! feature).
//!
//! SECURITY MODEL:
//! - The private key is generated in-process (OS CSPRNG) and persisted ONLY
//!   to the OS keychain under `monad-wallet/<user_id>`. It is NEVER returned
//!   to the frontend and never written to disk.
//! - Signing happens here, inside the backend process; the frontend supplies
//!   only the plaintext message (e.g. the SIWE challenge) and receives the
//!   65-byte signature.
//! - Business logic lives in `kawai_monad::signer` (pure crypto); this module
//!   only orchestrates keychain storage around it. Both transport wrappers
//!   (Tauri command + Axum route) call these functions.
//!
//! Always compiled (stable surface for the always-registered commands); when
//! the `monad` feature is off, a guidance-error stub serves instead
//! (codegraph/tts pattern).

#[cfg(feature = "monad")]
pub use imp::*;

#[cfg(not(feature = "monad"))]
pub use stub::*;

#[cfg(feature = "monad")]
mod imp {
    use crate::keychain;

    /// Device-scoped keychain slot. A hot wallet exists BEFORE any Supabase
    /// identity (it is what creates the identity via SIWE), so it cannot be
    /// keyed by user_id.
    const WALLET_ACCOUNT: &str = "monad-wallet/device";

    /// The wallet's public identity. Safe to surface anywhere.
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WalletAddress {
        pub address: String,
    }

    /// Load the stored key's address, if the user has created a wallet.
    pub fn address() -> Result<Option<WalletAddress>, String> {
        let secret = keychain::load_for(&WALLET_ACCOUNT)?;
        match secret {
            None => Ok(None),
            Some(secret) => {
                let addr = kawai_monad::wallet_from_secret(decode_secret(&secret)?.as_slice())
                    .map_err(|e| format!("stored wallet key is corrupt: {e}"))?;
                Ok(Some(WalletAddress { address: addr }))
            }
        }
    }

    /// Create the user's hot wallet. Idempotent: returns the existing address
    /// if a wallet is already stored (a second key is never generated over one).
    pub fn create() -> Result<WalletAddress, String> {
        if let Some(existing) = address()? {
            return Ok(existing);
        }
        let wallet = kawai_monad::generate_wallet()?;
        keychain::store_for(&WALLET_ACCOUNT, &wallet.secret_hex)?;
        Ok(WalletAddress { address: wallet.address })
    }

    /// Sign a message (EIP-191 personal-sign) with the user's stored key.
    /// Returns the `0x` + 65-byte hex signature (SIWE-compatible).
    pub async fn sign_message(message: &str) -> Result<String, String> {
        let secret = keychain::load_for(&WALLET_ACCOUNT)?
            .ok_or_else(|| "no wallet for this user — create one first".to_string())?;
        kawai_monad::sign_message(decode_secret(&secret)?.as_slice(), message).await
    }

    /// Permanently delete the stored key. The address (and any funds) becomes
    /// unrecoverable from this device unless the key was exported elsewhere.
    pub fn delete() -> Result<(), String> {
        keychain::clear_for(&WALLET_ACCOUNT)
    }

    fn decode_secret(hex: &str) -> Result<Vec<u8>, String> {
        if hex.len() != 64 {
            return Err(format!("stored key has wrong length: {}", hex.len()));
        }
        (0..64)
            .step_by(2)
            .map(|i| {
                u8::from_str_radix(&hex[i..i + 2], 16)
                    .map_err(|e| format!("stored key is not hex: {e}"))
            })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn decode_roundtrip_and_errors() {
            let hex = "4646464646464646464646464646464646464646464646464646464646464646";
            let bytes = decode_secret(hex).unwrap();
            assert_eq!(bytes.len(), 32);
            assert!(decode_secret("zz").is_err());
            assert!(decode_secret("4646").is_err());
        }
    }
}

#[cfg(not(feature = "monad"))]
mod stub {
    use serde::Serialize;

    /// Response shape mirror (fields identical to the real `WalletAddress`).
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WalletAddress {
        pub address: String,
    }

    const MSG: &str = "Monad support is not enabled in this build (missing 'monad' feature).";

    pub fn address() -> Result<Option<WalletAddress>, String> {
        Err(MSG.into())
    }
    pub fn create() -> Result<WalletAddress, String> {
        Err(MSG.into())
    }
    pub async fn sign_message(_message: &str) -> Result<String, String> {
        Err(MSG.into())
    }
    pub fn delete() -> Result<(), String> {
        Err(MSG.into())
    }
}
