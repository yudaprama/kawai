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
