// logic/git_provider — per-user Git provider access tokens (GitHub / GitLab).
//
// Storage is the user's local SQLite (`git_provider_tokens`, migration 0040),
// the same decision as the Binance/MEXC credentials: keychain access prompts
// on every rebuild of an unsigned dev build, so the token rests in the
// per-user DB file under OS file permissions. Compensating controls are the
// key itself (fine-grained PAT, minimum scopes, revoke on disconnect) and this
// boundary:
//
//   * no op returns the token — `git_token_status` answers a masked preview;
//   * the only reader of the `token` column is the provider client (which
//     lives in this module, so the value never crosses the module edge);
//   * nothing here derives `Debug` on a struct that carries the token.
//
// Pure logic: no tauri/axum imports.

use serde::Serialize;

/// Default API host per provider. A self-managed GitLab or GitHub Enterprise
/// install passes its own host to `git_connect_pat` instead.
const GITHUB_HOST: &str = "api.github.com";
const GITLAB_HOST: &str = "gitlab.com";

/// What the Settings card renders for one stored connection. The token itself
/// never appears here — only a masked preview.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTokenStatus {
    /// "github" | "gitlab"
    pub provider: String,
    /// API host this token talks to (never assumed to be api.github.com).
    pub host: String,
    /// User-chosen label for this connection.
    pub account: String,
    /// Scopes as the provider reported them, when known.
    pub scopes: Option<String>,
    /// First 4 + last 4 of the token, dots when too short to mask.
    pub token_preview: String,
    /// Unix seconds the row was first written.
    pub created_at: i64,
}

/// Build the UI-facing status from a row of
/// `SELECT provider, host, account, scopes, token, created_at`. The token is
/// read only to build the preview and is dropped here.
fn status_from_row(row: &libsql::Row) -> GitTokenStatus {
    let token: String = row.get(4).unwrap_or_default();
    GitTokenStatus {
        provider: row.get(0).unwrap_or_default(),
        host: row.get(1).unwrap_or_default(),
        account: row.get(2).unwrap_or_default(),
        scopes: row.get(3).ok().flatten(),
        token_preview: mask(&token),
        created_at: row.get(5).unwrap_or(0),
    }
}

/// Canonical provider id, or `None` for anything else. Lowercased so the UI can
/// send whatever the user picked without a second normalization pass.
fn canonical_provider(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "github" => Some("github"),
        "gitlab" => Some("gitlab"),
        _ => None,
    }
}

/// Host normalization: drop a pasted scheme, any path after the host, and a
/// trailing slash — `https://GitLab.Example.com/api/v4/` stores as
/// `gitlab.example.com`, so the same install cannot end up as two rows.
fn normalize_host(host: &str) -> String {
    let host = host.trim();
    let host = host
        .strip_prefix("https://")
        .or_else(|| host.strip_prefix("http://"))
        .unwrap_or(host);
    let host = host.split('/').next().unwrap_or(host);
    host.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// Masked preview: first 4 + last 4. A token too short to mask meaningfully
/// shows dots only, so no more of it leaks than the user already typed.
fn mask(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 8 {
        return "…".to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

/// Connect (or re-key) a provider with a personal access token.
///
/// `host` defaults to the provider's public API host; `account` is a
/// user-chosen label and defaults to `"default"`. Reconnecting the same
/// (provider, host, account) replaces the token in place and keeps
/// `created_at`.
pub async fn git_connect_pat(
    user_id: &str,
    provider: &str,
    host: Option<&str>,
    account: Option<&str>,
    token: &str,
    scopes: Option<&str>,
) -> Result<GitTokenStatus, String> {
    let provider =
        canonical_provider(provider).ok_or_else(|| "unknown provider (use github or gitlab)".to_string())?;
    let host = match host.map(str::trim).filter(|h| !h.is_empty()) {
        Some(host) => normalize_host(host),
        None => {
            if provider == "github" {
                GITHUB_HOST.to_string()
            } else {
                GITLAB_HOST.to_string()
            }
        }
    };
    if host.is_empty() {
        return Err("host must not be empty".into());
    }
    let account = account.map(str::trim).filter(|a| !a.is_empty()).unwrap_or("default");
    if account.len() > 256 {
        return Err("account label looks malformed (too long)".into());
    }
    let token = token.trim();
    if token.is_empty() {
        return Err("access token must not be empty".into());
    }
    if token.len() > 1024 {
        return Err("access token looks malformed (too long)".into());
    }
    let scopes = scopes.map(str::trim).filter(|s| !s.is_empty());

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let conn = kawai_db::db_connection(user_id)
        .await
        .map_err(|e| format!("open local db: {e}"))?;
    conn.execute(
        "INSERT INTO git_provider_tokens
            (provider, host, account, token, scopes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, host, account) DO UPDATE SET
            token = excluded.token,
            scopes = COALESCE(excluded.scopes, git_provider_tokens.scopes),
            updated_at = excluded.updated_at",
        libsql::params![provider, host.as_str(), account, token, scopes, now, now],
    )
    .await
    .map_err(|e| format!("save git token: {e}"))?;

    // Re-read the row instead of echoing the input: on a re-key the stored
    // `created_at` (and `scopes`, when the new value was omitted) is the one the
    // UI has been showing all along.
    let mut rows = conn
        .query(
            "SELECT provider, host, account, scopes, token, created_at
             FROM git_provider_tokens WHERE provider = ? AND host = ? AND account = ?",
            libsql::params![provider, host.as_str(), account],
        )
        .await
        .map_err(|e| format!("read git token: {e}"))?;
    let row = rows
        .next()
        .await
        .map_err(|e| format!("read git token: {e}"))?
        .ok_or_else(|| "git token was not stored".to_string())?;
    Ok(status_from_row(&row))
}

/// Every stored connection, ordered so the Settings list is stable across
/// calls. Status never errors on an empty store — an empty `Vec` is the honest
/// "nothing connected yet".
pub async fn git_token_status(user_id: &str) -> Result<Vec<GitTokenStatus>, String> {
    let conn = kawai_db::db_connection(user_id)
        .await
        .map_err(|e| format!("open local db: {e}"))?;
    let mut rows = conn
        .query(
            "SELECT provider, host, account, scopes, token, created_at
             FROM git_provider_tokens
             ORDER BY provider, host, account",
            (),
        )
        .await
        .map_err(|e| format!("read git tokens: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| format!("read git tokens: {e}"))? {
        out.push(status_from_row(&row));
    }
    Ok(out)
}

/// Remove one stored connection. The caller is expected to revoke the token at
/// the provider first (GitHub `DELETE /applications/{client_id}/token`, GitLab
/// `/oauth/revoke`) — deleting the row only forgets it locally.
pub async fn git_disconnect(
    user_id: &str,
    provider: &str,
    host: Option<&str>,
    account: Option<&str>,
) -> Result<(), String> {
    let provider =
        canonical_provider(provider).ok_or_else(|| "unknown provider (use github or gitlab)".to_string())?;
    let host = match host.map(str::trim).filter(|h| !h.is_empty()) {
        Some(host) => normalize_host(host),
        None => {
            if provider == "github" {
                GITHUB_HOST.to_string()
            } else {
                GITLAB_HOST.to_string()
            }
        }
    };
    let account = account.map(str::trim).filter(|a| !a.is_empty()).unwrap_or("default");

    let conn = kawai_db::db_connection(user_id)
        .await
        .map_err(|e| format!("open local db: {e}"))?;
    conn.execute(
        "DELETE FROM git_provider_tokens WHERE provider = ? AND host = ? AND account = ?",
        libsql::params![provider, host, account],
    )
    .await
    .map_err(|e| format!("delete git token: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The data root is process-global, so the tests that set it are
    /// serialized.
    static DATA_ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn temp_data_root(tag: &str) -> (std::sync::MutexGuard<'static, ()>, std::path::PathBuf) {
        let guard = DATA_ROOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "kawai_git_provider_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        kawai_db::set_data_root(dir.clone());
        (guard, dir)
    }

    /// The stored token must round-trip, while the status op only ever shows a
    /// masked preview — the token itself has no path to the UI.
    #[tokio::test]
    async fn connect_status_disconnect_round_trips_without_leaking_the_token() {
        let (_guard, _dir) = temp_data_root("round_trip");
        let user = "git-round-trip@example.com";
        let token = "ghp_abcdefghijklmnop1234";

        assert!(git_token_status(user).await.unwrap().is_empty());

        let connected = git_connect_pat(user, "github", None, Some("work"), token, None)
            .await
            .unwrap();
        assert_eq!(connected.provider, "github");
        assert_eq!(connected.host, "api.github.com");
        assert_eq!(connected.account, "work");
        assert_eq!(connected.token_preview, "ghp_…1234");

        let status = git_token_status(user).await.unwrap();
        assert_eq!(status.len(), 1);
        assert!(!status[0].token_preview.contains(token), "{:?}", status[0]);

        // The token is in the row (the provider client needs it) even though
        // no op returns it.
        let conn = kawai_db::db_connection(user).await.unwrap();
        let mut rows = conn
            .query("SELECT token FROM git_provider_tokens", ())
            .await
            .unwrap();
        let stored: String = rows.next().await.unwrap().unwrap().get(0).unwrap();
        assert_eq!(stored, token);

        git_disconnect(user, "github", None, Some("work")).await.unwrap();
        assert!(git_token_status(user).await.unwrap().is_empty());
    }

    /// Reconnecting the same key replaces the token in place: one row, new
    /// secret, `created_at` untouched.
    #[tokio::test]
    async fn reconnecting_the_same_connection_replaces_the_token_in_place() {
        let (_guard, _dir) = temp_data_root("upsert");
        let user = "git-upsert@example.com";
        git_connect_pat(user, "github", None, None, "ghp_first_token_0001", None)
            .await
            .unwrap();
        let first = git_token_status(user).await.unwrap();
        assert_eq!(first.len(), 1);

        let reconnected =
            git_connect_pat(user, "github", None, None, "ghp_second_token_0002", Some("repo read:user"))
                .await
                .unwrap();
        assert_eq!(reconnected.created_at, first[0].created_at);
        let second = git_token_status(user).await.unwrap();
        assert_eq!(second.len(), 1, "same key updates, never duplicates");
        assert_eq!(second[0].token_preview, "ghp_…0002");
        assert_eq!(second[0].scopes.as_deref(), Some("repo read:user"));
        assert_eq!(second[0].created_at, first[0].created_at);

        // Omitting scopes keeps the last verified value rather than wiping it.
        git_connect_pat(user, "github", None, None, "ghp_third_token_0003", None)
            .await
            .unwrap();
        let third = git_token_status(user).await.unwrap();
        assert_eq!(third[0].scopes.as_deref(), Some("repo read:user"));
    }

    /// `host` is part of the key: github.com and a GitHub Enterprise install
    /// are separate connections, and a pasted URL normalizes to a bare host.
    #[tokio::test]
    async fn hosts_are_separate_connections_and_urls_normalize() {
        let (_guard, _dir) = temp_data_root("hosts");
        let user = "git-hosts@example.com";
        git_connect_pat(user, "github", None, None, "ghp_public_token_0001", None)
            .await
            .unwrap();
        let enterprise = git_connect_pat(
            user,
            "github",
            Some("https://GitHub.Example.com/api/v3/"),
            Some("enterprise"),
            "ghp_enterprise_token_01",
            None,
        )
        .await
        .unwrap();
        assert_eq!(enterprise.host, "github.example.com");

        let status = git_token_status(user).await.unwrap();
        assert_eq!(status.len(), 2);
        assert!(status.iter().any(|s| s.host == "api.github.com"));
        assert!(status.iter().any(|s| s.host == "github.example.com"));
    }

    /// Junk input fails loudly instead of writing a row nothing can use.
    #[tokio::test]
    async fn unknown_provider_and_empty_token_are_rejected() {
        let (_guard, _dir) = temp_data_root("reject");
        let user = "git-reject@example.com";
        assert!(git_connect_pat(user, "bitbucket", None, None, "abc12345", None)
            .await
            .is_err());
        assert!(git_connect_pat(user, "github", None, None, "   ", None)
            .await
            .is_err());
        assert!(git_token_status(user).await.unwrap().is_empty());
    }

    /// A short token masks to dots only — no more of it leaks than the user
    /// already typed.
    #[tokio::test]
    async fn short_tokens_mask_to_dots() {
        let (_guard, _dir) = temp_data_root("short");
        let user = "git-short@example.com";
        let connected = git_connect_pat(user, "gitlab", None, None, "abcdefgh", None)
            .await
            .unwrap();
        assert_eq!(connected.token_preview, "…");
        assert_eq!(connected.host, "gitlab.com");
    }
}
