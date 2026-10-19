// logic/mexc_credentials — per-user MEXC API key management ops.
//
// Feature `mexc`: thin dispatch into the `mexc` toolset crate's
// `credentials` module (storage in the user's local DB, per-user signed client
// invalidation). Without the feature: honest stubs — the ops exist so both
// wrappers stay stable, and the error says what to build with.
// Pure logic: no tauri/axum imports.
//
// MEXC has NO product-baked key pair, so `source` is only ever "user" or
// "none" — a "baked" state here would mean signing with the product's own
// account, which is exactly the mirror-the-customer's-portfolio mistake the
// Binance resolver refuses.

/// What the Settings card renders. The secret NEVER crosses this boundary —
/// only the source and a masked key preview.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MexcCredentialStatus {
    /// "user" (own keys) | "none".
    pub source: String,
    pub key_preview: Option<String>,
}

#[cfg(feature = "mexc")]
pub async fn mexc_credentials_set(
    user_id: &str,
    api_key: &str,
    api_secret: &str,
) -> Result<(), String> {
    ::mexc::credentials::op_set(user_id, api_key, api_secret)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(feature = "mexc")]
pub async fn mexc_credentials_status(user_id: &str) -> MexcCredentialStatus {
    let s = ::mexc::credentials::op_status(user_id).await;
    MexcCredentialStatus {
        source: s.source.to_string(),
        key_preview: s.key_preview,
    }
}

#[cfg(feature = "mexc")]
pub async fn mexc_credentials_delete(user_id: &str) -> Result<(), String> {
    ::mexc::credentials::op_delete(user_id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "mexc"))]
pub async fn mexc_credentials_set(
    _user_id: &str,
    _api_key: &str,
    _api_secret: &str,
) -> Result<(), String> {
    Err("mexc feature not enabled (build with --features mexc)".into())
}

#[cfg(not(feature = "mexc"))]
pub async fn mexc_credentials_status(_user_id: &str) -> MexcCredentialStatus {
    MexcCredentialStatus {
        source: "none".into(),
        key_preview: None,
    }
}

#[cfg(not(feature = "mexc"))]
pub async fn mexc_credentials_delete(_user_id: &str) -> Result<(), String> {
    Err("mexc feature not enabled (build with --features mexc)".into())
}

#[cfg(all(test, feature = "mexc"))]
mod tests {
    use super::*;

    /// The data root is process-global, so the tests that set it are
    /// serialized.
    static DATA_ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn temp_data_root(tag: &str) -> (std::sync::MutexGuard<'static, ()>, std::path::PathBuf) {
        let guard = DATA_ROOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "kawai_mexc_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        kawai_db::set_data_root(dir.clone());
        (guard, dir)
    }

    /// The Settings card renders on boot, so a status op that ERRORS leaves it
    /// in an unknown state. With no keys stored the honest answer is "none".
    #[tokio::test]
    async fn status_without_keys_is_none_not_an_error() {
        let (_guard, _dir) = temp_data_root("creds");
        let status = mexc_credentials_status("mexc-creds@example.com").await;
        assert_eq!(status.source, "none");
        assert!(status.key_preview.is_none());
    }

    /// A stored key reads back masked — the secret never crosses this boundary.
    #[tokio::test]
    async fn a_stored_key_reports_its_source_and_a_masked_preview() {
        let (_guard, _dir) = temp_data_root("creds_set");
        let user = "mexc-creds-set@example.com";
        assert_eq!(mexc_credentials_status(user).await.source, "none");
        mexc_credentials_set(user, "MEXCKEY1234567890AB", "secret-value")
            .await
            .unwrap();
        let status = mexc_credentials_status(user).await;
        assert_eq!(status.source, "user");
        let preview = status.key_preview.expect("a stored key previews");
        assert!(preview.contains("…"), "{preview}");
        assert!(!preview.contains("secret-value"), "{preview}");
        mexc_credentials_delete(user).await.unwrap();
        assert_eq!(mexc_credentials_status(user).await.source, "none");
    }
}