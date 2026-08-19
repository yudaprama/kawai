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

/// Resolve the on-device model path. Priority:
///   1. `KAWAI_MODEL_PATH` env var
///   2. `./models/gemma-4-E2B-it.litertlm` (development cwd)
///   3. `~/.kawai/models/gemma-4-E2B-it.litertlm` (user home)
pub fn resolve_model_path() -> Result<String, String> {
    let filename = "gemma-4-E2B-it.litertlm";
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("KAWAI_MODEL_PATH") {
        if !path.is_empty() {
            candidates.push(std::path::PathBuf::from(path));
        }
    }
    candidates.push(std::path::PathBuf::from("./models").join(filename));
    candidates.push(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../models")
            .join(filename),
    );
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("models").join(filename));
            candidates.push(dir.join("resources").join("models").join(filename));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(
            std::path::PathBuf::from(home)
                .join(".kawai/models")
                .join(filename),
        );
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| format!(
            "model not found: set KAWAI_MODEL_PATH or install {filename} in the app resources or ~/.kawai/models/"
        ))
}

// Database (local SQLite), notes and chat-session persistence live in `db`; the
// on-device LLM in `local_llm`; office tooling in `office`; the prompt-based
// tool-calling agent loop in `agent`. Re-exported so `logic::X` paths used by
// the wrappers stay stable across the split.
pub mod db;
#[cfg(feature = "litert")]
pub use local_llm;
pub mod agent;
#[cfg(feature = "office")]
pub mod office;
#[cfg(feature = "office")]
pub mod rag;

pub use db::*;

/// Generate a concise session title with a remote LLM (Cloudflare Workers AI,
/// gated behind the `cloudflare_title` feature). The first user message is the
/// input; the result overwrites the offline substr fallback set by
/// `append_chat_message`. Safe to call fire-and-forget: any failure is logged
/// and the existing title is left untouched.
#[cfg(feature = "cloudflare_title")]
pub async fn generate_session_title(user_id: &str, session_id: i64) -> Result<(), DbError> {
    use rig::client::CompletionClient;
    use rig::completion::CompletionModel;
    use rig::completion::message::{AssistantContent, Text};

    let conn = db_connection(user_id).await?;

    // First user message of the session is the title source.
    let mut rows = conn
        .query(
            "SELECT content FROM messages WHERE session_id = ? AND role = 'user' \
             ORDER BY id ASC LIMIT 1",
            vec![session_id],
        )
        .await?;
    let first: String = match rows.next().await? {
        Some(r) => r.get(0)?,
        None => return Ok(()),
    };
    if first.trim().is_empty() {
        return Ok(());
    }

    let client = cloudflare::CloudflareClient::from_env()
        .map_err(|e| DbError::Config(format!("cloudflare client: {e}")))?;
    let model = client.completion_model(cloudflare::models::GRANITE_4_0_H_MICRO);

    let prompt = format!(
        "Write a short chat session title (max 6 words, no punctuation, no quotes). \
         Reply with only the title.\n\nConversation start: {}",
        first
    );
    let request = model
        .completion_request(prompt)
        .temperature(0.2)
        .max_tokens(24)
        .build();
    let response = model
        .completion(request)
        .await
        .map_err(|e| DbError::Config(format!("cloudflare completion: {e}")))?;

    let raw = response
        .choice
        .iter()
        .find_map(|p| match p {
            AssistantContent::Text(Text { text, .. }) => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_default();

    let title: String = raw
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '#')
        .chars()
        .take(SESSION_TITLE_MAX_CHARS)
        .collect();

    if !title.is_empty() {
        conn.execute(
            "UPDATE sessions SET title = ? WHERE id = ?",
            (title, session_id),
        )
        .await?;
    }
    Ok(())
}
