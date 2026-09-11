use async_stream::stream;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityInput {
    pub events: u64,
    pub interval_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ActivityEvent {
    Started { total: u64 },
    Progress { done: u64, total: u64 },
    Finished,
    Error { message: String },
}

/// Request-response example.
pub fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

/// Authenticated identity. Real ops take `user_id` as the first param and use
/// it to scope data. The wrappers (`commands.rs`, `web.rs`) resolve identity at
/// the edge and pass `sub` in.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub user_id: String,
}

pub fn whoami(user_id: &str) -> UserInfo {
    UserInfo {
        user_id: user_id.to_string(),
    }
}

/// Streaming example. Returns a pure async stream of typed events.
pub fn generate_activity(input: ActivityInput) -> impl Stream<Item = ActivityEvent> {
    let total = input.events;
    let interval = input.interval_ms;
    stream! {
        yield ActivityEvent::Started { total };
        for done in 1..=total {
            tokio::time::sleep(Duration::from_millis(interval)).await;
            yield ActivityEvent::Progress { done, total };
        }
        yield ActivityEvent::Finished;
    }
}

/// Suggest short follow-up requests for a just-finished deliverable (one
/// cloud/local one-shot via the remote-llm pool). Never errors: any failure
/// (pool empty, parse miss) degrades to an empty list and the frontend keeps
/// its static chips. The excerpt is truncated here so even a caller passing
/// the full deliverable stays within the local engine's materials budget.
pub async fn suggest_followups(_user_id: &str, excerpt: String) -> Vec<String> {
    const MAX_EXCERPT_CHARS: usize = 2000;
    const MAX_SUGGESTIONS: usize = 4;
    let excerpt: String = excerpt.chars().take(MAX_EXCERPT_CHARS).collect();
    if excerpt.trim().is_empty() {
        return Vec::new();
    }
    let system = "You suggest short follow-up requests for a freshly produced deliverable.";
    let task = format!(
        "The deliverable below was just produced. Suggest {} short follow-up requests \
         (<=4 words each, same language as the deliverable) the user is most likely to ask next. \
         Return a JSON array of strings. Deliverable:\n{excerpt}",
        MAX_SUGGESTIONS
    );
    let response = match remote_llm::reason::reason_as(system, &task, "followup-suggester").await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let json = remote_llm::reason::extract_json(&response);
    serde_json::from_str::<Vec<String>>(&json)
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(MAX_SUGGESTIONS)
        .collect()
}

/// Resolve the on-device model path from standard development and bundled locations.
///   3. `~/.kawai/models/gemma-4-E4B-it.litertlm` (user home)
pub fn resolve_model_path() -> Result<String, String> {
    let filename = kawai_paths::LLM_MODEL_FILENAME;
    kawai_paths::find_model(filename)
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| format!(
            "model not found: install {filename} in the app resources or ~/.kawai/models/"
        ))
}

/// Download the on-device model from HuggingFace Hub if not locally present.
/// Uses reqwest with resume support. Downloads to `~/.kawai/models/<filename>`
/// so subsequent `resolve_model_path()` calls find it. Prints progress to
/// stderr (visible in the Tauri dev console and `app.log`).
///
/// Repo: `litert-community/gemma-4-E4B-it-litert-lm` (Apache-2.0, public,
/// not gated — no token needed).
#[cfg(feature = "litert")]
pub async fn ensure_model() -> Result<String, String> {
    let filename = "gemma-4-E4B-it.litertlm";
    let repo_id = "litert-community/gemma-4-E4B-it-litert-lm";
    let model_url = format!("https://huggingface.co/{repo_id}/resolve/main/{filename}");

    // Fast path: already on disk.
    if let Ok(path) = resolve_model_path() {
        eprintln!("[ensure_model] found locally: {path}");
        return Ok(path);
    }

    // Reset download progress for a fresh attempt.
    local_llm::reset_download_state();

    // Determine target: ~/.kawai/models/<filename>
    let model_dir = kawai_paths::user_models_dir()
        .ok_or_else(|| "HOME not set — cannot download model".to_string())?;
    let target_path = model_dir.join(filename);
    let tmp_path = model_dir.join(format!("{filename}.part"));

    std::fs::create_dir_all(&model_dir)
        .map_err(|e| format!("create model dir {}: {e}", model_dir.display()))?;

    // Check for a partial download (supports resume).
    let existing_size = std::fs::metadata(&tmp_path)
        .ok()
        .map(|m| m.len())
        .unwrap_or(0);

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("reqwest client: {e}"))?;

    let response = if existing_size > 0 {
        eprintln!(
            "[ensure_model] resuming partial download ({:.1} MB already done)",
            existing_size as f64 / 1e6
        );
        client
            .get(&model_url)
            .header("Range", format!("bytes={}-", existing_size))
            .send()
            .await
            .map_err(|e| format!("http request (resume): {e}"))?
    } else {
        client
            .get(&model_url)
            .send()
            .await
            .map_err(|e| format!("http request: {e}"))?
    };

    if response.status() == 206 || response.status().is_success() {
        if let Err(e) = download_stream(response, &tmp_path, existing_size, filename).await {
            local_llm::mark_download_failed();
            return Err(e);
        }
    } else {
        local_llm::mark_download_failed();
        return Err(format!(
            "download failed: HTTP {} for {model_url}",
            response.status()
        ));
    }

    // Atomically move the completed file into place.
    std::fs::rename(&tmp_path, &target_path).map_err(|e| format!("rename to target: {e}"))?;

    local_llm::mark_download_complete();

    eprintln!(
        "[ensure_model] download complete: {}",
        target_path.display()
    );

    Ok(target_path.to_string_lossy().into_owned())
}

/// Helper: stream a download response to a temp file with progress logging.
#[cfg(feature = "litert")]
async fn download_stream(
    response: reqwest::Response,
    tmp_path: &std::path::Path,
    existing_size: u64,
    filename: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let total_size = existing_size + response.content_length().unwrap_or(0);

    // Publish initial total so the frontend can display "0 / 3.7 GB".
    local_llm::update_download_progress(existing_size, total_size);

    eprintln!(
        "[ensure_model] downloading {filename} ({:.1} GB) ...",
        total_size as f64 / 1e9
    );

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(existing_size > 0)
        .write(true)
        .open(tmp_path)
        .map_err(|e| format!("open tmp file: {e}"))?;

    let mut stream = response.bytes_stream();
    let mut downloaded = existing_size;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download chunk: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("write chunk: {e}"))?;
        downloaded += chunk.len() as u64;

        // Publish progress for the status endpoint (every chunk).
        local_llm::update_download_progress(downloaded, total_size);

        // Log progress every ~100 MB.
        let prev_mb = (downloaded - chunk.len() as u64) / 100_000_000;
        let cur_mb = downloaded / 100_000_000;
        if cur_mb > prev_mb && total_size > 0 {
            let pct = downloaded as f64 / total_size as f64 * 100.0;
            eprintln!(
                "[ensure_model] {:.1}/{:.1} GB ({:.0}%)",
                downloaded as f64 / 1e9,
                total_size as f64 / 1e9,
                pct
            );
        }
    }

    eprintln!("[ensure_model] finalizing ...");
    Ok(())
}

// Database (local SQLite), chat-session persistence lives in `db`; the
// on-device LLM in `local_llm`; office tooling in `office`; the prompt-based
// tool-calling agent loop in `agent`; the cloud subagent client (hybrid LLM
// tier) in `remote`. Re-exported so `logic::X` paths used by the wrappers stay
// stable across the split.
pub mod db;
pub mod db_migrations;
#[cfg(feature = "litert")]
pub use local_llm;
/// Convenience re-export so wrappers can call `logic::local_model_status()`.
#[cfg(feature = "litert")]
pub use local_llm::local_model_status;
// Session-scoped evidence cache for the agent loop (cross-turn reuse of
// unchanged-file reads). In-process only — no SQLite, no schema.
pub mod evidence_cache;
pub mod knowledge;
pub mod office;
pub mod rag;
pub mod remote;
// Data analysis agent tools (builtin.analytics). Implies office — the
// tabular files live in the office store.
pub mod analytics;
// Remote SQL sources (Postgres/MySQL) behind the narrower `analytics-sql`
// feature — sqlx stays out of builds that only serve local SQLite.
#[cfg(feature = "analytics-sql")]
pub mod sql_remote;
// GraphRAG (libSQL-native, feature "graph"): Naive/Local/Global/Hybrid/Mix
// over one DB file. No office/analytics dependency.
pub mod graph;
// When graph + office are both on, logic::graph re-exports from knowledge::graph.
// When only graph is on (no office), logic::graph compiles the full implementation
// directly (graph.rs handles both cases internally).
// Skills — reusable SKILL.md instruction sets (ungated; plain libsql).
pub mod skills;
// L1 memories — atomic long-term memory items + cloud extraction (ungated
// CRUD; extraction needs the hybrid vault, manual CRUD never does).
pub mod memory;
// CodeGraph bridge — phase0 sidecar (`codegraph` feature) + phase1 native
// (`codegraph-native` implies `codegraph`; kernel rlib wired when available).
pub mod codegraph;
// TTS via piper-rs (neural Piper ONNX models). Feature-gated internally;
// always compiled so the command stays registered in generate_handler!.
pub mod tts;
pub mod email;
// Local email+password auth (user directory, vault-encoded passwords).
pub mod local_auth;
// Monad EVM chain client (`monad` feature): public RPC reads — native
// balance, chain status, ERC-20 balance/info, gas price. Pure alloy HTTP
// provider; RPC URL via `KAWAI_MONAD_RPC_URL` (default: Monad mainnet). The
// module is always compiled (stable surface for the always-registered
// commands); without the feature it serves guidance-error stubs
// (codegraph/tts pattern).
pub mod monad;
// Hardcoded Monad contract addresses (source of truth: NETWORKS.md at the
// repo root) — wallet feature source of truth.
pub mod monad_contracts;
// Per-user Monad hot wallet (`monad` feature): key lives ONLY in the OS
// keychain (`monad-wallet/<user_id>`); create/sign/delete orchestration +
// user-initiated transfers (native/ERC-20/vault deposit, signed on-device).
// Always compiled (stable surface for the always-registered commands); without
// the feature it serves guidance-error stubs (codegraph/tts pattern).
pub mod monad_wallet;

pub use db::*;

/// Delete a chat session and drop its session-scoped state (the agent loop's
/// evidence cache). Explicit definition shadowing the `db::*` glob re-export
/// so both transport wrappers get the cleanup without changes.
pub async fn delete_chat_session(user_id: &str, session_id: i64) -> Result<(), DbError> {
    evidence_cache::drop_session(user_id, session_id);
    db::delete_chat_session(user_id, session_id).await
}


