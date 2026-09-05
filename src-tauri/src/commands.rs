use crate::auth::Session;
use crate::logic::{self, ActivityEvent, ActivityInput, ChatMessage, ChatSession, UserInfo};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

/// Shared registry: active stream id -> cancellation token.
/// Managed as Tauri state so `generate_activity` and `cancel_stream` share it.
pub type StreamRegistry = Arc<Mutex<HashMap<String, CancellationToken>>>;

pub fn new_registry() -> StreamRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

/// RAII guard that removes a stream entry from the registry on drop.
/// Prevents stale cancellation tokens after early returns (e.g. channel send errors).
struct StreamGuard {
    registry: StreamRegistry,
    stream_id: String,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.registry.lock() {
            map.remove(&self.stream_id);
        }
    }
}

fn register_stream(
    registry: &StreamRegistry,
    stream_id: &str,
    token: CancellationToken,
) -> StreamGuard {
    registry
        .lock()
        .unwrap()
        .insert(stream_id.to_string(), token);
    StreamGuard {
        registry: Arc::clone(registry),
        stream_id: stream_id.to_string(),
    }
}

#[tauri::command]
pub fn greet(name: String) -> String {
    logic::greet(&name)
}

/// Public RPC: the agent catalog (id, name, description, tools) in UI order.
/// Static data — no user scope, so no auth state.
#[tauri::command]
pub fn list_agents() -> Vec<crate::agent_registry::AgentInfo> {
    crate::agent_registry::builtin().list()
}

/// Public RPC: client-side email verification — generate a 6-digit code and
/// email it via the Brevo SMTP relay. Returns the code so the frontend can
/// check the user's input locally (the auth server is never involved).
#[tauri::command]
pub async fn send_verification_email(to: String) -> Result<String, String> {
    logic::email::send_verification_email(&to).await
}

/// Public RPC: native MON balance for an EVM address on Monad (`monad`
/// feature). Chain data is public — no auth scope. Always registered; the
/// logic shim serves a guidance error when the feature is off.
#[tauri::command]
pub async fn check_monad_balance(
    wallet_address: String,
    rpc_url: Option<String>,
) -> Result<logic::monad::BalanceInfo, String> {
    logic::monad::check_balance(rpc_url.as_deref(), &wallet_address).await
}

/// Public RPC: Monad chain status probe (block height + chain id).
#[tauri::command]
pub async fn monad_chain_status(rpc_url: Option<String>) -> Result<logic::monad::ChainStatus, String> {
    logic::monad::chain_status(rpc_url.as_deref()).await
}

// ── Device-scoped Monad hot wallet (PUBLIC ops — the wallet exists before
//    any session: it IS what creates the identity via SIWE login). Key lives
//    in the OS keychain, never crosses to the frontend. ──

/// Load the device wallet's address, if one exists.
#[tauri::command]
pub async fn monad_wallet_address() -> Result<Option<logic::monad_wallet::WalletAddress>, String> {
    logic::monad_wallet::address()
}

/// Create the device hot wallet (idempotent). Returns ONLY the address —
/// the private key stays in the OS keychain inside the backend process.
#[tauri::command]
pub async fn monad_wallet_create() -> Result<logic::monad_wallet::WalletAddress, String> {
    logic::monad_wallet::create()
}

/// EIP-191 personal-sign `message` with the device wallet's stored key.
#[tauri::command]
pub async fn monad_wallet_sign_message(message: String) -> Result<String, String> {
    logic::monad_wallet::sign_message(&message).await
}

/// Permanently delete the stored key (address + funds unrecoverable locally).
#[tauri::command]
pub async fn monad_wallet_delete() -> Result<(), String> {
    logic::monad_wallet::delete()
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
    let _guard = register_stream(&registry, &stream_id, token.clone());

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

    Ok(())
}

#[tauri::command]
pub fn cancel_stream(stream_id: String, registry: State<'_, StreamRegistry>) {
    if let Ok(map) = registry.lock() {
        if let Some(token) = map.get(&stream_id) {
            token.cancel();
        }
    }
}

/// Frontend error sink: JS error/rejection/console hooks land here and are
/// appended to the kawai log file (see `logging.rs` for the location).
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    crate::logging::write(&level, &message);
}

/// Public RPC: register a new local account. Fails when the email is already
/// in the user directory (or its per-user data dir exists). Sends a welcome
/// email (best-effort). On success the session is established immediately —
/// in-memory only, so a signed-in user must sign in again after a restart.
#[tauri::command]
pub async fn auth_sign_up(
    email: String,
    password: String,
    session: State<'_, Session>,
) -> Result<UserInfo, String> {
    let user = logic::local_auth::auth_sign_up(&email, &password).await?;
    establish_local_session(&user.email, session)
}

/// Public RPC: email a 6-digit sign-up verification code to `email`.
#[tauri::command]
pub async fn auth_send_code(email: String) -> Result<(), String> {
    logic::email::send_sign_up_code(&email).await
}

/// Public RPC: check the sign-up code the user received by email.
#[tauri::command]
pub fn auth_verify_code(email: String, code: String) -> Result<(), String> {
    if logic::email::verify_sign_up_code(&email, &code) {
        Ok(())
    } else {
        Err("verification code is invalid or expired".into())
    }
}

/// Public RPC: sign in with email+password (local user directory) and
/// establish the session directly.
#[tauri::command]
pub async fn auth_sign_in(
    email: String,
    password: String,
    session: State<'_, Session>,
) -> Result<UserInfo, String> {
    let user = logic::local_auth::auth_sign_in(&email, &password).await?;
    establish_local_session(&user.email, session)
}

/// Set the in-memory session to a signed-in email (the identity).
fn establish_local_session(email: &str, session: State<'_, Session>) -> Result<UserInfo, String> {
    *session
        .write()
        .map_err(|_| "session state unavailable (lock poisoned)".to_string())? =
        Some(email.to_string());
    Ok(logic::whoami(email))
}

/// Clear the in-memory session and remove the persisted worker token.
#[tauri::command]
pub fn logout(session: State<'_, Session>) {
    if let Ok(mut guard) = session.write() {
        if let Some(email) = guard.take() {
            let path = kawai_paths::user_data_dir(&email).join("auth.token");
            let _ = std::fs::remove_file(path);
        }
    }
    // Drop the restore pointer too — the next launch shows the login screen.
    let _ = std::fs::remove_file(kawai_paths::data_root().join("last_session"));
}

/// Requires an active session. Demonstrates the auth-required pattern: the
/// wrapper resolves identity, `logic.rs` receives `user_id`.
#[tauri::command]
pub fn whoami(session: State<'_, Session>) -> Result<UserInfo, String> {
    let guard = session
        .read()
        .map_err(|_| "session state unavailable (lock poisoned)".to_string())?;
    guard
        .clone()
        .map(|uid| logic::whoami(&uid))
        .ok_or_else(|| "not authenticated".to_string())
}

/// Pull the authenticated user id from the in-process session (desktop/mobile).
/// The web twin reads identity from the `Extension<String>` the middleware injects.
fn session_user_id(session: &Session) -> Result<String, String> {
    let guard = session
        .read()
        .map_err(|_| "session state unavailable (lock poisoned)".to_string())?;
    guard
        .clone()
        .ok_or_else(|| "not authenticated".to_string())
}

/// Authenticated RPC: start a new chat session. Sessions are created lazily
/// on the first message; no agent identity — supervisor runs in `auto` mode.
#[tauri::command]
pub async fn create_chat_session(session: State<'_, Session>) -> Result<ChatSession, String> {
    let user_id = session_user_id(&session)?;
    logic::create_chat_session(&user_id).await.map_err(|e| e.to_string())
}

/// Authenticated RPC: list the user's chat sessions, newest first. Defaults to
/// the active (non-archived) sidebar list; pass `archived: true` for the
/// archive view.
#[tauri::command]
pub async fn list_chat_sessions(
    archived: Option<bool>,
    session: State<'_, Session>,
) -> Result<Vec<ChatSession>, String> {
    let user_id = session_user_id(&session)?;
    logic::list_chat_sessions(&user_id, archived.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: rename a session (sidebar inline rename).
#[tauri::command]
pub async fn rename_chat_session(
    session_id: i64,
    title: String,
    session: State<'_, Session>,
) -> Result<ChatSession, String> {
    let user_id = session_user_id(&session)?;
    logic::rename_chat_session(&user_id, session_id, &title)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: archive or restore a session.
#[tauri::command]
pub async fn set_chat_session_archived(
    session_id: i64,
    archived: bool,
    session: State<'_, Session>,
) -> Result<ChatSession, String> {
    let user_id = session_user_id(&session)?;
    logic::set_chat_session_archived(&user_id, session_id, archived)
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

// ── Skills (ungated; plain libsql CRUD) ────────────────────────────────────

/// Authenticated RPC: create a skill (SKILL.md body stored verbatim).
#[tauri::command]
pub async fn skill_create(
    name: String,
    description: Option<String>,
    content: String,
    session: State<'_, Session>,
) -> Result<logic::skills::Skill, String> {
    let user_id = session_user_id(&session)?;
    logic::skills::skill_create(
        &user_id,
        &name,
        description.as_deref().unwrap_or(""),
        &content,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Authenticated RPC: list skills (summaries, newest-updated first).
#[tauri::command]
pub async fn skill_list(
    session: State<'_, Session>,
) -> Result<Vec<logic::skills::SkillSummary>, String> {
    let user_id = session_user_id(&session)?;
    logic::skills::skill_list(&user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: fetch one skill including its body; None → null.
#[tauri::command]
pub async fn skill_get(
    skill_id: String,
    session: State<'_, Session>,
) -> Result<Option<logic::skills::Skill>, String> {
    let user_id = session_user_id(&session)?;
    logic::skills::skill_get(&user_id, &skill_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: update any subset of name/description/content;
/// bumps the version. None for unknown ids.
#[tauri::command]
pub async fn skill_update(
    skill_id: String,
    name: Option<String>,
    description: Option<String>,
    content: Option<String>,
    session: State<'_, Session>,
) -> Result<Option<logic::skills::Skill>, String> {
    let user_id = session_user_id(&session)?;
    logic::skills::skill_update(
        &user_id,
        &skill_id,
        name.as_deref(),
        description.as_deref(),
        content.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Authenticated RPC: delete a skill; returns whether a row was removed.
#[tauri::command]
pub async fn skill_delete(skill_id: String, session: State<'_, Session>) -> Result<bool, String> {
    let user_id = session_user_id(&session)?;
    logic::skills::skill_delete(&user_id, &skill_id)
        .await
        .map_err(|e| e.to_string())
}

// ── L1 memories (ungated CRUD; extraction uses the hybrid cloud tier) ──────

/// Authenticated RPC: create a memory item manually.
#[tauri::command]
pub async fn memory_create(
    kind: String,
    title: String,
    content: String,
    session: State<'_, Session>,
) -> Result<logic::memory::MemoryItem, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_create(&user_id, &kind, &title, &content)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: list all memories, newest-updated first.
#[tauri::command]
pub async fn memory_list(
    session: State<'_, Session>,
) -> Result<Vec<logic::memory::MemoryItem>, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_list(&user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: update a memory's kind/title/content (any subset).
#[tauri::command]
pub async fn memory_update(
    memory_id: String,
    kind: Option<String>,
    title: Option<String>,
    content: Option<String>,
    session: State<'_, Session>,
) -> Result<Option<logic::memory::MemoryItem>, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_update(
        &user_id,
        &memory_id,
        kind.as_deref(),
        title.as_deref(),
        content.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Authenticated RPC: delete a memory; returns whether a row was removed.
#[tauri::command]
pub async fn memory_delete(memory_id: String, session: State<'_, Session>) -> Result<bool, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_delete(&user_id, &memory_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: extract memories from a session's transcript via the
/// cloud tier (needs the hybrid vault); dedups and stores the results.
#[tauri::command]
pub async fn memory_extract(
    session_id: i64,
    session: State<'_, Session>,
) -> Result<Vec<logic::memory::MemoryItem>, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_extract(&user_id, session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: search memories by semantic similarity (hybrid:
/// vector cosine + BM25 via RRF fusion). Falls back to newest-first
/// when the embedding provider is unavailable.
#[tauri::command]
pub async fn memory_search(
    query: String,
    limit: Option<usize>,
    session: State<'_, Session>,
) -> Result<Vec<logic::memory::MemoryItem>, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_search(&user_id, &query, limit)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: merge redundant memories (embedding clustering +
/// cloud LLM merge; needs the hybrid vault).
#[tauri::command]
pub async fn memory_consolidate(
    session: State<'_, Session>,
) -> Result<logic::memory::ConsolidationReport, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_consolidate(&user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: entity-graph lookup — extract entities from the query,
/// match stored memory entities, return each with its mentioning memories.
#[tauri::command]
pub async fn memory_graph_search(
    query: String,
    limit: Option<usize>,
    session: State<'_, Session>,
) -> Result<Vec<logic::memory::MemoryGraphHit>, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_graph_search(&user_id, &query, limit)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: export the whole entity-memory graph for the UI
/// visualization (memories newest-first + their entities + mention edges).
#[tauri::command]
pub async fn memory_graph_export(
    limit: Option<usize>,
    session: State<'_, Session>,
) -> Result<logic::memory::MemoryGraphExport, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_graph_export(&user_id, limit)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: regenerate ALL L2 scenes (embedding clustering + cloud
/// LLM naming; needs the hybrid vault). Replace-all semantics.
#[tauri::command]
pub async fn memory_scene_extract(
    session: State<'_, Session>,
) -> Result<Vec<logic::memory::SceneHit>, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_scene_extract(&user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: list stored L2 scenes with their member memories.
#[tauri::command]
pub async fn memory_scene_list(
    session: State<'_, Session>,
) -> Result<Vec<logic::memory::SceneHit>, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_scene_list(&user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: (re)generate the L3 persona from all memories via the
/// cloud tier; returns the persona text.
#[tauri::command]
pub async fn memory_persona_generate(
    session: State<'_, Session>,
) -> Result<String, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_persona_generate(&user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: the stored L3 persona text, if any.
#[tauri::command]
pub async fn memory_persona_get(session: State<'_, Session>) -> Result<Option<String>, String> {
    let user_id = session_user_id(&session)?;
    logic::memory::memory_persona_get(&user_id)
        .await
        .map_err(|e| e.to_string())
}

/// Authenticated RPC: regenerate a session title via Cloudflare Workers AI
/// (3-6 words from the session's goal + final output). Fire-and-forget on the
/// client; the offline substr title stays on failure.
#[tauri::command]
pub async fn generate_session_title(
    session_id: i64,
    session: State<'_, Session>,
) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    logic::generate_session_title(&user_id, session_id)
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
        _ => {
            // Try local candidates first, then download from HuggingFace Hub.
            match logic::resolve_model_path() {
                Ok(p) => p,
                Err(_) => logic::ensure_model().await?,
            }
        }
    };
    let result = logic::local_llm::load_model(
        &user_id,
        &model_path,
        gpu.unwrap_or(true),
        speculative_decoding.unwrap_or(false),
        max_num_images.unwrap_or(1),
        tools_json,
    )
    .await;
    if let Err(e) = &result {
        eprintln!("[local_load_model] {e}");
    }
    result
}

/// Authenticated RPC: return the current on-device model status.
#[cfg(feature = "litert")]
#[tauri::command]
pub async fn local_model_status(
    session: State<'_, Session>,
) -> Result<logic::local_llm::LocalModelStatus, String> {
    let _user_id = session_user_id(&session)?;
    Ok(logic::local_model_status())
}

/// Authenticated streaming: on-device chat. Same stream_id + Channel +
/// cancellation registry pattern as `generate_activity`; tokens come from the
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
    let _guard = register_stream(&registry, &stream_id, token.clone());

    let mut stream = Box::pin(logic::local_llm::local_chat(user_id, prompt, image, audio, true));
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            Some(event) = stream.next() => {
                on_event.send(event).map_err(|e| e.to_string())?;
            }
            else => break,
        }
    }

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

/// Authenticated RPC: get crates tool definitions for native function calling.
#[cfg(feature = "litert")]
#[tauri::command]
#[allow(dead_code)]
pub fn local_llm_get_rig_tools(tool_names: Vec<String>) -> Result<String, String> {
    let names: Vec<&str> = tool_names.iter().map(|s| s.as_str()).collect();
    Ok(logic::local_llm::get_agent_tools_json(&names))
}

// ── Office document ops (feature "office") ──────────────────────────────────
//
// Thin wrappers over logic::office; identity resolved at the edge as always.
// File content addresses are opaque ids — never paths (except import's
// sourcePath, the one sanctioned way in).

/// Authenticated RPC: import a file into the office store — either from an
/// absolute path (desktop picker/drag-drop) or as base64 (webview blob).
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

/// Interim usage billing (per-turn flat fee, honor system — docs
/// BALANCE-KV-ARCHITECTURE.md §8). Dormant under local auth: no Supabase
/// session token is held anymore, so billing always skips (fail-open).
#[tauri::command]
pub async fn bill_turn() -> Result<kawai_billing::BillOutcome, String> {
    Ok(kawai_billing::BillOutcome::Skipped)
}

/// Authenticated RPC: create and validate a deterministic supervisor plan.
#[cfg(feature = "litert")]
#[tauri::command]
pub async fn plan_task(
    goal: String,
    session_id: i64,
    agent_id: String,
        session: State<'_, Session>,
) -> Result<kawai_router::TaskPlan, String> {
    let user_id = session_user_id(&session)?;
    if !kawai_db::session_exists(&user_id, session_id).await.map_err(|e| e.to_string())? {
        return Err(format!("session {session_id} not found"));
    }
    let registry = crate::supervisor::build_supervisor_registry(
        &user_id, session_id, &agent_id,
    ).await.ok_or_else(|| "supervisor toolset unavailable".to_string())?;
    let (plan, usage) = crate::supervisor::plan_task(&user_id, &goal, &registry)
        .await
        .map_err(|e| {
            // Planner failures are otherwise invisible — the loop's only log
            // line is the per-round `served by` (see supervisor.rs).
            eprintln!("[plan_task] failed for user={user_id}: {e}");
            e
        })?;

    // Fair billing (usage-based debit via Supabase RPC) is dormant under
    // local auth — no session token is held to present to the RPC.
    let _ = usage;

    Ok(plan)
}

/// Authenticated RPC: respond to a pending supervisor confirmation gate.
#[cfg(feature = "litert")]
#[tauri::command]
pub fn respond_supervisor_confirmation(
    stream_id: String,
    step_id: String,
    approved: bool,
    registry: State<'_, crate::supervisor::PendingConfirmations>,
) -> Result<(), String> {
    let sender = registry.lock().map_err(|e| e.to_string())?.remove(&crate::supervisor::confirmation_key(&stream_id, &step_id))
        .ok_or_else(|| format!("no pending confirmation for step '{step_id}'"))?;
    let _ = sender.send(approved);
    let _ = stream_id;
    Ok(())
}

/// Authenticated RPC: list the user's stored office files.
#[tauri::command]
pub fn office_list_files(
    session: State<'_, Session>,
) -> Result<Vec<logic::office::OfficeFile>, String> {
    let user_id = session_user_id(&session)?;
    logic::office::list_files(&user_id)
}

/// Authenticated RPC: list deck template packs (bundled + cached catalogue; no network).
#[tauri::command]
pub fn office_list_templates() -> Vec<logic::office::TemplateListing> {
    logic::office::list_templates()
}

/// Bind a user's explicit template choice — consumed on the next
/// `office_create_deck` call (Rust overrides the model's arg).
#[tauri::command]
pub fn office_bind_template(
    template_id: String,
    session: State<'_, Session>,
) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    logic::office::bind_template(&user_id, &template_id)
}

/// Peek the current (non-consumed) template binding for the UI's bound-state display.
#[tauri::command]
pub fn office_peek_template(
    session: State<'_, Session>,
) -> Result<Option<String>, String> {
    let user_id = session_user_id(&session)?;
    Ok(logic::office::peek_template_binding(&user_id))
}

/// Authenticated RPC: read a stored document as markdown (in-process via office_oxide).
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

// ── SQL data-source profiles (analytics agent) ──────────────────────────────

/// Authenticated RPC: schema preview of a stored tabular file (csv/tsv/
/// parquet/xlsx) for the Knowledge panel — columns, dtypes, samples.
#[tauri::command]
pub async fn data_preview(
    file_id: String,
    session: State<'_, Session>,
) -> Result<logic::analytics::SchemaInfo, String> {
    let user_id = session_user_id(&session)?;
    logic::analytics::data_preview(&user_id, &file_id).await
}

/// Authenticated RPC: list the user's saved SQL data sources.
#[tauri::command]
pub async fn sql_profile_list(
    session: State<'_, Session>,
) -> Result<Vec<logic::analytics::SqlProfile>, String> {
    let user_id = session_user_id(&session)?;
    logic::analytics::sql_profile_list(&user_id).await
}

/// Authenticated RPC: save (insert or update) a named SQLite source.
#[tauri::command]
pub async fn sql_profile_save(
    name: String,
    source: String,
    session: State<'_, Session>,
) -> Result<logic::analytics::SqlProfile, String> {
    let user_id = session_user_id(&session)?;
    logic::analytics::sql_profile_save(&user_id, &name, &source).await
}

/// Authenticated RPC: delete a named SQL data source (idempotent).
#[tauri::command]
pub async fn sql_profile_delete(name: String, session: State<'_, Session>) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    logic::analytics::sql_profile_delete(&user_id, &name).await
}

/// Authenticated RPC: probe one saved SQL data source (open + list tables).
#[tauri::command]
pub async fn sql_profile_test(
    name: String,
    session: State<'_, Session>,
) -> Result<logic::analytics::SqlProfileTest, String> {
    let user_id = session_user_id(&session)?;
    logic::analytics::sql_profile_test(&user_id, &name).await
}

/// Authenticated RPC: ingest a YouTube video into the knowledge base
/// (transcript → markdown document → indexed; deduped per video).
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

/// Authenticated RPC: undo the last edit — swap the stored file with its
/// pre-edit snapshot (second call swaps back).
#[tauri::command]
pub fn office_restore_backup(
    file_id: String,
    session: State<'_, Session>,
) -> Result<logic::office::OfficeFile, String> {
    let user_id = session_user_id(&session)?;
    logic::office::store::restore_backup(&user_id, &file_id).map_err(|e| e.to_string())
}

/// Authenticated RPC: export a stored file to the filesystem.
#[tauri::command]
pub fn office_export_file(
    file_id: String,
    dest_path: Option<String>,
    session: State<'_, Session>,
) -> Result<String, String> {
    let user_id = session_user_id(&session)?;
    logic::office::export_file(&user_id, &file_id, dest_path.as_deref())
}

/// Authenticated RPC: render markdown to an office document (docx/xlsx/pptx)
/// and return the raw file bytes for download (no intermediate store file).
#[tauri::command]
pub fn office_export_document(
    markdown: String,
    format: String,
    session: State<'_, Session>,
) -> Result<Vec<u8>, String> {
    session_user_id(&session)?;
    logic::office::export_markdown(&markdown, &format)
}

/// Authenticated RPC: read a stored document's raw bytes (for in-app preview
/// — image/video/pdf embeds or text/markdown rendering). Returns base64 plus
/// a best-effort MIME type so the frontend can build a `data:` URL.
#[tauri::command]
pub fn office_read_file(
    file_id: String,
    session: State<'_, Session>,
) -> Result<logic::office::ReadFileResult, String> {
    let user_id = session_user_id(&session)?;
    logic::office::read_file_b64(&user_id, &file_id)
}

/// Authenticated RPC: open a stored file in the OS default viewer. The backend
/// resolves the file id to a path (already scoped to the user's data dir) and
/// opens it directly — no webview-side path scope needed.
#[tauri::command]
pub fn tauri_open_file(
    app: tauri::AppHandle,
    file_id: String,
    session: State<'_, Session>,
) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    let path = logic::office::file_path(&user_id, &file_id)?;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| format!("open {}: {e}", path))
}

/// Authenticated RPC: which office engines are available on this host.
#[tauri::command]
pub fn office_capabilities(
    session: State<'_, Session>,
) -> Result<logic::office::OfficeCapabilities, String> {
    let _ = session_user_id(&session)?;
    Ok(logic::office::capabilities())
}

// ── GraphRAG ops (feature "graph") ────────────────────────────────────────
// Always compiled (so lib.rs generate_handler is static); inner dispatch is
// cfg-gated so the binary is zero-cost when the feature is off.

#[tauri::command]
pub async fn graph_index_file(
    file_id: String,
    session: State<'_, Session>,
) -> Result<serde_json::Value, String> {
    let user_id = session_user_id(&session)?;
    let (nodes, edges) = logic::graph::graph_index_file(user_id, file_id).await?;
    Ok(serde_json::json!({"nodes": nodes, "edges": edges}))
}

#[tauri::command]
pub async fn graph_index_text(
    file_id: String,
    text: String,
    session: State<'_, Session>,
) -> Result<serde_json::Value, String> {
    let user_id = session_user_id(&session)?;
    let (nodes, edges) = logic::graph::graph_index_text(&user_id, &file_id, &text).await?;
    Ok(serde_json::json!({"nodes": nodes, "edges": edges}))
}

#[tauri::command]
pub async fn graph_search(
    query: String,
    mode: Option<String>,
    limit: Option<usize>,
    session: State<'_, Session>,
) -> Result<serde_json::Value, String> {
    let user_id = session_user_id(&session)?;
    let m = match mode.as_deref().unwrap_or("hybrid") {
        "naive" => logic::graph::GraphSearchMode::Naive,
        "local" => logic::graph::GraphSearchMode::Local,
        "global" => logic::graph::GraphSearchMode::Global,
        "mix" => logic::graph::GraphSearchMode::Mix,
        _ => logic::graph::GraphSearchMode::Hybrid,
    };
    let hits = logic::graph::graph_search(user_id, query, Some(m), limit).await?;
    Ok(serde_json::to_value(hits).unwrap_or(serde_json::Value::Array(vec![])))
}

#[tauri::command]
pub async fn graph_list(
    limit: Option<usize>,
    session: State<'_, Session>,
) -> Result<serde_json::Value, String> {
    let user_id = session_user_id(&session)?;
    let (nodes, edges) = logic::graph::graph_list(&user_id, limit).await?;
    Ok(serde_json::json!({"nodes": nodes, "edges": edges}))
}

#[tauri::command]
pub async fn graph_forget(
    file_ids: Vec<String>,
    session: State<'_, Session>,
) -> Result<usize, String> {
    let user_id = session_user_id(&session)?;
    logic::graph::graph_forget(&user_id, file_ids).await
}

#[tauri::command]
pub async fn graph_stats(session: State<'_, Session>) -> Result<serde_json::Value, String> {
    let user_id = session_user_id(&session)?;
    let stats = logic::graph::graph_stats(&user_id).await?;
    Ok(serde_json::to_value(stats).unwrap_or(serde_json::json!({})))
}

// ── CodeGraph bridge (feature `codegraph` → sidecar, `codegraph-native` → native) ─
// Always compiled (like graph ops) so `generate_handler!` stays stable; inner
// dispatch checks the feature and returns a guidance error when off.

#[tauri::command]
pub async fn codegraph_explore(
    query: String,
    project_path: Option<String>,
    session: State<'_, Session>,
) -> Result<logic::codegraph::CodegraphExploreResult, String> {
    let user_id = session_user_id(&session)?;
    logic::codegraph::codegraph_explore(&user_id, query, project_path).await
}

#[tauri::command]
pub async fn codegraph_status(
    project_path: Option<String>,
    session: State<'_, Session>,
) -> Result<logic::codegraph::CodegraphStatusResult, String> {
    let user_id = session_user_id(&session)?;
    logic::codegraph::codegraph_status(&user_id, project_path).await
}

#[tauri::command]
pub async fn codegraph_is_available() -> bool {
    logic::codegraph::codegraph_is_available().await
}

#[tauri::command]
pub async fn codegraph_init(
    project_path: Option<String>,
    session: State<'_, Session>,
) -> Result<logic::codegraph::CodegraphStatusResult, String> {
    let user_id = session_user_id(&session)?;
    logic::codegraph::codegraph_init(&user_id, project_path).await
}



// ── Supervisor (router + litert) ────────────────────────────────────────────

/// Streaming supervisor execution: build the tool registry for the user's
/// session, run the plan deterministically, and stream progress events.
#[cfg(feature = "litert")]
#[tauri::command]
pub async fn execute_supervisor_plan(
    plan: kawai_router::TaskPlan,
    session_id: i64,
        stream_id: String,
    on_event: Channel<crate::supervisor::SupervisorEvent>,
    registry: State<'_, StreamRegistry>,
    session: State<'_, Session>,
    pending: State<'_, crate::supervisor::PendingConfirmations>,
) -> Result<(), String> {
    let user_id = session_user_id(&session)?;
    let registry_state = Arc::clone(&registry);

    let token = CancellationToken::new();
    let _guard = register_stream(&registry_state, &stream_id, token.clone());

    if !kawai_db::session_exists(&user_id, session_id)
        .await
        .map_err(|e| e.to_string())?
    {
        return Err(format!("session {session_id} not found"));
    }

    // LLM-written plans omit `agentId` (tool-dispatched steps never dispatch
    // by agent), so an empty/unknown step agent must NOT be passed through —
    // the specialist-only builders would return None. Rebuild the same merged
    // `auto` catalog plan_task planned against; dispatch keys off the tool
    // name, and a real specialist id still narrows as intended.
    let step_agent = plan
        .steps
        .first()
        .map(|s| s.agent_id.as_str())
        .unwrap_or("");
    let agent_id = match step_agent {
        crate::agent_registry::OFFICE_AGENT_ID
        | crate::agent_registry::PRESENTATION_AGENT_ID
        | crate::agent_registry::BINANCE_AGENT_ID
        | crate::agent_registry::ANALYTICS_AGENT_ID => step_agent,
        _ => crate::supervisor::AUTO_AGENT_ID,
    };
    let tool_registry = crate::supervisor::build_supervisor_registry(
        &user_id,
        session_id,
        agent_id,
    )
    .await
    .ok_or_else(|| "supervisor toolset unavailable".to_string())?;

    let step_count = plan.steps.len();
    let stream = crate::supervisor::execute_plan_stream_with_cancel(plan, tool_registry, token.clone(), pending.inner().clone(), stream_id.clone());
    // Telemetry: this transport previously had zero logging, which made
    // scheduler anomalies (e.g. zero-step "successes") invisible.
    eprintln!("[supervisor] executing plan ({step_count} steps) for user={user_id} session={session_id}");
    let mut stream = Box::pin(stream);
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            Some(event) = stream.next() => {
                on_event.send(event).map_err(|e| e.to_string())?;
            }
            else => break,
        }
    }

    Ok(())
}

// ── TTS (piper-rs, feature "tts") ──────────────────────────────────────────

/// Synthesize speech from text using the Piper neural TTS engine.
/// Returns base64-encoded WAV audio for playback in the frontend.
/// When the `tts` feature is off, returns an error immediately.
#[tauri::command]
pub async fn synthesize_speech(
    text: String,
    voice: Option<String>,
    length_scale: Option<f32>,
) -> Result<String, String> {
    let (samples, sample_rate) = logic::tts::synthesize(
        &text,
        voice.as_deref(),
        length_scale,
    )
    .await
    .map_err(|e| e.to_string())?;

    let wav = logic::tts::pcm_to_wav(&samples, sample_rate);

    // base64 is always available (office deps); synthesis only succeeds when
    // tts is on, so this is always reachable when we get here.
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&wav))
}
