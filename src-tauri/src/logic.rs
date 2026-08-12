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
