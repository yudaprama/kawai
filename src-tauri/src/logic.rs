use async_stream::stream;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Errors surfaced by the pure logic layer's public ops. Transports render
/// via `Display`; the variants let callers distinguish user-fixable input
/// problems from environment/infrastructure failures.
#[derive(Debug, thiserror::Error)]
pub enum LogicError {
    /// Invalid caller input (empty language, oversized deliverable, missing args).
    #[error("{0}")]
    InvalidInput(String),
    /// The on-device model file is not installed in any standard location.
    #[error("{0}")]
    ModelNotFound(String),
    /// On-device model download failed (network/HTTP/filesystem).
    #[error("{0}")]
    ModelDownload(String),
    /// Office file import failed (unreadable path, decode, unsupported type).
    #[error("{0}")]
    OfficeImport(String),
    /// Remote-LLM-backed op failed (translate, suggest).
    #[error("{0}")]
    Llm(String),
    /// Persistence/cache failure.
    #[error("{0}")]
    Db(#[from] kawai_db::DbError),
}

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
pub async fn suggest_followups(_user_id: &str, session_id: Option<i64>, excerpt: String) -> Vec<String> {
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
    let response = match remote_llm::reason::reason_in(
        system,
        &task,
        "followup-suggester",
        session_id.map(|id| format!("kawai-session-{id}")),
        Some(_user_id.to_string()),
    )
    .await
    {
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

/// Drop a markdown fence the model wrapped its WHOLE answer in
/// (` ```markdown … ``` `) — the viewer wants raw markdown, not one giant
/// code block. Skipped when the SOURCE itself starts with a fence, so a
/// legitimately fence-first deliverable is never stripped; also skipped when
/// the first line isn't a plain opener (inline code at document start is
/// content, not a wrapper).
fn strip_outer_fence<'a>(source: &str, response: &'a str) -> &'a str {
    let t = response.trim();
    if !t.starts_with("```") || source.trim_start().starts_with("```") {
        return t;
    }
    let Some(newline) = t.find('\n') else {
        return t; // single line — nothing to unwrap
    };
    let (first, rest) = t.split_at(newline);
    let rest = &rest[1..]; // drop the newline
    let plain_opener = first[3..]
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_'));
    if !plain_opener {
        return t;
    }
    rest.strip_suffix("```").map(str::trim_end).unwrap_or(rest)
}

/// Translate a finished deliverable into another language (one cloud/local
/// one-shot via the remote-llm pool). Returns translated markdown with its
/// structure intact — headings, lists, tables, links and `kawai-file://`
/// chart tokens survive, so the viewer renders it and the export pipeline
/// accepts it exactly like the original. Errors instead of degrading: the
/// viewer shows the message next to the translate control.
///
/// Read-through cache keyed by (source hash, language): a repeat translate
/// of the same text serves the stored body with zero LLM calls, and the write
/// lands inside this op — there is no frontend write path to lose.
pub async fn translate_deliverable(
    user_id: &str,
    session_id: Option<i64>,
    markdown: &str,
    language: &str,
) -> Result<String, LogicError> {
    // Hard cap: one pass, no chunking. The deliverable writer's own output
    // budget (~8192 tokens) keeps real deliverables well under this.
    const MAX_SOURCE_CHARS: usize = 48_000;
    let language = language.trim();
    if language.is_empty() {
        return Err(LogicError::InvalidInput("target language required".into()));
    }
    let source = markdown.trim();
    if source.is_empty() {
        return Err(LogicError::InvalidInput("nothing to translate".into()));
    }
    if source.chars().count() > MAX_SOURCE_CHARS {
        return Err(LogicError::InvalidInput(format!(
            "deliverable too long to translate in one pass (limit {MAX_SOURCE_CHARS} characters)"
        )));
    }
    let source_hash = translation_source_hash(source);
    if let Some(stored) =
        kawai_db::get_deliverable_translation(user_id, &source_hash, language).await?
    {
        return Ok(stored);
    }
    let system = "You are a professional translator of finished report deliverables. You reply with the translated markdown and nothing else.";
    let task = format!(
        "Translate the markdown deliverable below into {language}.\n\
         - Keep the markdown structure exactly: headings, lists, tables, links, bold/italic, inline code and fences change only their TEXT, never their markup.\n\
         - In image tokens `![caption](kawai-file://ID)`, translate only the caption and copy the `(kawai-file://ID)` URL exactly.\n\
         - Keep numbers, dates, proper nouns and code identifiers unchanged.\n\
         - Reply with ONLY the translated markdown — no commentary, no code fence around the whole answer.\n\n\
         Deliverable:\n{source}"
    );
    let response = remote_llm::reason::reason_in(
        system,
        &task,
        "deliverable-translator",
        session_id.map(|id| format!("kawai-session-{id}")),
        Some(user_id.to_string()),
    )
    .await
    .map_err(|e| LogicError::Llm(format!("translation failed: {e}")))?;
    let translated = strip_outer_fence(source, &response);
    if translated.trim().is_empty() {
        return Err(LogicError::InvalidInput(
            "translator returned an empty result".into(),
        ));
    }
    // Persist (read-through write): the translation itself already succeeded,
    // so a storage failure only costs future cache hits — warn, don't fail the
    // user's result away.
    if let Err(e) = kawai_db::put_deliverable_translation(
        user_id,
        &source_hash,
        language,
        &translated,
        session_id,
    )
    .await
    {
        tracing::warn!(component = "deliverable", error = %e, "translation not persisted");
    }
    Ok(translated.to_string())
}

/// Storage identity for a translation: sha256 hex of the canonical (trimmed)
/// source markdown. Content-keyed on purpose — planKey-less legacy records
/// and any session holding the same deliverable resolve to one row.
fn translation_source_hash(source: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(source.as_bytes()))
}

/// Saved translations (language chips) for this exact deliverable text.
/// Read-only metadata — restoring a chip rides `translate_deliverable`'s
/// cache hit, so no stored body ships and no LLM call happens.
pub async fn deliverable_translations(
    user_id: &str,
    markdown: &str,
) -> Result<Vec<kawai_db::DeliverableTranslationMeta>, LogicError> {
    let source = markdown.trim();
    if source.is_empty() {
        return Ok(Vec::new());
    }
    let rows = kawai_db::list_deliverable_translations(user_id, &translation_source_hash(source))
        .await?;
    Ok(rows)
}

/// Resolve the on-device model path from standard development and bundled locations.
///   3. `~/.kawai/models/gemma-4-E4B-it.litertlm` (user home)
pub fn resolve_model_path() -> Result<String, LogicError> {
    let filename = kawai_paths::LLM_MODEL_FILENAME;
    kawai_paths::find_model(filename)
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| {
            LogicError::ModelNotFound(format!(
                "model not found: install {filename} in the app resources or ~/.kawai/models/"
            ))
        })
}

/// Download the on-device model from HuggingFace Hub if not locally present.
/// Uses reqwest with resume support. Downloads to `~/.kawai/models/<filename>`
/// so subsequent `resolve_model_path()` calls find it. Prints progress to
/// stderr (visible in the Tauri dev console and `app.log`).
///
/// Repo: `litert-community/gemma-4-E4B-it-litert-lm` (Apache-2.0, public,
/// not gated — no token needed).
#[cfg(feature = "litert")]
pub async fn ensure_model() -> Result<String, LogicError> {
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
    let model_dir = kawai_paths::user_models_dir().ok_or_else(|| {
        LogicError::ModelDownload("HOME not set — cannot download model".into())
    })?;
    let target_path = model_dir.join(filename);
    let tmp_path = model_dir.join(format!("{filename}.part"));

    std::fs::create_dir_all(&model_dir).map_err(|e| {
        LogicError::ModelDownload(format!("create model dir {}: {e}", model_dir.display()))
    })?;

    // Check for a partial download (supports resume).
    let existing_size = std::fs::metadata(&tmp_path)
        .ok()
        .map(|m| m.len())
        .unwrap_or(0);

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| LogicError::ModelDownload(format!("reqwest client: {e}")))?;

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
            .map_err(|e| LogicError::ModelDownload(format!("http request (resume): {e}")))?
    } else {
        client
            .get(&model_url)
            .send()
            .await
            .map_err(|e| LogicError::ModelDownload(format!("http request: {e}")))?
    };

    if response.status() == 206 || response.status().is_success() {
        if let Err(e) = download_stream(response, &tmp_path, existing_size, filename).await {
            local_llm::mark_download_failed();
            return Err(LogicError::ModelDownload(e));
        }
    } else {
        local_llm::mark_download_failed();
        return Err(LogicError::ModelDownload(format!(
            "download failed: HTTP {} for {model_url}",
            response.status()
        )));
    }

    // Atomically move the completed file into place.
    std::fs::rename(&tmp_path, &target_path)
        .map_err(|e| LogicError::ModelDownload(format!("rename to target: {e}")))?;

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

/// Import an office file from either a desktop path or base64 payload.
/// Uploads also trigger best-effort tabular prewarming; this shared helper
/// keeps the Tauri and Axum transport wrappers behaviorally identical.
pub fn import_office_file(
    user_id: &str,
    source_path: Option<&str>,
    name: Option<&str>,
    data_base64: Option<&str>,
) -> Result<office::OfficeFile, LogicError> {
    let imported = match (source_path, (name, data_base64)) {
        (Some(src), _) => office::import_path(user_id, src),
        (None, (Some(name), Some(data))) => office::import_base64(user_id, name, data),
        _ => Err("provide sourcePath, or name + dataBase64".into()),
    }
    .map_err(LogicError::OfficeImport)?;
    analytics::prewarm_tabular(user_id, &imported);
    Ok(imported)
}

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
pub mod experience;
pub mod onboarding;
// CodeGraph bridge — phase0 sidecar (`codegraph` feature) + phase1 native
// (`codegraph-native` implies `codegraph`; kernel rlib wired when available).
pub mod codegraph;
// TTS via piper-rs (neural Piper ONNX models). Feature-gated internally;
// always compiled so the command stays registered in generate_handler!.
pub mod tts;
pub mod email;
// Local email+password auth (user directory, vault-encoded passwords).
pub mod local_auth;
// QRIS top-up + token-balance worker proxies (PLAN-qris-topup.md Fase 3).
// Pure reqwest — shared by the Tauri commands and the web routes.
pub mod topup;
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
// ── Ask About Step Result ───────────────────────────────────────────────────


/// Ask a follow-up question about a specific supervisor step result.
/// Loads the step result from `supervisor_step_results` (by plan_key + step_id),
/// then executes a 1-step mini-plan with the `explain_step_result` tool.
#[cfg(feature = "litert")]
pub async fn ask_about_step_result(
    user_id: &str,
    session_id: i64,
    plan_key: &str,
    step_id: &str,
    question: &str,
) -> Result<impl Stream<Item = crate::supervisor::SupervisorEvent> + Send, String> {
    use crate::supervisor::{build_registry_from_toolset, execute_plan_stream_with_cancel, supervisor_toolset_with_explainer};
    use kawai_agent::ExplainStepResultArgs;
    use kawai_router::{TaskPlan, TaskStep};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    // 1. Load the step result from supervisor_step_results (user-scoped),
    //    with the session-scope fallback the live read path uses.
    let rows = kawai_db::list_supervisor_step_results(user_id, session_id, plan_key)
        .await
        .map_err(|e| format!("supervisor_step_results read failed: {e}"))?;
    let hit = rows
        .into_iter()
        .rev()
        .find(|r| r.step_id == step_id)
        .map(|r| (r.tool, r.output, r.artifacts_json));
    let hit = if hit.is_some() {
        hit
    } else {
        kawai_db::list_supervisor_step_results_by_session(user_id, session_id, 200)
            .await
            .map_err(|e| format!("supervisor_step_results read failed: {e}"))?
            .into_iter()
            .find(|r| r.step_id == step_id && r.plan_key == plan_key)
            .map(|r| (r.tool, r.output, String::new()))
    };
    let (step_tool_name, step_output, artifacts_json) =
        hit.ok_or_else(|| format!("step result not found: plan_key={plan_key}, step_id={step_id}"))?;

    // The persisted artifacts are typed kawai_router::Artifact values —
    // passed through verbatim as JSON context for the explainer.
    let step_artifacts: Value = serde_json::from_str(&artifacts_json).unwrap_or(Value::Null);

    // 2. Build the 1-step TaskPlan over explain_step_result.
    let plan = TaskPlan {
        goal: format!("Explain step {step_id} result to the user"),
        steps: vec![TaskStep {
            id: "explain".into(),
            agent_id: "builtin.explain".into(),
            task: question.to_string(),
            arguments: serde_json::to_value(ExplainStepResultArgs {
                step_tool: step_tool_name,
                step_args: Value::Null,
                step_output,
                step_artifacts,
                question: question.to_string(),
            })
            .map_err(|e| format!("serialize args failed: {e}"))?,
            depends_on: vec![],
            ..Default::default()
        }],
        final_writer: Some(crate::supervisor::WRITER_RAW.to_string()),
        summary: None,
    };

    // 3. Registry: merged supervisor catalog + the explainer tool.
    let toolset = supervisor_toolset_with_explainer(user_id, session_id)
        .await
        .map_err(|e| e.to_string())?;
    let registry = build_registry_from_toolset(user_id, session_id, toolset, plan_key)
        .await
        .map_err(|e| e.to_string())?;

    // 4. Execute the mini-plan — same scheduler, same event lifecycle.
    let cancel = CancellationToken::new();
    let pending: crate::supervisor::PendingConfirmations =
        Arc::new(std::sync::Mutex::new(HashMap::new()));
    let stream_id = format!(
        "ask-{step_id}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    );

    Ok(execute_plan_stream_with_cancel(
        plan,
        registry,
        cancel,
        pending,
        stream_id,
        user_id.to_string(),
        session_id,
        Some(question.to_string()), // user_goal = the question
        None,                       // internal call — no billing bearer
    ))
}

#[cfg(test)]
mod tests {
    use super::strip_outer_fence;

    #[test]
    fn strip_outer_fence_unwraps_model_wrapper() {
        // Model wrapped its whole answer → the wrapper goes, content stays.
        assert_eq!(
            strip_outer_fence("# Judul", "```markdown\n# Terjemahan\n```"),
            "# Terjemahan"
        );
        // No wrapper → the answer passes through untouched.
        assert_eq!(strip_outer_fence("# Judul", "# Terjemahan"), "# Terjemahan");
    }

    #[test]
    fn strip_outer_fence_never_touches_fence_first_source() {
        // A source that IS fence-first keeps its fences even when the
        // answer mirrors it (the heuristic can't tell wrapper from content).
        let md = "```json\n{}\n```";
        assert_eq!(strip_outer_fence(md, md), md);
        // An unterminated wrapper still loses its opener line.
        assert_eq!(strip_outer_fence("# Judul", "```markdown\n# X"), "# X");
        // A first line carrying inline code is content, not a wrapper.
        let inline = "```js x``` tail";
        assert_eq!(strip_outer_fence("# Judul", inline), inline);
    }

    /// Read-through cache contract: a stored (source-hash, language) row is
    /// served by `translate_deliverable` with ZERO LLM calls — the identity
    /// is the private hash fn itself, so any path that reached the model
    /// instead would come back `Err("translation failed …")`, never the
    /// stored body. The list op reports the same row as one chip, and input
    /// validation precedes cache and model alike.
    #[tokio::test]
    async fn translate_deliverable_serves_stored_row_without_llm() {
        use super::{deliverable_translations, translation_source_hash, translate_deliverable};

        let dir = tempfile::tempdir().unwrap();
        super::db::set_data_root(dir.path());
        // Leaked on purpose — parallel tests share the first-set data root;
        // dropping it mid-run breaks the others (same pattern as kawai-db's).
        std::mem::forget(dir);
        let user = format!(
            "xlate-logic-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let source = "# Laporan\n\nIsi deliverable.";
        let language = "Klingon";
        let stored = "# bogh\n\nDeliverable mu.";
        kawai_db::put_deliverable_translation(
            &user,
            &translation_source_hash(source.trim()),
            language,
            stored,
            None,
        )
        .await
        .unwrap();

        // Cache hit serves the row verbatim — no pool, no vault, no model.
        let out = translate_deliverable(&user, None, source, language)
            .await
            .unwrap();
        assert_eq!(out, stored, "stored translation is served as-is");

        // The chip list reads the same row for the same (trimmed) source.
        let chips = deliverable_translations(&user, source).await.unwrap();
        assert_eq!(chips.len(), 1);
        assert_eq!(chips[0].language, language);

        // Validation runs before cache and model: empty input is refused
        // with a user-facing message, never a phantom row or a model call.
        let empty_source = translate_deliverable(&user, None, "   ", language)
            .await
            .unwrap_err()
            .to_string();
        assert!(empty_source.contains("nothing to translate"), "{empty_source}");
        let empty_lang = translate_deliverable(&user, None, source, "  ")
            .await
            .unwrap_err()
            .to_string();
        assert!(empty_lang.contains("target language required"), "{empty_lang}");
        assert!(deliverable_translations(&user, " ").await.unwrap().is_empty());
    }
}

