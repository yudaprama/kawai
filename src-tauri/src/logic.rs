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
    candidates.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../models")
        .join(filename));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("models").join(filename));
            candidates.push(dir.join("resources").join("models").join(filename));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(std::path::PathBuf::from(home).join(".kawai/models").join(filename));
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
#[cfg(feature = "office")]
pub mod office;
pub mod agent;

pub use db::*;
