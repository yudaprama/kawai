//! Compatibility shim — implementation lives in `crates/integrations/monad`
//! (kawai-monad crate, feature "monad").
//!
//! Re-exported so `crate::logic::monad::*` is the stable call surface for
//! both transport wrappers (Tauri command in `commands.rs`, Axum route in
//! `web.rs`). Like codegraph/tts, the module is ALWAYS compiled so the
//! commands stay registered in `generate_handler!` / `router()`; without the
//! feature, the functions return a guidance error and the response types
//! exist as inert serde placeholders. Pure — no transport types here.

#[cfg(feature = "monad")]
pub use kawai_monad::*;

/// Guidance-error stubs mirroring the real surface so both builds type-check.
#[cfg(not(feature = "monad"))]
pub use stub::*;

#[cfg(not(feature = "monad"))]
mod stub {
    use serde::{Deserialize, Serialize};

    /// Response shape mirror (fields identical to the real `BalanceInfo`).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BalanceInfo {
        pub address: String,
        pub balance_wei: String,
        pub balance_mon: String,
        pub rpc_url: String,
    }

    /// Response shape mirror (fields identical to the real `ChainStatus`).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ChainStatus {
        pub rpc_url: String,
        pub block_number: u64,
        pub chain_id: u64,
    }

    /// Response shape mirror (fields identical to the real `TokenBalance`).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TokenBalance {
        pub token: String,
        pub wallet: String,
        pub raw: String,
        pub formatted: String,
        pub decimals: u8,
        pub rpc_url: String,
    }

    /// Response shape mirror (fields identical to the real `TokenInfo`).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TokenInfo {
        pub address: String,
        pub symbol: String,
        pub decimals: u8,
        pub rpc_url: String,
    }

    /// Response shape mirror (fields identical to the real `GasEstimate`).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct GasEstimate {
        pub gas_price_gwei: String,
        pub is_dynamic_fee: bool,
        pub rpc_url: String,
    }

    const MSG: &str = "Monad support is not enabled in this build (missing 'monad' feature).";

    pub async fn check_balance(
        _url: Option<&str>,
        _wallet_address: &str,
    ) -> Result<BalanceInfo, String> {
        Err(MSG.into())
    }

    pub async fn chain_status(_url: Option<&str>) -> Result<ChainStatus, String> {
        Err(MSG.into())
    }

    pub async fn erc20_balance(
        _url: Option<&str>,
        _token: &str,
        _wallet: &str,
    ) -> Result<TokenBalance, String> {
        Err(MSG.into())
    }

    pub async fn erc20_info(_url: Option<&str>, _token: &str) -> Result<TokenInfo, String> {
        Err(MSG.into())
    }

    pub async fn gas_estimate(_url: Option<&str>) -> Result<GasEstimate, String> {
        Err(MSG.into())
    }
}
