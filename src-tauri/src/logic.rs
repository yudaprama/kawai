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
