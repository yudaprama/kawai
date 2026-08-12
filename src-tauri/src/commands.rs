use crate::logic::{self, ActivityEvent, ActivityInput};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

/// Shared registry: active stream id -> cancellation token.
/// Managed as Tauri state so `generate_activity` and `cancel_stream` share it.
pub type StreamRegistry = Arc<Mutex<HashMap<String, CancellationToken>>>;

pub fn new_registry() -> StreamRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn greet(name: String) -> String {
    logic::greet(&name)
}

/// Streaming command. The `stream_id` lets the client request early
/// cancellation via `cancel_stream`. Business args arrive as individual
/// camelCase fields (Tauri default arg mapping); the `Channel` carries events
/// back; `select!` races the next event against the cancellation token.
#[tauri::command]
pub async fn generate_activity(
    events: u64,
    interval_ms: u64,
    stream_id: String,
    on_event: Channel<ActivityEvent>,
    registry: State<'_, StreamRegistry>,
) -> Result<(), String> {
    // Take an owned clone so the `State` borrow ends before any await.
    let registry = Arc::clone(&registry);

    let token = CancellationToken::new();
    registry
        .lock()
        .unwrap()
        .insert(stream_id.clone(), token.clone());

    let input = ActivityInput { events, interval_ms };
    // Box::pin so the (non-Unpin) async_stream supports `.next()`.
    let mut stream = Box::pin(logic::generate_activity(input));
    loop {
        tokio::select! {
            _ = token.cancelled() => break,           // client cancelled
            Some(event) = stream.next() => {
                on_event.send(event).map_err(|e| e.to_string())?;
            }
            else => break,                            // stream ended naturally
        }
    }

    registry.lock().unwrap().remove(&stream_id);
    Ok(())
}

#[tauri::command]
pub fn cancel_stream(stream_id: String, registry: State<'_, StreamRegistry>) {
    if let Some(token) = registry.lock().unwrap().get(&stream_id) {
        token.cancel();
    }
}
