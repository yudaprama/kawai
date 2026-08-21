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
///   2. `./models/gemma-4-E4B-it.litertlm` (development cwd)
///   3. `~/.kawai/models/gemma-4-E4B-it.litertlm` (user home)
pub fn resolve_model_path() -> Result<String, String> {
    let filename = "gemma-4-E4B-it.litertlm";
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

// Database (local SQLite), chat-session persistence lives in `db`; the
// on-device LLM in `local_llm`; office tooling in `office`; the prompt-based
// tool-calling agent loop in `agent`; the cloud subagent client (hybrid LLM
// tier) in `remote`. Re-exported so `logic::X` paths used by the wrappers stay
// stable across the split.
pub mod db;
pub mod db_migrations;
#[cfg(feature = "litert")]
pub use local_llm;
pub mod agent;
pub mod remote;
#[cfg(feature = "office")]
pub mod office;
#[cfg(feature = "office")]
pub mod rag;

pub use db::*;

/// Generate a concise session title with a remote LLM (Cloudflare Workers AI).
/// Uses a custom request/response to avoid rig's strict OpenAI-compatible
/// deserialization which Cloudflare's Workers AI doesn't fully match.
/// The first user message is the input; the result overwrites the offline substr
/// fallback set by `append_chat_message`. Safe to call fire-and-forget: any
/// failure is logged and the existing title is left untouched.
pub async fn generate_session_title(user_id: &str, session_id: i64) -> Result<(), DbError> {
    use reqwest::Client;

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

    // Vault Workers AI credentials.
    let (account_id, api_key) =
        kawai_constants::cloudflare::get_cf_workers_ai_account_id_and_key();
    if account_id.is_empty() || api_key.is_empty() {
        eprintln!("[generate_session_title] kawai-vault workers-ai credentials empty — keeping offline title");
        return Ok(());
    }
    let base_url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/ai/v1/chat/completions",
        account_id
    );

    let client = Client::new();
    let request_body = CloudflareRequest {
        model: CloudflareModel::Granite4HMicro,
        messages: vec![CloudflareMessage {
            role: CloudflareRole::User,
            content: format!(
                "Write a short chat session title (max 6 words, no punctuation, no quotes). \
                 Reply with only the title.\n\nConversation start: {}",
                first
            ),
        }],
        raw: false,
        temperature: 0.2,
        max_tokens: 24,
    };

    let response: CloudflareResponse = client
        .post(&base_url)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| DbError::Config(format!("cloudflare request: {e}")))?
        .json()
        .await
        .map_err(|e| DbError::Config(format!("cloudflare json: {e}")))?;

    let raw = response
        .choices
        .first()
        .and_then(|c| c.message.content.clone())
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

#[derive(Serialize)]
struct CloudflareRequest {
    model: CloudflareModel,
    messages: Vec<CloudflareMessage>,
    #[serde(default)]
    raw: bool,
    #[serde(default)]
    temperature: f32,
    #[serde(default)]
    max_tokens: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum CloudflareModel {
    #[serde(rename = "@cf/ibm-granite/granite-4.0-h-micro")]
    Granite4HMicro,
}

#[derive(Serialize)]
struct CloudflareMessage {
    role: CloudflareRole,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum CloudflareRole {
    User,
    Assistant,
}

#[derive(Deserialize, Clone)]
struct CloudflareResponse {
    choices: Vec<CloudflareChoice>,
}

#[derive(Deserialize, Clone)]
struct CloudflareChoice {
    message: CloudflareChoiceMessage,
}

#[derive(Deserialize, Clone)]
struct CloudflareChoiceMessage {
    content: Option<String>,
}
