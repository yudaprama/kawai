//! Connector ops — third-party OAuth connections via Composio (direct mode,
//! baked API key from `kawai-vault`).
//!
//! Pure layer — no tauri/axum: BOTH transports (Tauri commands in
//! `commands.rs`, Axum routes in `web.rs`) call these same fns. Identity is
//! resolved at the transport edge and passed in as `user_id` (unused here —
//! Composio connections are project-scoped under kawai's baked key on a
//! personal, single-user device), but the ops are auth-required so guests can
//! never touch third-party accounts.
//!
//! Wire shape = camelCase JSON (web request/response structs rely on
//! `rename_all = "camelCase"` in the wrappers; Tauri maps automatically).

use serde::Serialize;

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

/// One connected third-party account, camelCase on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub app: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// The connect kickoff result: open `redirect_url` in a browser, then poll
/// `connector_poll` until `status == "ACTIVE"`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectStart {
    pub connection_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect_url: Option<String>,
}

/// List every connected third-party account, newest connection last.
pub async fn list_connections(_user_id: &str) -> Result<Vec<Connection>, String> {
    let client = client()?;
    let resp = client
        .list_connected_accounts()
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp
        .items
        .into_iter()
        .map(|a| Connection {
            id: a.id,
            app: a.toolkit,
            status: a.status,
            created_at: a.created_at,
        })
        .collect())
}

/// Start an OAuth connect for `toolkit` (slug, e.g. "gmail"). Returns the
/// redirect URL the user must visit plus the connection id to poll.
pub async fn connect(_user_id: &str, toolkit: &str) -> Result<ConnectStart, String> {
    let client = client()?;
    let resp = client
        .create_auth_link(toolkit, auth_config_for(toolkit))
        .await
        .map_err(|e| e.to_string())?;
    Ok(ConnectStart {
        connection_id: resp.connected_account_id.unwrap_or_default(),
        redirect_url: Some(resp.redirect_url),
    })
}

/// Poll one connection's status during the OAuth handshake.
pub async fn poll(_user_id: &str, connection_id: &str) -> Result<Connection, String> {
    let client = client()?;
    let a = client
        .get_connected_account(connection_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Connection {
        id: a.id,
        app: a.toolkit,
        status: a.status,
        created_at: a.created_at,
    })
}

/// Disconnect (delete) a connected account.
pub async fn disconnect(_user_id: &str, connection_id: &str) -> Result<(), String> {
    let client = client()?;
    client
        .delete_connected_account(connection_id)
        .await
        .map_err(|e| e.to_string())
}
