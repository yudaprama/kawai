// logic/binance_credentials — per-user Binance API key management ops.
//
// Feature `binance`: thin dispatch into the `binance` toolset crate's
// `credentials` module (storage in the user's local DB, per-user signed
// client invalidation). Without the feature: honest stubs — the ops exist so
// both wrappers stay stable, and the error says what to build with.
// Pure logic: no tauri/axum imports.

/// What the Settings card renders. The secret NEVER crosses this boundary —
/// only the source and a masked key preview.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinanceCredentialStatus {
    /// "user" (own keys) | "baked" (product pair) | "none".
    pub source: String,
    pub key_preview: Option<String>,
}

#[cfg(feature = "binance")]
pub async fn binance_credentials_set(
    user_id: &str,
    api_key: &str,
    api_secret: &str,
) -> Result<(), String> {
    ::binance::credentials::op_set(user_id, api_key, api_secret)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(feature = "binance")]
pub async fn binance_credentials_status(
    user_id: &str,
) -> Result<BinanceCredentialStatus, String> {
    let s = ::binance::credentials::op_status(user_id).await;
    Ok(BinanceCredentialStatus {
        source: s.source.to_string(),
        key_preview: s.key_preview,
    })
}

#[cfg(feature = "binance")]
pub async fn binance_credentials_delete(user_id: &str) -> Result<(), String> {
    ::binance::credentials::op_delete(user_id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "binance"))]
pub async fn binance_credentials_set(
    _user_id: &str,
    _api_key: &str,
    _api_secret: &str,
) -> Result<(), String> {
    Err("binance feature not enabled (build with --features binance)".into())
}

#[cfg(not(feature = "binance"))]
pub async fn binance_credentials_status(
    _user_id: &str,
) -> Result<BinanceCredentialStatus, String> {
    Ok(BinanceCredentialStatus {
        source: "none".into(),
        key_preview: None,
    })
}

#[cfg(not(feature = "binance"))]
pub async fn binance_credentials_delete(_user_id: &str) -> Result<(), String> {
    Err("binance feature not enabled (build with --features binance)".into())
}

// ── Futures trading consent (Settings → Binance API) ───────────────────────
// The single switch that unlocks the WRITING futures tools (place SL/TP,
// cancel protective order). Everything else in the Binance toolset stays
// read-only. Consent is bound to the CURRENT key pair: rotating the keys
// flips it back to disabled (the next enable re-asks).

/// What the Settings trading card renders.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinanceTradingStatus {
    /// The user stored their own key pair at all.
    pub has_own_keys: bool,
    /// Trading consented for the CURRENT pair (rotation voids this).
    pub consented: bool,
}

#[cfg(feature = "binance")]
pub async fn binance_trading_status(
    user_id: &str,
) -> Result<BinanceTradingStatus, String> {
    let s = ::binance::credentials::op_trading_status(user_id).await;
    Ok(BinanceTradingStatus {
        has_own_keys: s.has_own_keys,
        consented: s.consented,
    })
}

#[cfg(feature = "binance")]
pub async fn binance_trading_enable(user_id: &str) -> Result<(), String> {
    ::binance::credentials::op_trading_enable(user_id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(feature = "binance")]
pub async fn binance_trading_disable(user_id: &str) -> Result<(), String> {
    ::binance::credentials::op_trading_disable(user_id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "binance"))]
pub async fn binance_trading_status(_user_id: &str) -> Result<BinanceTradingStatus, String> {
    Ok(BinanceTradingStatus {
        has_own_keys: false,
        consented: false,
    })
}

#[cfg(not(feature = "binance"))]
pub async fn binance_trading_enable(_user_id: &str) -> Result<(), String> {
    Err("binance feature not enabled (build with --features binance)".into())
}

#[cfg(not(feature = "binance"))]
pub async fn binance_trading_disable(_user_id: &str) -> Result<(), String> {
    Err("binance feature not enabled (build with --features binance)".into())
}
