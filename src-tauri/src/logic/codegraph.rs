// logic/codegraph — feature-gated CodeGraph bridge (sidecar only).
//
// Sidecar (feature `codegraph`): spawns the external `codegraph` CLI
// (`codegraph explore/status`) via tokio::process, shared LRU cache with the
// AgentTool crate. Zero extra crates, zero cost when the feature is off.
// Works with the existing npm/bundle install (`codegraph --version` on PATH).
// Pure logic: no tauri/axum imports.

use serde::{Deserialize, Serialize};

// ---- Types (always compiled so wrappers stay stable) ------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodegraphExploreRequest {
    pub query: String,
    pub project_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodegraphExploreResult {
    pub query: String,
    pub output: String,
    pub is_error: bool,
    pub backend: String, // "sidecar" | "native" | "unavailable"
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodegraphStatusResult {
    pub available: bool,
    pub backend: String,
    pub version: Option<String>,
    pub message: String,
}

// ---- Helpers (always compiled) ---------------------------------------------

#[cfg(feature = "codegraph")]
fn codegraph_bin() -> String {
    std::env::var("CODEGRAPH_BIN")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "codegraph".to_string())
}

// ---- Phase0: sidecar (feature `codegraph`) --------------------------------
// `sidecar_explore` is now shared via `crates/toolsets/codegraph` (LRU cache);
// this local copy is kept for sidecar_status fallback and tests.
#[cfg(feature = "codegraph")]
#[allow(dead_code)]
async fn sidecar_explore(query: &str, project_path: Option<&str>) -> Result<String, String> {
    use tokio::process::Command;
    let bin = codegraph_bin();
    let mut cmd = Command::new(&bin);
    cmd.arg("explore").arg(query).arg("--json");
    if let Some(p) = project_path {
        if !p.is_empty() {
            cmd.arg("--project").arg(p);
        }
    }
    // Ensure we don't hang forever on a large repo.
    let output = cmd.output().await.map_err(|e| {
        format!(
            "codegraph sidecar not available (tried `{bin}`): {e} — install via `npm i -g @colbymchenry/codegraph` or `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh`"
        )
    })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // codegraph CLI returns non-zero for "not indexed" but still prints guidance — treat as ok.
        let combined = if !stdout.trim().is_empty() {
            stdout.into_owned()
        } else {
            stderr.into_owned()
        };
        if combined.trim().is_empty() {
            Err(format!("codegraph explore failed: exit {}", output.status))
        } else {
            Ok(combined)
        }
    }
}

#[cfg(feature = "codegraph")]
async fn sidecar_status(project_path: Option<&str>) -> Result<(Option<String>, String), String> {
    use tokio::process::Command;
    let bin = codegraph_bin();
    let mut cmd = Command::new(&bin);
    cmd.arg("status");
    if let Some(p) = project_path {
        if !p.is_empty() {
            cmd.arg(p);
        }
    }
    cmd.arg("--json");
    let output = cmd.output().await.map_err(|e| {
        format!("codegraph sidecar not available (tried `{bin}`): {e}")
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let version = sidecar_version().await;
    Ok((version, stdout))
}

#[cfg(feature = "codegraph")]
async fn sidecar_version() -> Option<String> {
    use tokio::process::Command;
    let bin = codegraph_bin();
    let output = Command::new(&bin).arg("--version").output().await.ok()?;
    if output.status.success() {
        let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if v.is_empty() { None } else { Some(v) }
    } else {
        None
    }
}

// ---- Public API (gated) ----------------------------------------------------

/// Explore the codebase via CodeGraph. When the `codegraph` feature is off,
/// this returns a guidance error so the caller can fall back to grep/read.
/// When `codegraph` is on, this shares the same LRU + single-flight cache as
/// the AgentTool (`crates/toolsets/codegraph`), so frequent agent + UI calls
/// coelesce.
pub async fn codegraph_explore(
    _user_id: &str,
    query: String,
    project_path: Option<String>,
) -> Result<CodegraphExploreResult, String> {
    #[cfg(feature = "codegraph")]
    {
        // Shared cache path — same implementation as the AgentTool.
        match ::codegraph::explore_with_cache(query.clone(), project_path.clone()).await {
            Ok(output) => Ok(CodegraphExploreResult {
                query,
                output,
                is_error: false,
                backend: "sidecar-cached".to_string(),
            }),
            Err(e) => Ok(CodegraphExploreResult {
                query,
                output: e,
                is_error: true,
                backend: "sidecar".to_string(),
            }),
        }
    }
    #[cfg(not(feature = "codegraph"))]
    {
        let _ = (query, project_path, _user_id);
        Err("codegraph feature not enabled (build with --features codegraph)".to_string())
    }
}

/// Status of the CodeGraph installation/index for a project.
pub async fn codegraph_status(
    _user_id: &str,
    project_path: Option<String>,
) -> Result<CodegraphStatusResult, String> {
    #[cfg(feature = "codegraph")]
    {
        let bin = codegraph_bin();
        let available = sidecar_version().await.is_some();
        if !available {
            return Ok(CodegraphStatusResult {
                available: false,
                backend: "sidecar".to_string(),
                version: None,
                message: format!(
                    "codegraph binary not found on PATH (tried `{bin}`). Install: npm i -g @colbymchenry/codegraph or curl | sh. Feature `codegraph` is compiled in but no binary is installed — this is expected in dev without `codegraph` on PATH."
                ),
            });
        }
        match sidecar_status(project_path.as_deref()).await {
            Ok((version, msg)) => Ok(CodegraphStatusResult {
                available: true,
                backend: "sidecar".to_string(),
                version,
                message: if msg.trim().is_empty() {
                    "codegraph available".to_string()
                } else {
                    msg
                },
            }),
            Err(e) => Ok(CodegraphStatusResult {
                available: true,
                backend: "sidecar".to_string(),
                version: sidecar_version().await,
                message: e,
            }),
        }
    }
    #[cfg(not(feature = "codegraph"))]
    {
        let _ = (project_path, _user_id);
        Err("codegraph feature not enabled (build with --features codegraph)".to_string())
    }
}

/// Whether the sidecar binary is reachable (best-effort, no feature gate needed
/// for the check itself — just returns false when the feature is off).
pub async fn codegraph_is_available() -> bool {
    #[cfg(feature = "codegraph")]
    {
        sidecar_version().await.is_some()
    }
    #[cfg(not(feature = "codegraph"))]
    {
        false
    }
}
