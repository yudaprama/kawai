use crate::auth::{Session, Verifier};
use crate::logic::{
    self, ActivityEvent, ActivityInput, ChatMessage, ChatSession, Note, NoteEvent, UserInfo,
};
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

    let input = ActivityInput {
        events,
        interval_ms,
    };
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
pub async fn create_note(body: String, session: State<'_, Session>) -> Result<Note, String> {
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
/// Channel + cancellation registry), but data comes from local SQLite via `user_id`.
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

/// Authenticated RPC: start a new chat session (agent-ready schema; MVP uses
/// the implicit builtin agent when `agentId` is absent).
#[tauri::command]
pub async fn create_chat_session(
    agent_id: Option<String>,
    session: State<'_, Session>,
) -> Result<ChatSession, String> {
    let user_id = session_user_id(&session)?;
    logic::create_chat_session(&user_id, agent_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: list the user's chat sessions, newest first.
#[tauri::command]
pub async fn list_chat_sessions(session: State<'_, Session>) -> Result<Vec<ChatSession>, String> {
    let user_id = session_user_id(&session)?;
    logic::list_chat_sessions(&user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: list a session's messages, oldest first.
#[tauri::command]
pub async fn list_chat_messages(
    session_id: i64,
    session: State<'_, Session>,
) -> Result<Vec<ChatMessage>, String> {
    let user_id = session_user_id(&session)?;
    logic::list_chat_messages(&user_id, session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: append a message to a session. The first user message
/// seeds the session title.
#[tauri::command]
pub async fn append_chat_message(
    session_id: i64,
    role: String,
    content: String,
    session: State<'_, Session>,
) -> Result<ChatMessage, String> {
    let user_id = session_user_id(&session)?;
    logic::append_chat_message(&user_id, session_id, &role, &content)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: delete a chat session and its messages.
#[tauri::command]
pub async fn delete_chat_session(
    session_id: i64,
    session: State<'_, Session>,
) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    logic::delete_chat_session(&user_id, session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: load an on-device model (`.litertlm`). Identity is
/// resolved at the edge as usual; the engine lives in `logic.rs`. When
/// `model_path` is omitted the backend resolves it via `logic::resolve_model_path`.
#[cfg(feature = "litert")]
#[tauri::command]
pub async fn local_load_model(
    model_path: Option<String>,
    gpu: Option<bool>,
    speculative_decoding: Option<bool>,
    max_num_images: Option<i32>,
    tools_json: Option<String>,
    session: State<'_, Session>,
) -> Result<logic::local_llm::LocalModelInfo, String> {
    let user_id = session_user_id(&session)?;
    let model_path = match model_path {
        Some(p) if !p.is_empty() => p,
        _ => logic::resolve_model_path()?,
    };
    let result = logic::local_llm::load_model(
        &user_id,
        &model_path,
        gpu.unwrap_or(true),
        speculative_decoding.unwrap_or(false),
        max_num_images.unwrap_or(0),
        tools_json,
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

/// Authenticated RPC: get test tool definitions for native function calling.
#[cfg(feature = "litert")]
#[tauri::command]
pub fn local_llm_get_test_tools() -> Result<String, String> {
    Ok(logic::local_llm::get_test_tools_json())
}

/// Authenticated RPC: get rig-components tool definitions for native function calling.
#[cfg(feature = "litert")]
#[tauri::command]
pub fn local_llm_get_rig_tools(tool_names: Vec<String>) -> Result<String, String> {
    let names: Vec<&str> = tool_names.iter().map(|s| s.as_str()).collect();
    Ok(logic::local_llm::get_rig_tools_json(&names))
}

// ── Office document ops (feature "office") ──────────────────────────────────
//
// Thin wrappers over logic::office; identity resolved at the edge as always.
// File content addresses are opaque ids — never paths (except import's
// sourcePath, the one sanctioned way in).

/// Authenticated RPC: import a file into the office store — either from an
/// absolute path (desktop picker/drag-drop) or as base64 (webview blob).
#[cfg(feature = "office")]
#[tauri::command]
pub fn office_import_file(
    source_path: Option<String>,
    name: Option<String>,
    data_base64: Option<String>,
    session: State<'_, Session>,
) -> Result<logic::office::OfficeFile, String> {
    let user_id = session_user_id(&session)?;
    match (
        source_path.as_deref(),
        (name.as_deref(), data_base64.as_deref()),
    ) {
        (Some(src), _) => logic::office::import_path(&user_id, src),
        (None, (Some(name), Some(data))) => logic::office::import_base64(&user_id, name, data),
        _ => Err("provide sourcePath, or name + dataBase64".into()),
    }
}

/// Authenticated RPC: list the user's stored office files.
#[cfg(feature = "office")]
#[tauri::command]
pub fn office_list_files(
    session: State<'_, Session>,
) -> Result<Vec<logic::office::OfficeFile>, String> {
    let user_id = session_user_id(&session)?;
    logic::office::list_files(&user_id)
}

/// Authenticated RPC: read a stored document as markdown (ooxcli extract).
#[cfg(feature = "office")]
#[tauri::command]
pub async fn office_read_document(
    file_id: String,
    session: State<'_, Session>,
) -> Result<logic::office::ReadDocumentResult, String> {
    let user_id = session_user_id(&session)?;
    let markdown = logic::office::read_document(&user_id, &file_id).await?;
    Ok(logic::office::ReadDocumentResult { markdown })
}

/// Authenticated RPC: extract stored documents into a prompt-injectable
/// context block (composer @-mention knowledge).
#[cfg(feature = "office")]
#[tauri::command]
pub async fn knowledge_context(
    file_ids: Vec<String>,
    session: State<'_, Session>,
) -> Result<logic::office::KnowledgeContext, String> {
    let user_id = session_user_id(&session)?;
    logic::office::knowledge_context(&user_id, &file_ids)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: index a stored office file into the user's vector store
/// (upload-time RAG preprocessing) and associate it with the uploading
/// session. Fire-and-forget from the files panel.
#[cfg(feature = "office")]
#[tauri::command]
pub async fn office_index_file(
    session_id: Option<i64>,
    file_id: String,
    session: State<'_, Session>,
) -> Result<usize, String> {
    let user_id = session_user_id(&session)?;
    logic::rag::office_index_file(user_id, session_id, file_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: hybrid vector+BM25 search over the documents a session
/// uploaded. Kept for the web transport / debugging; the agent reaches the
/// same logic through its `knowledge_search` tool (session bound server-side).
#[cfg(feature = "office")]
#[tauri::command]
pub async fn knowledge_search(
    session_id: i64,
    query: String,
    mode: Option<logic::rag::SearchMode>,
    session: State<'_, Session>,
) -> Result<Vec<logic::rag::RagHit>, String> {
    let user_id = session_user_id(&session)?;
    logic::rag::knowledge_search(user_id, session_id, query, mode)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: remove the session's association with the given files
/// and purge chunks of files no session references anymore.
#[cfg(feature = "office")]
#[tauri::command]
pub async fn knowledge_forget(
    session_id: Option<i64>,
    file_ids: Vec<String>,
    session: State<'_, Session>,
) -> Result<usize, String> {
    let user_id = session_user_id(&session)?;
    logic::rag::forget_file(user_id, session_id, file_ids)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: list the files associated with a session (the files
/// panel's "In this session" section).
#[cfg(feature = "office")]
#[tauri::command]
pub async fn list_session_files(
    session_id: i64,
    session: State<'_, Session>,
) -> Result<Vec<logic::office::OfficeFile>, String> {
    let user_id = session_user_id(&session)?;
    logic::rag::list_session_files(&user_id, session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: the knowledge panel's single list — office files with
/// RAG index status and active-session association.
#[cfg(feature = "office")]
#[tauri::command]
pub async fn knowledge_list(
    session_id: Option<i64>,
    session: State<'_, Session>,
) -> Result<Vec<logic::rag::KnowledgeFileInfo>, String> {
    let user_id = session_user_id(&session)?;
    logic::rag::knowledge_list(&user_id, session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: add library documents to the active session so the
/// agent can search them (indexing any file that has no chunks yet).
#[cfg(feature = "office")]
#[tauri::command]
pub async fn knowledge_add_to_session(
    session_id: i64,
    file_ids: Vec<String>,
    session: State<'_, Session>,
) -> Result<usize, String> {
    let user_id = session_user_id(&session)?;
    logic::rag::knowledge_add_to_session(&user_id, session_id, &file_ids)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: ingest a YouTube video into the knowledge base
/// (transcript → markdown document → indexed; deduped per video).
#[cfg(feature = "office")]
#[tauri::command]
pub async fn knowledge_import_youtube(
    url: String,
    session_id: Option<i64>,
    session: State<'_, Session>,
) -> Result<logic::office::OfficeFile, String> {
    let user_id = session_user_id(&session)?;
    logic::rag::knowledge_import_youtube(&user_id, session_id, &url)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: delete a stored document plus everything indexed from
/// it (chunks, vectors, session associations).
#[cfg(feature = "office")]
#[tauri::command]
pub async fn office_delete_file(
    file_id: String,
    session: State<'_, Session>,
) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    logic::rag::office_delete_file(&user_id, &file_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: export a stored file to the filesystem.
#[cfg(feature = "office")]
#[tauri::command]
pub fn office_export_file(
    file_id: String,
    dest_path: Option<String>,
    session: State<'_, Session>,
) -> Result<String, String> {
    let user_id = session_user_id(&session)?;
    logic::office::export_file(&user_id, &file_id, dest_path.as_deref())
}

/// Authenticated RPC: which office engines are available on this host.
#[cfg(feature = "office")]
#[tauri::command]
pub fn office_capabilities(
    session: State<'_, Session>,
) -> Result<logic::office::OfficeCapabilities, String> {
    let _ = session_user_id(&session)?;
    Ok(logic::office::capabilities())
}

/// Authenticated streaming: agent chat (prompt-based tool calling on the
/// on-device model). Tool chatter arrives as toolCall/toolResult events; only
/// the final answer is persisted. Same stream_id + Channel + cancellation
/// registry pattern as local_chat.
#[cfg(feature = "litert")]
#[tauri::command]
pub async fn agent_chat(
    agent_id: String,
    session_id: Option<i64>,
    message: String,
    stream_id: String,
    on_event: Channel<logic::agent::AgentChatEvent>,
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

    let mut stream = Box::pin(logic::agent::agent_chat(
        user_id, agent_id, session_id, message,
    ));
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
