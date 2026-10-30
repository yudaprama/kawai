//! Connector ops — third-party OAuth connections via Composio (direct mode,
//! baked API key from `kawai-vault`).
//!
//! Pure layer — no tauri/axum: BOTH transports (Tauri commands in
//! `commands.rs`, Axum routes in `web.rs`) call these same fns. Identity is
//! resolved at the transport edge and passed in as `user_id`. Composio scopes
//! its rows to the shared project key, not the caller — so `user_id` is the
//! ONLY ownership boundary here and every op enforces it (list filters on
//! it; poll/disconnect verify the row belongs to the caller before acting).
//! Ops stay auth-required regardless, so guests can never touch
//! third-party accounts.
//!
//! Wire shape = camelCase JSON (web request/response structs rely on
//! `rename_all = "camelCase"` in the wrappers; Tauri maps automatically).

use composio::ComposioClient;

fn client() -> Result<ComposioClient, String> {
    let api_key = kawai_constants::composio::get_composio_api_key();
    if api_key.trim().is_empty() {
        return Err("connector tidak dikonfigurasi (API key kosong)".to_string());
    }
    Ok(ComposioClient::new(api_key))
}

/// Resolve the baked auth config id for a toolkit slug ("gmail" →
/// `GMAIL_KAWAI`). Empty when kawai has no baked config for it — the connect
/// then falls back to Composio's toolkit default.
fn auth_config_for(toolkit: &str) -> Option<String> {
    let name = format!("{}_KAWAI", toolkit.to_uppercase().replace('-', "_"));
    let id = kawai_constants::composio::get_composio_auth_config(&name);
    (!id.trim().is_empty()).then_some(id)
}

/// Wire DTOs: defined once in `kawai_api_types` (the single source the TS
/// generator reads) and re-exported here under their original names.
pub use kawai_api_types::{
    ConnectorConnectStart as ConnectStart, ConnectorConnection as Connection,
};

/// List THIS user's connected third-party accounts, newest connection last.
/// Composio scopes rows to the shared project key, not the caller — without
/// the `user_id` filter every signed-in user saw every other user's
/// connections (the `connect()` sweep below already matches on the same
/// `user_id` field, so the field is the ownership boundary).
pub async fn list_connections(user_id: &str) -> Result<Vec<Connection>, String> {
    let client = client()?;
    let resp = client
        .list_connected_accounts()
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp
        .items
        .into_iter()
        .filter(|a| a.user_id.as_deref() == Some(user_id))
        .map(|a| Connection {
            id: a.id.clone(),
            app: a.toolkit_slug().to_string(),
            status: a.status,
            created_at: a.created_at,
        })
        .collect())
}

/// Start an OAuth connect for `toolkit` (slug, e.g. "gmail"). Returns the
/// redirect URL the user must visit plus the connection id to poll.
pub async fn connect(user_id: &str, toolkit: &str) -> Result<ConnectStart, String> {
    let client = client()?;
    let config = auth_config_for(toolkit)
        .ok_or_else(|| format!("tidak ada auth config baked untuk '{toolkit}'"))?;
    // Alias must be unique per Composio entity — a retried/abandoned connect
    // for the same toolkit would otherwise 400 ("Alias ... is already in use").
    // Nothing matches on alias (toolkit_slug does that), so it only has to be
    // recognizable for debugging.
    let alias = format!("{toolkit}-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default());
    // Sweep this user's abandoned connect attempts for the same toolkit
    // (INITIALIZING never completes on its own) — keeps the connections list
    // clean and cannot touch ACTIVE grants. Best-effort.
    if let Ok(accounts) = client.list_connected_accounts().await {
        for a in &accounts.items {
            if a.user_id.as_deref() == Some(user_id)
                && a.toolkit_slug().eq_ignore_ascii_case(toolkit)
                && a.status.eq_ignore_ascii_case("INITIALIZING")
            {
                let _ = client.delete_connected_account(&a.id).await;
            }
        }
    }
    let resp = client
        .create_link_session(&config, user_id, &alias)
        .await
        .map_err(|e| e.to_string())?;
    // `connected_account_id` is often still empty right after kickoff — resolve
    // it by picking the newest INITIALIZING account for this toolkit so the
    // frontend has a stable poll key.
    let connection_id = match resp.connected_account_id {
        Some(id) if !id.is_empty() => id,
        _ => {
            let accounts = client
                .list_connected_accounts()
                .await
                .map_err(|e| e.to_string())?;
            accounts
                .items
                .into_iter()
                .rev()
                .find(|a| {
                    a.user_id.as_deref() == Some(user_id)
                        && a.toolkit_slug().eq_ignore_ascii_case(toolkit)
                        && a.status.eq_ignore_ascii_case("INITIALIZING")
                })
                .map(|a| a.id)
                .unwrap_or_default()
        }
    };
    Ok(ConnectStart {
        connection_id,
        redirect_url: Some(resp.redirect_url),
    })
}

/// Poll one connection's status during the OAuth handshake. Ownership is
/// enforced: `connection_id` comes from the client — without the check any
/// signed-in user could read any other user's connection status.
pub async fn poll(user_id: &str, connection_id: &str) -> Result<Connection, String> {
    let client = client()?;
    let a = client
        .get_connected_account(connection_id)
        .await
        .map_err(|e| e.to_string())?;
    if a.user_id.as_deref() != Some(user_id) {
        return Err("koneksi bukan milik user ini".to_string());
    }
    Ok(Connection {
        id: a.id.clone(),
        app: a.toolkit_slug().to_string(),
        status: a.status,
        created_at: a.created_at,
    })
}

/// Disconnect (delete) a connected account. Ownership is enforced first —
/// ids are enumerable through the (now scoped) list, so an unchecked delete
/// let any signed-in user kill any other user's OAuth grant.
pub async fn disconnect(user_id: &str, connection_id: &str) -> Result<(), String> {
    let client = client()?;
    let a = client
        .get_connected_account(connection_id)
        .await
        .map_err(|e| e.to_string())?;
    if a.user_id.as_deref() != Some(user_id) {
        return Err("koneksi bukan milik user ini".to_string());
    }
    client
        .delete_connected_account(connection_id)
        .await
        .map_err(|e| e.to_string())
}
