use crate::auth::{Session, Verifier};
use crate::logic::{self, ActivityEvent, ActivityInput, Note, NoteEvent, UserInfo};
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

/// Frontend error sink: JS error/rejection/console hooks land here and are
/// appended to the kawai log file (see `logging.rs` for the location).
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    crate::logging::write(&level, &message);
}

/// Verify a JWT and store the resulting identity in `State<Session>`.
/// The frontend never sends `user_id`; identity is resolved here, at the edge.
#[tauri::command]
pub async fn set_session(
    token: String,
    verifier: State<'_, Verifier>,
    session: State<'_, Session>,
) -> Result<UserInfo, String> {
    let claims = verifier.verify(&token).await.map_err(|e| e.to_string())?;
    let user_id = claims.sub.clone();
    *session.write().unwrap() = Some(claims);
    Ok(logic::whoami(&user_id))
}

#[tauri::command]
pub fn logout(session: State<'_, Session>) {
    *session.write().unwrap() = None;
}

/// Requires an active session. Demonstrates the auth-required pattern: the
/// wrapper resolves identity, `logic.rs` receives `user_id`.
#[tauri::command]
pub fn whoami(session: State<'_, Session>) -> Result<UserInfo, String> {
    session
        .read()
        .unwrap()
        .clone()
        .map(|c| logic::whoami(&c.sub))
        .ok_or_else(|| "not authenticated".to_string())
}

/// Pull the authenticated user id from the in-process session (desktop/mobile).
/// The web twin reads identity from the `Extension<Claims>` the middleware injects.
fn session_user_id(session: &Session) -> Result<String, String> {
    session
        .read()
        .unwrap()
        .clone()
        .map(|c| c.sub)
        .ok_or_else(|| "not authenticated".to_string())
}

/// Authenticated RPC: create a note scoped to the signed-in user.
#[tauri::command]
pub async fn create_note(
    body: String,
    session: State<'_, Session>,
) -> Result<Note, String> {
    let user_id = session_user_id(&session)?;
    logic::create_note(&user_id, &body)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: list the signed-in user's notes.
#[tauri::command]
pub async fn list_notes(session: State<'_, Session>) -> Result<Vec<Note>, String> {
    let user_id = session_user_id(&session)?;
    logic::list_notes(&user_id).await.map_err(|e| e.to_string())
}

/// Authenticated streaming: same pattern as `generate_activity` (stream_id +
/// Channel + cancellation registry), but data comes from sqld via `user_id`.
#[tauri::command]
pub async fn stream_notes(
    stream_id: String,
    on_event: Channel<NoteEvent>,
    registry: State<'_, StreamRegistry>,
    session: State<'_, Session>,
) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    // Take an owned clone so the `State` borrow ends before any await.
    let registry = Arc::clone(&registry);

    let token = CancellationToken::new();
    registry
        .lock()
        .unwrap()
        .insert(stream_id.clone(), token.clone());

    let mut stream = Box::pin(logic::stream_notes(user_id));
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            Some(event) = stream.next() => {
                on_event.send(event).map_err(|e| e.to_string())?;
            }
            else => break,
        }
    }

    registry.lock().unwrap().remove(&stream_id);
    Ok(())
}

/// Authenticated RPC: load an on-device model (`.litertlm`). Identity is
/// resolved at the edge as usual; the engine lives in `logic.rs`.
#[cfg(feature = "litert")]
#[tauri::command]
pub async fn local_load_model(
    model_path: String,
    gpu: Option<bool>,
    speculative_decoding: Option<bool>,
    max_num_images: Option<i32>,
    session: State<'_, Session>,
) -> Result<logic::local_llm::LocalModelInfo, String> {
    let user_id = session_user_id(&session)?;
    let result = logic::local_llm::load_model(
        &user_id,
        &model_path,
        gpu.unwrap_or(true),
        speculative_decoding.unwrap_or(false),
        max_num_images.unwrap_or(0),
    )
    .await;
    if let Err(e) = &result {
        eprintln!("[local_load_model] {e}");
    }
    result
}

/// Authenticated streaming: on-device chat. Same stream_id + Channel +
/// cancellation registry pattern as `stream_notes`; tokens come from the
/// LiteRT-LM C callback running on the blocking pool.
#[cfg(feature = "litert")]
#[tauri::command]
pub async fn local_chat(
    prompt: String,
    image: Option<String>,
    audio: Option<String>,
    stream_id: String,
    on_event: Channel<logic::local_llm::LocalChatEvent>,
    registry: State<'_, StreamRegistry>,
    session: State<'_, Session>,
) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    let registry = Arc::clone(&registry);

    let token = CancellationToken::new();
    registry
        .lock()
        .unwrap()
        .insert(stream_id.clone(), token.clone());

    let mut stream = Box::pin(logic::local_llm::local_chat(user_id, prompt, image, audio));
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            Some(event) = stream.next() => {
                on_event.send(event).map_err(|e| e.to_string())?;
            }
            else => break,
        }
    }

    registry.lock().unwrap().remove(&stream_id);
    Ok(())
}

/// Authenticated RPC: reset the conversation history (fresh chat, same model).
#[cfg(feature = "litert")]
#[tauri::command]
pub async fn local_llm_reset(session: State<'_, Session>) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    logic::local_llm::reset_conversation(&user_id).await
}

/// Authenticated RPC: enable or disable thinking mode for subsequent chats.
#[cfg(feature = "litert")]
#[tauri::command]
pub fn local_llm_set_thinking(session: State<'_, Session>, enabled: bool) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    logic::local_llm::set_thinking(&user_id, enabled);
    Ok(())
}

/// Authenticated RPC: unload the model and free all resources.
#[cfg(feature = "litert")]
#[tauri::command]
pub async fn local_llm_unload(session: State<'_, Session>) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    logic::local_llm::unload_model(&user_id).await
}
