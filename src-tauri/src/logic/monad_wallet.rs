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

/// Errors that can occur during Monad wallet operations. Shared by both the
/// real implementation and the guidance stub so caller signatures are stable
/// across feature combinations.
#[derive(Debug, thiserror::Error)]
pub enum MonadWalletError {
    #[error("no wallet for this device — create one first")]
    NoWallet,
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("stored wallet key is corrupt: {0}")]
    CorruptKey(String),
    #[error("crypto operation failed: {0}")]
    Crypto(String),
    #[error("invalid amount: {0}")]
    InvalidAmount(String),
    #[error("monad chain error: {0}")]
    Chain(String),
    #[error("wallet history unreadable: {0}")]
    HistoryUnreadable(String),
    #[error("wallet history corrupt: {0}")]
    HistoryCorrupt(String),
    #[error("Monad support is not enabled in this build (missing 'monad' feature)")]
    Unsupported,
}

#[cfg(feature = "monad")]
pub use imp::*;

#[cfg(not(feature = "monad"))]
pub use stub::*;

#[cfg(feature = "monad")]
mod imp {
    use super::MonadWalletError;
    use crate::keychain;

    pub use kawai_monad::{ReceiptInfo, TxResult};

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
    pub fn address() -> Result<Option<WalletAddress>, MonadWalletError> {
        let secret = keychain::load_for(&WALLET_ACCOUNT)
            .map_err(|e| MonadWalletError::Keychain(e.to_string()))?;
        match secret {
            None => Ok(None),
            Some(secret) => {
                let addr = kawai_monad::wallet_from_secret(decode_secret(&secret)?.as_slice())
                    .map_err(|e| MonadWalletError::CorruptKey(format!("stored wallet key is corrupt: {e}")))?;
                Ok(Some(WalletAddress { address: addr }))
            }
        }
    }

    /// Create the user's hot wallet. Idempotent: returns the existing address
    /// if a wallet is already stored (a second key is never generated over one).
    pub fn create() -> Result<WalletAddress, MonadWalletError> {
        if let Some(existing) = address()? {
            return Ok(existing);
        }
        let wallet =
            kawai_monad::generate_wallet().map_err(|e| MonadWalletError::Crypto(e.to_string()))?;
        keychain::store_for(&WALLET_ACCOUNT, &wallet.secret_hex)
            .map_err(|e| MonadWalletError::Keychain(e.to_string()))?;
        Ok(WalletAddress { address: wallet.address })
    }

    /// Sign a message (EIP-191 personal-sign) with the user's stored key.
    /// Returns the `0x` + 65-byte hex signature (SIWE-compatible).
    pub async fn sign_message(message: &str) -> Result<String, MonadWalletError> {
        let secret = keychain::load_for(&WALLET_ACCOUNT)
            .map_err(|e| MonadWalletError::Keychain(e.to_string()))?
            .ok_or(MonadWalletError::NoWallet)?;
        kawai_monad::sign_message(decode_secret(&secret)?.as_slice(), message)
            .await
            .map_err(|e| MonadWalletError::Crypto(e.to_string()))
    }

    /// Permanently delete the stored key. The address (and any funds) becomes
    /// unrecoverable from this device unless the key was exported elsewhere.
    pub fn delete() -> Result<(), MonadWalletError> {
        keychain::clear_for(&WALLET_ACCOUNT).map_err(|e| MonadWalletError::Keychain(e.to_string()))
    }

    /// Load the stored secret bytes (error if no wallet exists).
    fn load_secret() -> Result<Vec<u8>, MonadWalletError> {
        let secret = keychain::load_for(&WALLET_ACCOUNT)
            .map_err(|e| MonadWalletError::Keychain(e.to_string()))?
            .ok_or(MonadWalletError::NoWallet)?;
        decode_secret(&secret)
    }

    /// Sign + broadcast a native MON transfer from the device hot wallet.
    /// `amount` is a decimal string (e.g. "1.5") — parsed in integer math
    /// inside the crate, never as float.
    pub async fn transfer_native(to: &str, amount: &str) -> Result<kawai_monad::TxResult, MonadWalletError> {
        let raw = kawai_monad::parse_units(amount, 18).map_err(MonadWalletError::InvalidAmount)?;
        let secret = load_secret()?;
        let tx = kawai_monad::transfer(Some(crate::logic::monad_contracts::rpc()), &secret, to, None, raw)
            .await
            .map_err(MonadWalletError::Chain)?;
        record_tx("send", "MON", to, amount, None, &tx.tx_hash);
        Ok(tx)
    }

    /// Sign + broadcast an ERC-20 `transfer(to, amount)` from the device
    /// hot wallet. `amount` is a decimal string; `decimals` from the token.
    pub async fn transfer_token(
        token: &str,
        to: &str,
        amount: &str,
        decimals: u8,
    ) -> Result<kawai_monad::TxResult, MonadWalletError> {
        let raw = kawai_monad::parse_units(amount, decimals).map_err(MonadWalletError::InvalidAmount)?;
        let secret = load_secret()?;
        let tx = kawai_monad::transfer(Some(crate::logic::monad_contracts::rpc()), &secret, to, Some(token), raw)
            .await
            .map_err(MonadWalletError::Chain)?;
        record_tx("send", token_symbol(token), to, amount, Some(token), &tx.tx_hash);
        Ok(tx)
    }

    /// Stablecoin transfer (active-network address, 6 decimals; testnet USDT
    /// / mainnet USDC — the record symbol is resolved by `transfer_token`).
    pub async fn transfer_usdt(to: &str, amount: &str) -> Result<kawai_monad::TxResult, MonadWalletError> {
        transfer_token(crate::logic::monad_contracts::stablecoin(), to, amount, 6).await
    }

    /// Deposit USDT into the payment vault (approve + `deposit(uint256)`).
    pub async fn deposit_to_vault(amount: &str) -> Result<kawai_monad::TxResult, MonadWalletError> {
        let raw = kawai_monad::parse_units(amount, 6).map_err(MonadWalletError::InvalidAmount)?;
        let secret = load_secret()?;
        let tx = kawai_monad::vault_deposit(
            Some(crate::logic::monad_contracts::rpc()),
            &secret,
            crate::logic::monad_contracts::vault(),
            crate::logic::monad_contracts::stablecoin(),
            raw,
        )
        .await
        .map_err(MonadWalletError::Chain)?;
        record_tx(
            "deposit",
            crate::logic::monad_contracts::stablecoin_symbol(),
            crate::logic::monad_contracts::vault(),
            amount,
            Some(crate::logic::monad_contracts::stablecoin()),
            &tx.tx_hash,
        );
        Ok(tx)
    }

    /// Receipt probe for a previously-broadcast tx (`Ok(None)` = pending).
    pub async fn transaction_receipt(tx_hash: &str) -> Result<Option<kawai_monad::ReceiptInfo>, MonadWalletError> {
        kawai_monad::transaction_receipt(Some(crate::logic::monad_contracts::rpc()), tx_hash)
            .await
            .map_err(MonadWalletError::Chain)
    }

    // ── Device tx history — local JSON log of fund-moving ops ───────────
    // The wallet's "Recent Activity" list. On-chain truth stays the explorer;
    // this is a device-local audit trail written best-effort AFTER a
    // successful broadcast (a failed record never fails the transfer).

    /// One history record. `kind`: "send" | "deposit". Newest first on disk.
    #[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TxRecord {
        pub tx_hash: String,
        pub kind: String,
        /// Display symbol for the active network ("MON"/"USDT"/"KAWAI"/"Token").
        pub symbol: String,
        pub to: String,
        /// Decimal string exactly as the user entered it.
        pub amount: String,
        /// ERC-20 contract for token ops; `None` = native MON.
        pub token: Option<String>,
        pub created_at_ms: i64,
    }

    const HISTORY_FILE: &str = "wallet_history.json";
    /// Newest-first cap — the UI shows the recent tail, not an archive.
    const HISTORY_CAP: usize = 200;
    static HISTORY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn history_path() -> std::path::PathBuf {
        kawai_paths::data_root().join(HISTORY_FILE)
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// Display symbol for an ERC-20 address on the active network.
    fn token_symbol(token: &str) -> &'static str {
        if token.eq_ignore_ascii_case(crate::logic::monad_contracts::stablecoin()) {
            crate::logic::monad_contracts::stablecoin_symbol()
        } else if token.eq_ignore_ascii_case(crate::logic::monad_contracts::kawai_token()) {
            "KAWAI"
        } else {
            "Token"
        }
    }

    /// Append a record (best-effort — never fails an already-broadcast tx).
    fn record_tx(kind: &str, symbol: &str, to: &str, amount: &str, token: Option<&str>, tx_hash: &str) {
        let _guard = match HISTORY_LOCK.lock() {
            Ok(g) => g,
            Err(_) => return, // lock poisoned by an earlier panic — skip, don't take the app down
        };
        let path = history_path();
        let mut records: Vec<TxRecord> = match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str(&s) {
                Ok(r) => r,
                Err(e) => {
                    // Preserve the unreadable file as evidence, then start fresh.
                    eprintln!("[monad_wallet] history corrupt ({e}) — preserved as .corrupt");
                    let _ = std::fs::rename(&path, path.with_extension("json.corrupt"));
                    Vec::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                // Unreadable ≠ corrupt — never overwrite a file we merely can't read.
                eprintln!("[monad_wallet] history read failed ({e}) — record skipped");
                return;
            }
        };
        records.insert(
            0,
            TxRecord {
                tx_hash: tx_hash.to_string(),
                kind: kind.to_string(),
                symbol: symbol.to_string(),
                to: to.to_string(),
                amount: amount.to_string(),
                token: token.map(str::to_string),
                created_at_ms: now_ms(),
            },
        );
        records.truncate(HISTORY_CAP);
        let json = match serde_json::to_string_pretty(&records) {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[monad_wallet] history serialize failed ({e})");
                return;
            }
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Write-to-temp then rename = atomic; a crash mid-write can't corrupt it.
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, &json).and_then(|_| std::fs::rename(&tmp, &path)) {
            eprintln!("[monad_wallet] history write failed ({e})");
        }
    }

    /// Read the device tx history (newest first). Missing file = empty.
    pub fn history() -> Result<Vec<TxRecord>, MonadWalletError> {
        let path = history_path();
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(MonadWalletError::HistoryUnreadable(e.to_string())),
        };
        serde_json::from_str(&raw).map_err(|e| MonadWalletError::HistoryCorrupt(e.to_string()))
    }

    fn decode_secret(hex: &str) -> Result<Vec<u8>, MonadWalletError> {
        if hex.len() != 64 {
            return Err(MonadWalletError::CorruptKey(format!(
                "stored key has wrong length: {}",
                hex.len()
            )));
        }
        (0..64)
            .step_by(2)
            .map(|i| {
                u8::from_str_radix(&hex[i..i + 2], 16)
                    .map_err(|e| MonadWalletError::CorruptKey(format!("stored key is not hex: {e}")))
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
    use super::MonadWalletError;
    use serde::Serialize;

    /// Response shape mirror (fields identical to the real `WalletAddress`).
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WalletAddress {
        pub address: String,
    }

    pub fn address() -> Result<Option<WalletAddress>, MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }
    pub fn create() -> Result<WalletAddress, MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }
    pub async fn sign_message(_message: &str) -> Result<String, MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }
    pub fn delete() -> Result<(), MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }

    /// Response shape mirror (fields identical to the real `TxResult`).
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TxResult {
        pub tx_hash: String,
        pub from: String,
        pub to: String,
        pub amount: String,
        pub nonce: u64,
    }

    /// Response shape mirror (fields identical to the real `ReceiptInfo`).
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ReceiptInfo {
        pub tx_hash: String,
        pub success: bool,
        pub block_number: u64,
    }

    pub async fn transfer_native(_to: &str, _amount: &str) -> Result<TxResult, MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }
    pub async fn transfer_token(
        _token: &str,
        _to: &str,
        _amount: &str,
        _decimals: u8,
    ) -> Result<TxResult, MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }
    pub async fn transfer_usdt(_to: &str, _amount: &str) -> Result<TxResult, MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }
    pub async fn deposit_to_vault(_amount: &str) -> Result<TxResult, MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }
    pub async fn transaction_receipt(_tx_hash: &str) -> Result<Option<ReceiptInfo>, MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }

    /// Response shape mirror (fields identical to the real `TxRecord`).
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TxRecord {
        pub tx_hash: String,
        pub kind: String,
        pub symbol: String,
        pub to: String,
        pub amount: String,
        pub token: Option<String>,
        pub created_at_ms: i64,
    }

    pub fn history() -> Result<Vec<TxRecord>, MonadWalletError> {
        Err(MonadWalletError::Unsupported)
    }
}
