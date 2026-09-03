use crate::auth::Session;
use crate::logic::{self, ActivityEvent, ActivityInput, ChatMessage, ChatSession, UserInfo};
use axum::{
    extract::{Json, Request},
    http::{header, HeaderValue, StatusCode},
    middleware::{from_fn, Next},
    response::{sse::Event as SseFrame, sse::KeepAlive, IntoResponse, Response, Sse},
    routing::post,
    Extension, Router,
};
use futures_core::Stream;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{convert::Infallible, path::PathBuf};
use tower_http::services::ServeDir;

/// Cookie name carrying the JWT in web mode. HttpOnly so JS cannot read it
/// (XSS cannot exfiltrate); SameSite=Lax so it rides along on same-origin
/// `/api/*` calls including SSE. Same-origin because kawai-web serves `dist/`
/// itself — no cross-origin cookie problem.
const SESSION_COOKIE: &str = "kawai_session";
const COOKIE_MAX_AGE: u32 = 30 * 24 * 60 * 60; // 30 days, seconds

#[derive(Deserialize)]
struct GreetRequest {
    name: String,
}

#[derive(Deserialize)]
struct SetSessionRequest {
    token: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CreateChatSessionRequest {}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListChatSessionsRequest {
    archived: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameChatSessionRequest {
    session_id: i64,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetChatSessionArchivedRequest {
    session_id: i64,
    archived: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListChatMessagesRequest {
    session_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendChatMessageRequest {
    session_id: i64,
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteChatSessionRequest {
    session_id: i64,
}

// ── Skills (ungated; plain libsql CRUD) ────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillCreateRequest {
    name: String,
    description: Option<String>,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillGetRequest {
    skill_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillUpdateRequest {
    skill_id: String,
    name: Option<String>,
    description: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillDeleteRequest {
    skill_id: String,
}

// ── L1 memories (ungated CRUD; extraction uses the hybrid cloud tier) ──────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryCreateRequest {
    kind: String,
    title: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryUpdateRequest {
    memory_id: String,
    kind: Option<String>,
    title: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryDeleteRequest {
    memory_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryExtractRequest {
    session_id: i64,
}

async fn memory_create_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<MemoryCreateRequest>,
) -> Result<Json<logic::memory::MemoryItem>, (StatusCode, String)> {
    logic::memory::memory_create(&user_id, &req.kind, &req.title, &req.content)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn memory_list_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<Vec<logic::memory::MemoryItem>>, (StatusCode, String)> {
    logic::memory::memory_list(&user_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn memory_update_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<MemoryUpdateRequest>,
) -> Result<Json<Option<logic::memory::MemoryItem>>, (StatusCode, String)> {
    logic::memory::memory_update(
        &user_id,
        &req.memory_id,
        req.kind.as_deref(),
        req.title.as_deref(),
        req.content.as_deref(),
    )
    .await
    .map(Json)
    .map_err(|e| (db_status(&e), e.to_string()))
}

async fn memory_delete_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<MemoryDeleteRequest>,
) -> Result<Json<bool>, (StatusCode, String)> {
    logic::memory::memory_delete(&user_id, &req.memory_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn memory_extract_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<MemoryExtractRequest>,
) -> Result<Json<Vec<logic::memory::MemoryItem>>, (StatusCode, String)> {
    logic::memory::memory_extract(&user_id, req.session_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemorySearchRequest {
    query: String,
    limit: Option<usize>,
}

async fn memory_search_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<MemorySearchRequest>,
) -> Result<Json<Vec<logic::memory::MemoryItem>>, (StatusCode, String)> {
    logic::memory::memory_search(&user_id, &req.query, req.limit)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryConsolidateRequest {}

async fn memory_consolidate_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<logic::memory::ConsolidationReport>, (StatusCode, String)> {
    logic::memory::memory_consolidate(&user_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryGraphSearchRequest {
    query: String,
    limit: Option<usize>,
}

async fn memory_graph_search_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<MemoryGraphSearchRequest>,
) -> Result<Json<Vec<logic::memory::MemoryGraphHit>>, (StatusCode, String)> {
    logic::memory::memory_graph_search(&user_id, &req.query, req.limit)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryGraphExportRequest {
    limit: Option<usize>,
}

async fn memory_graph_export_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<MemoryGraphExportRequest>,
) -> Result<Json<logic::memory::MemoryGraphExport>, (StatusCode, String)> {
    logic::memory::memory_graph_export(&user_id, req.limit)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemorySceneExtractRequest {}

async fn memory_scene_extract_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<Vec<logic::memory::SceneHit>>, (StatusCode, String)> {
    logic::memory::memory_scene_extract(&user_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemorySceneListRequest {}

async fn memory_scene_list_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<Vec<logic::memory::SceneHit>>, (StatusCode, String)> {
    logic::memory::memory_scene_list(&user_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryPersonaGenerateRequest {}

async fn memory_persona_generate_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<String>, (StatusCode, String)> {
    logic::memory::memory_persona_generate(&user_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryPersonaGetRequest {}

async fn memory_persona_get_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<Option<String>>, (StatusCode, String)> {
    logic::memory::memory_persona_get(&user_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn skill_create_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<SkillCreateRequest>,
) -> Result<Json<logic::skills::Skill>, (StatusCode, String)> {
    logic::skills::skill_create(
        &user_id,
        &req.name,
        req.description.as_deref().unwrap_or(""),
        &req.content,
    )
    .await
    .map(Json)
    .map_err(|e| (db_status(&e), e.to_string()))
}

async fn skill_list_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<Vec<logic::skills::SkillSummary>>, (StatusCode, String)> {
    logic::skills::skill_list(&user_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn skill_get_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<SkillGetRequest>,
) -> Result<Json<Option<logic::skills::Skill>>, (StatusCode, String)> {
    logic::skills::skill_get(&user_id, &req.skill_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn skill_update_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<SkillUpdateRequest>,
) -> Result<Json<Option<logic::skills::Skill>>, (StatusCode, String)> {
    logic::skills::skill_update(
        &user_id,
        &req.skill_id,
        req.name.as_deref(),
        req.description.as_deref(),
        req.content.as_deref(),
    )
    .await
    .map(Json)
    .map_err(|e| (db_status(&e), e.to_string()))
}

async fn skill_delete_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<SkillDeleteRequest>,
) -> Result<Json<bool>, (StatusCode, String)> {
    logic::skills::skill_delete(&user_id, &req.skill_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Public RPC: client-side email verification (same op as the Tauri command).
/// Returns the generated code so the caller verifies user input locally.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendVerificationEmailRequest {
    to: String,
}

async fn send_verification_email_handler(
    Json(req): Json<SendVerificationEmailRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    logic::email::send_verification_email(&req.to)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

// ── Local email+password auth (public; same ops as the Tauri commands) ──────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthCredentialsRequest {
    email: String,
    password: String,
}

fn session_cookie_response(user_id: &str) -> Response {
    // The cookie carries the local user id directly — no token round-trip.
    // NOTE: `Secure` is intentionally omitted for plain-HTTP localhost dev.
    let cookie = format!(
        "{SESSION_COOKIE}={user_id}; HttpOnly; SameSite=Lax; Path=/; Max-Age={COOKIE_MAX_AGE}"
    );
    let mut resp = Json(logic::whoami(user_id)).into_response();
    if let Ok(val) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().append(header::SET_COOKIE, val);
    }
    resp
}

async fn auth_sign_up_handler(
    Json(req): Json<AuthCredentialsRequest>,
) -> Result<Response, (StatusCode, String)> {
    let user = logic::local_auth::auth_sign_up(&req.email, &req.password)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(session_cookie_response(&user.email))
}

async fn auth_sign_in_handler(
    Json(req): Json<AuthCredentialsRequest>,
) -> Result<Response, (StatusCode, String)> {
    let user = logic::local_auth::auth_sign_in(&req.email, &req.password)
        .await
        .map_err(|e| (StatusCode::UNAUTHORIZED, e))?;
    Ok(session_cookie_response(&user.email))
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

async fn greet_handler(Json(req): Json<GreetRequest>) -> Json<String> {
    Json(logic::greet(&req.name))
}

/// Public RPC: the agent catalog (same op as the Tauri `list_agents` command).
async fn list_agents_handler() -> Json<Vec<crate::agent_registry::AgentInfo>> {
    Json(crate::agent_registry::builtin().list())
}

/// Public RPC: native MON balance on Monad (same op as the Tauri
/// `check_monad_balance` command). Request needs `#[serde(rename_all)]` —
/// Axum `Json<T>` does NOT map camelCase → snake_case like Tauri does.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MonadBalanceRequest {
    wallet_address: String,
    rpc_url: Option<String>,
}

async fn check_monad_balance_handler(
    Json(req): Json<MonadBalanceRequest>,
) -> Result<Json<logic::monad::BalanceInfo>, (StatusCode, String)> {
    match logic::monad::check_balance(req.rpc_url.as_deref(), &req.wallet_address).await {
        Ok(info) => Ok(Json(info)),
        Err(e) => Err((StatusCode::BAD_REQUEST, e)),
    }
}

/// Public RPC: Monad chain status probe.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MonadChainStatusRequest {
    rpc_url: Option<String>,
}

async fn monad_chain_status_handler(
    Json(req): Json<MonadChainStatusRequest>,
) -> Result<Json<logic::monad::ChainStatus>, (StatusCode, String)> {
    match logic::monad::chain_status(req.rpc_url.as_deref()).await {
        Ok(status) => Ok(Json(status)),
        Err(e) => Err((StatusCode::BAD_REQUEST, e)),
    }
}

// ── Device-scoped Monad hot wallet (public; same ops as the Tauri commands) ──

fn wallet_err(e: String) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MonadSignMessageRequest {
    message: String,
}

async fn monad_wallet_address_handler() -> Result<Json<Option<logic::monad_wallet::WalletAddress>>, (StatusCode, String)> {
    logic::monad_wallet::address().map(Json).map_err(wallet_err)
}

async fn monad_wallet_create_handler() -> Result<Json<logic::monad_wallet::WalletAddress>, (StatusCode, String)> {
    logic::monad_wallet::create().map(Json).map_err(wallet_err)
}

async fn monad_wallet_sign_message_handler(
    Json(req): Json<MonadSignMessageRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    logic::monad_wallet::sign_message(&req.message)
        .await
        .map(Json)
        .map_err(wallet_err)
}

async fn monad_wallet_delete_handler() -> Result<Json<()>, (StatusCode, String)> {
    logic::monad_wallet::delete().map(Json).map_err(wallet_err)
}

async fn generate_activity_handler(
    Json(input): Json<ActivityInput>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    let s = logic::generate_activity(input).map(|event| Ok::<_, Infallible>(event_to_sse(event)));
    Sse::new(s).keep_alive(KeepAlive::default())
}

async fn logout_handler() -> Response {
    let cookie = format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    let mut resp = StatusCode::NO_CONTENT.into_response();
    if let Ok(val) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().append(header::SET_COOKIE, val);
    }
    resp
}

/// Protected: identity is injected by `auth_middleware` as `Extension<String>`.
async fn whoami_handler(Extension(user_id): Extension<String>) -> Json<UserInfo> {
    Json(logic::whoami(&user_id))
}

/// Map DbError to an HTTP status: NotFound → 404, everything else 500.
fn db_status(e: &logic::DbError) -> StatusCode {
    if matches!(e, logic::DbError::NotFound(_)) {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

/// Protected RPC: start a new chat session. Sessions are created lazily on
/// the first message; no agent identity — supervisor runs in `auto` mode.
async fn create_chat_session_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<CreateChatSessionRequest>,
) -> Result<Json<ChatSession>, (StatusCode, String)> {
    logic::create_chat_session(&user_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: regenerate a session title via Cloudflare Workers AI
/// (3-6 words from the session's goal + final output).
async fn generate_session_title_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<GenerateSessionTitleRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::generate_session_title(&user_id, req.session_id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateSessionTitleRequest {
    session_id: i64,
}

/// Protected RPC: list the user's chat sessions, newest first. Defaults to the
/// active (non-archived) sidebar list; `{ "archived": true }` for the archive.
/// The body is optional so an empty POST lists the active sessions.
async fn list_chat_sessions_handler(
    Extension(user_id): Extension<String>,
    body: Option<Json<ListChatSessionsRequest>>,
) -> Result<Json<Vec<ChatSession>>, (StatusCode, String)> {
    let archived = body.and_then(|Json(req)| req.archived).unwrap_or(false);
    logic::list_chat_sessions(&user_id, archived)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: rename a session (sidebar inline rename).
async fn rename_chat_session_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<RenameChatSessionRequest>,
) -> Result<Json<ChatSession>, (StatusCode, String)> {
    logic::rename_chat_session(&user_id, req.session_id, &req.title)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: archive or restore a session.
async fn set_chat_session_archived_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<SetChatSessionArchivedRequest>,
) -> Result<Json<ChatSession>, (StatusCode, String)> {
    logic::set_chat_session_archived(&user_id, req.session_id, req.archived)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: list a session's messages, oldest first.
async fn list_chat_messages_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<ListChatMessagesRequest>,
) -> Result<Json<Vec<ChatMessage>>, (StatusCode, String)> {
    logic::list_chat_messages(&user_id, req.session_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: append a message to a session.
async fn append_chat_message_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<AppendChatMessageRequest>,
) -> Result<Json<ChatMessage>, (StatusCode, String)> {
    logic::append_chat_message(&user_id, req.session_id, &req.role, &req.content)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn delete_chat_session_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<DeleteChatSessionRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::delete_chat_session(&user_id, req.session_id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: load an on-device model (`.litertlm`).
#[cfg(feature = "litert")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLoadModelRequest {
    model_path: Option<String>,
    gpu: Option<bool>,
    speculative_decoding: Option<bool>,
    max_num_images: Option<i32>,
    tools_json: Option<String>,
}

#[cfg(feature = "litert")]
async fn local_load_model_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<LocalLoadModelRequest>,
) -> Result<Json<logic::local_llm::LocalModelInfo>, (StatusCode, String)> {
    let model_path = match req.model_path {
        Some(p) if !p.is_empty() => p,
        _ => {
            // Try local candidates first, then download from HuggingFace Hub.
            match logic::resolve_model_path() {
                Ok(p) => p,
                Err(_) => logic::ensure_model()
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?,
            }
        }
    };
    logic::local_llm::load_model(
        &user_id,
        &model_path,
        req.gpu.unwrap_or(true),
        req.speculative_decoding.unwrap_or(false),
        req.max_num_images.unwrap_or(0),
        req.tools_json,
    )
    .await
    .map(Json)
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Protected RPC: return the current on-device model status.
#[cfg(feature = "litert")]
async fn local_model_status_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<logic::local_llm::LocalModelStatus>, (StatusCode, String)> {
    Ok(Json(logic::local_model_status()))
}

/// Protected streaming: on-device chat via SSE.
#[cfg(feature = "litert")]
#[derive(Deserialize)]
struct LocalChatRequest {
    prompt: String,
    image: Option<String>,
    audio: Option<String>,
}

#[cfg(feature = "litert")]
async fn local_chat_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<LocalChatRequest>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    let s = logic::local_llm::local_chat(user_id, req.prompt, req.image, req.audio, true)
        .map(|event| Ok::<_, Infallible>(local_event_to_sse(event)));
    Sse::new(s).keep_alive(KeepAlive::default())
}

#[cfg(feature = "litert")]
fn local_event_to_sse(event: logic::local_llm::LocalChatEvent) -> SseFrame {
    use logic::local_llm::LocalChatEvent;
    let name = match &event {
        LocalChatEvent::Started => "started",
        LocalChatEvent::Token { .. } => "token",
        LocalChatEvent::Thinking { .. } => "thinking",
        LocalChatEvent::ToolCall { .. } => "toolCall",
        LocalChatEvent::ToolResult { .. } => "toolResult",
        LocalChatEvent::Finished => "finished",
        LocalChatEvent::Error { .. } => "error",
    };
    let data = serde_json::to_string(&event).unwrap_or_default();
    SseFrame::default().event(name).data(data)
}

/// Protected RPC: reset the on-device conversation history (same model).
#[cfg(feature = "litert")]
async fn local_llm_reset_handler(
    Extension(user_id): Extension<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::local_llm::reset_conversation(&user_id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Protected RPC: toggle thinking mode for subsequent on-device chats.
#[cfg(feature = "litert")]
#[derive(Deserialize)]
struct LocalSetThinkingRequest {
    enabled: bool,
}

#[cfg(feature = "litert")]
async fn local_llm_set_thinking_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<LocalSetThinkingRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::local_llm::set_thinking(&user_id, req.enabled);
    Ok(StatusCode::NO_CONTENT)
}

/// Protected RPC: unload the on-device model and free all resources.
#[cfg(feature = "litert")]
async fn local_llm_unload_handler(
    Extension(user_id): Extension<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::local_llm::unload_model(&user_id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

// ── Office document ops (feature "office") ──────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeImportFileRequest {
    source_path: Option<String>,
    name: Option<String>,
    data_base64: Option<String>,
}

async fn office_import_file_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<OfficeImportFileRequest>,
) -> Result<Json<logic::office::OfficeFile>, (StatusCode, String)> {
    let result = match (
        req.source_path.as_deref(),
        (req.name.as_deref(), req.data_base64.as_deref()),
    ) {
        (Some(src), _) => logic::office::import_path(&user_id, src),
        (None, (Some(name), Some(data))) => logic::office::import_base64(&user_id, name, data),
        _ => Err("provide sourcePath, or name + dataBase64".into()),
    };
    result.map(Json).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeContextRequest {
    file_ids: Vec<String>,
}

async fn knowledge_context_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<KnowledgeContextRequest>,
) -> Result<Json<logic::office::KnowledgeContext>, (StatusCode, String)> {
    logic::office::knowledge_context(&user_id, &req.file_ids)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSearchRequest {
    session_id: i64,
    query: String,
    mode: Option<logic::rag::SearchMode>,
}

async fn knowledge_search_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<KnowledgeSearchRequest>,
) -> Result<Json<Vec<logic::rag::RagHit>>, (StatusCode, String)> {
    logic::rag::knowledge_search(user_id, req.session_id, req.query, req.mode)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeForgetRequest {
    session_id: Option<i64>,
    file_ids: Vec<String>,
}

async fn knowledge_forget_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<KnowledgeForgetRequest>,
) -> Result<Json<usize>, (StatusCode, String)> {
    logic::rag::forget_file(user_id, req.session_id, req.file_ids)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSessionFilesRequest {
    session_id: i64,
}

async fn list_session_files_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<ListSessionFilesRequest>,
) -> Result<Json<Vec<logic::office::OfficeFile>>, (StatusCode, String)> {
    logic::rag::list_session_files(&user_id, req.session_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeIndexFileRequest {
    session_id: Option<i64>,
    file_id: String,
}

async fn office_index_file_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<OfficeIndexFileRequest>,
) -> Result<Json<usize>, (StatusCode, String)> {
    logic::rag::office_index_file(user_id, req.session_id, req.file_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeListRequest {
    session_id: Option<i64>,
}

async fn knowledge_list_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<KnowledgeListRequest>,
) -> Result<Json<Vec<logic::rag::KnowledgeFileInfo>>, (StatusCode, String)> {
    logic::rag::knowledge_list(&user_id, req.session_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeAddToSessionRequest {
    session_id: i64,
    file_ids: Vec<String>,
}

async fn knowledge_add_to_session_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<KnowledgeAddToSessionRequest>,
) -> Result<Json<usize>, (StatusCode, String)> {
    logic::rag::knowledge_add_to_session(&user_id, req.session_id, &req.file_ids)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

// ── SQL data-source profiles (analytics agent) ──────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataPreviewRequest {
    file_id: String,
}

async fn data_preview_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<DataPreviewRequest>,
) -> Result<Json<logic::analytics::SchemaInfo>, (StatusCode, String)> {
    logic::analytics::data_preview(&user_id, &req.file_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

async fn sql_profile_list_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<Vec<logic::analytics::SqlProfile>>, (StatusCode, String)> {
    logic::analytics::sql_profile_list(&user_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlProfileSaveRequest {
    name: String,
    source: String,
}

async fn sql_profile_save_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<SqlProfileSaveRequest>,
) -> Result<Json<logic::analytics::SqlProfile>, (StatusCode, String)> {
    logic::analytics::sql_profile_save(&user_id, &req.name, &req.source)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlProfileDeleteRequest {
    name: String,
}

async fn sql_profile_delete_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<SqlProfileDeleteRequest>,
) -> Result<Json<()>, (StatusCode, String)> {
    logic::analytics::sql_profile_delete(&user_id, &req.name)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlProfileTestRequest {
    name: String,
}

async fn sql_profile_test_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<SqlProfileTestRequest>,
) -> Result<Json<logic::analytics::SqlProfileTest>, (StatusCode, String)> {
    logic::analytics::sql_profile_test(&user_id, &req.name)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeImportYoutubeRequest {
    url: String,
    session_id: Option<i64>,
}

async fn knowledge_import_youtube_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<KnowledgeImportYoutubeRequest>,
) -> Result<Json<logic::office::OfficeFile>, (StatusCode, String)> {
    logic::rag::knowledge_import_youtube(&user_id, req.session_id, &req.url)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeDeleteFileRequest {
    file_id: String,
}

async fn office_delete_file_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<OfficeDeleteFileRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::rag::office_delete_file(&user_id, &req.file_id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn office_restore_backup_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<OfficeDeleteFileRequest>,
) -> Result<Json<logic::office::OfficeFile>, (StatusCode, String)> {
    logic::office::store::restore_backup(&user_id, &req.file_id)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Bind a user's explicit template choice.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindTemplateRequest {
    template_id: String,
}

async fn office_bind_template_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<BindTemplateRequest>,
) -> Result<Json<bool>, (StatusCode, String)> {
    logic::office::bind_template(&user_id, &req.template_id)
        .map(|_| Json(true))
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// Peek current template binding.
async fn office_peek_template_handler(
    Extension(user_id): Extension<String>,
) -> Json<Option<String>> {
    Json(logic::office::peek_template_binding(&user_id))
}

async fn office_list_templates_handler() -> Json<Vec<logic::office::TemplateListing>> {
    Json(logic::office::list_templates())
}

async fn office_list_files_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<Vec<logic::office::OfficeFile>>, (StatusCode, String)> {
    logic::office::list_files(&user_id)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeReadDocumentRequest {
    file_id: String,
}

async fn office_read_document_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<OfficeReadDocumentRequest>,
) -> Result<Json<logic::office::ReadDocumentResult>, (StatusCode, String)> {
    let markdown = logic::office::read_document(&user_id, &req.file_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(logic::office::ReadDocumentResult { markdown }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeExportFileRequest {
    file_id: String,
    dest_path: Option<String>,
}

async fn office_export_file_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<OfficeExportFileRequest>,
) -> Result<Json<std::collections::HashMap<String, String>>, (StatusCode, String)> {
    logic::office::export_file(&user_id, &req.file_id, req.dest_path.as_deref())
        .map(|path| {
            Json(std::collections::HashMap::from([(
                "path".to_string(),
                path,
            )]))
        })
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn office_capabilities_handler(
    Extension(user_id): Extension<String>,
) -> Json<logic::office::OfficeCapabilities> {
    let _ = &user_id;
    Json(logic::office::capabilities())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeExportDocumentRequest {
    markdown: String,
    format: String,
}

async fn office_export_document_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<OfficeExportDocumentRequest>,
) -> Result<Response, (StatusCode, String)> {
    let _ = &user_id;
    let bytes = logic::office::export_markdown(&req.markdown, &req.format)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let (content_type, ext) = match req.format.to_ascii_lowercase().as_str() {
        "xlsx" => (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "xlsx",
        ),
        "pptx" => (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "pptx",
        ),
        _ => (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
        ),
    };
    let cd = format!("attachment; filename=\"kawai-export.{ext}\"");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, cd)
        .body(axum::body::Body::from(bytes))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("response build: {e}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeReadFileRequest {
    file_id: String,
}

async fn office_read_file_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<OfficeReadFileRequest>,
) -> Result<Json<logic::office::ReadFileResult>, (StatusCode, String)> {
    logic::office::read_file_b64(&user_id, &req.file_id)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn tauri_open_file_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<OfficeReadFileRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    logic::office::file_path(&user_id, &req.file_id)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

// ── CodeGraph bridge (feature `codegraph` → sidecar, `codegraph-native` → native) ─
// Always compiled so the router is static; inner dispatch is cfg-gated.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodegraphExploreRequest {
    query: String,
    project_path: Option<String>,
}
async fn codegraph_explore_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<CodegraphExploreRequest>,
) -> Result<Json<logic::codegraph::CodegraphExploreResult>, (StatusCode, String)> {
    logic::codegraph::codegraph_explore(&user_id, req.query, req.project_path)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::NOT_IMPLEMENTED, e))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodegraphStatusRequest {
    project_path: Option<String>,
}
async fn codegraph_status_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<CodegraphStatusRequest>,
) -> Result<Json<logic::codegraph::CodegraphStatusResult>, (StatusCode, String)> {
    logic::codegraph::codegraph_status(&user_id, req.project_path)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::NOT_IMPLEMENTED, e))
}
async fn codegraph_is_available_handler() -> Json<bool> {
    Json(logic::codegraph::codegraph_is_available().await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodegraphInitRequest {
    project_path: Option<String>,
}
async fn codegraph_init_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<CodegraphInitRequest>,
) -> Result<Json<logic::codegraph::CodegraphStatusResult>, (StatusCode, String)> {
    logic::codegraph::codegraph_init(&user_id, req.project_path)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::NOT_IMPLEMENTED, e))
}

// ── GraphRAG ops (feature "graph") ────────────────────────────────────────
// Always compiled so the router is static; inner dispatch is cfg-gated.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphIndexFileRequest {
    file_id: String,
}
async fn graph_index_file_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<GraphIndexFileRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (n, e) = logic::graph::graph_index_file(user_id, req.file_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({"nodes": n, "edges": e})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphIndexTextRequest {
    file_id: String,
    text: String,
}
async fn graph_index_text_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<GraphIndexTextRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (n, e) = logic::graph::graph_index_text(&user_id, &req.file_id, &req.text)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({"nodes": n, "edges": e})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphSearchRequest {
    query: String,
    mode: Option<String>,
    limit: Option<usize>,
}
async fn graph_search_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<GraphSearchRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let m = match req.mode.as_deref().unwrap_or("hybrid") {
        "naive" => logic::graph::GraphSearchMode::Naive,
        "local" => logic::graph::GraphSearchMode::Local,
        "global" => logic::graph::GraphSearchMode::Global,
        "mix" => logic::graph::GraphSearchMode::Mix,
        _ => logic::graph::GraphSearchMode::Hybrid,
    };
    let hits = logic::graph::graph_search(user_id, req.query, Some(m), req.limit)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(
        serde_json::to_value(hits).unwrap_or(serde_json::Value::Array(vec![])),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphListRequest {
    limit: Option<usize>,
}
async fn graph_list_handler(
    Extension(user_id): Extension<String>,
    body: Option<Json<GraphListRequest>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let lim = body.and_then(|Json(r)| r.limit);
    let (nodes, edges) = logic::graph::graph_list(&user_id, lim)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({"nodes": nodes, "edges": edges})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphForgetRequest {
    file_ids: Vec<String>,
}
async fn graph_forget_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<GraphForgetRequest>,
) -> Result<Json<usize>, (StatusCode, String)> {
    logic::graph::graph_forget(&user_id, req.file_ids)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn graph_stats_handler(
    Extension(user_id): Extension<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let stats = logic::graph::graph_stats(&user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(
        serde_json::to_value(stats).unwrap_or(serde_json::json!({})),
    ))
}







/// Reads the `kawai_session` cookie (the signed-in email) and injects it as a
/// request extension. 401 on missing/foreign cookie. Uses
/// `from_fn` (state `()`), so it composes with a `Router<()>`.
async fn auth_middleware(mut req: Request, next: Next) -> Response {
    let user_id = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| extract_cookie(s, SESSION_COOKIE))
        .filter(|id| id.starts_with("loc_"))
        .map(str::to_string);
    let Some(user_id) = user_id else {
        return error_response(StatusCode::UNAUTHORIZED, "no session");
    };
    req.extensions_mut().insert(user_id.to_string());
    next.run(req).await
}

fn error_response(status: StatusCode, msg: &str) -> Response {
    let mut resp = Json(ErrorResponse {
        error: msg.to_string(),
    })
    .into_response();
    *resp.status_mut() = status;
    resp
}

fn extract_cookie<'a>(header_value: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    header_value
        .split(';')
        .map(str::trim)
        .find_map(|pair| pair.strip_prefix(&prefix).map(|v| v.trim()))
}

fn event_to_sse(event: ActivityEvent) -> SseFrame {
    let name = match &event {
        ActivityEvent::Started { .. } => "started",
        ActivityEvent::Progress { .. } => "progress",
        ActivityEvent::Finished => "finished",
        ActivityEvent::Error { .. } => "error",
    };
    let data = serde_json::to_string(&event).unwrap_or_default();
    SseFrame::default().event(name).data(data)
}

/// Build the router. `public` holds ops that don't need auth (and the login
/// endpoints); `protected` sits behind `auth_middleware`.
pub fn router(dist_dir: PathBuf) -> Router {
    let public = Router::new()
        .route("/api/greet", post(greet_handler))
        .route("/api/list_agents", post(list_agents_handler))
        .route("/api/generate_activity", post(generate_activity_handler))
        .route("/api/logout", post(logout_handler))
        .route("/api/check_monad_balance", post(check_monad_balance_handler))
        .route("/api/monad_chain_status", post(monad_chain_status_handler))
        // Device-scoped Monad hot wallet — PUBLIC ops: the wallet exists
        // before any session (it creates the identity via SIWE login).
        .route("/api/monad_wallet_address", post(monad_wallet_address_handler))
        .route("/api/monad_wallet_create", post(monad_wallet_create_handler))
        .route("/api/monad_wallet_sign_message", post(monad_wallet_sign_message_handler))
        .route("/api/monad_wallet_delete", post(monad_wallet_delete_handler))
        .route("/api/send_verification_email", post(send_verification_email_handler))
        .route("/api/auth_sign_up", post(auth_sign_up_handler))
        .route("/api/auth_sign_in", post(auth_sign_in_handler));

    let protected = Router::new()
        .route("/api/whoami", post(whoami_handler))
        .route(
            "/api/create_chat_session",
            post(create_chat_session_handler),
        )
        .route("/api/list_chat_sessions", post(list_chat_sessions_handler))
        .route(
            "/api/rename_chat_session",
            post(rename_chat_session_handler),
        )
        .route(
            "/api/set_chat_session_archived",
            post(set_chat_session_archived_handler),
        )
        .route("/api/list_chat_messages", post(list_chat_messages_handler))
        .route(
            "/api/append_chat_message",
            post(append_chat_message_handler),
        )
        .route(
            "/api/delete_chat_session",
            post(delete_chat_session_handler),
        )
        .route("/api/skill_create", post(skill_create_handler))
        .route("/api/skill_list", post(skill_list_handler))
        .route("/api/skill_get", post(skill_get_handler))
        .route("/api/skill_update", post(skill_update_handler))
        .route("/api/skill_delete", post(skill_delete_handler))
        .route("/api/memory_create", post(memory_create_handler))
        .route("/api/memory_list", post(memory_list_handler))
        .route("/api/memory_update", post(memory_update_handler))
        .route("/api/memory_delete", post(memory_delete_handler))
        .route("/api/memory_extract", post(memory_extract_handler))
        .route("/api/memory_search", post(memory_search_handler))
        .route("/api/memory_consolidate", post(memory_consolidate_handler))
        .route("/api/memory_graph_search", post(memory_graph_search_handler))
        .route("/api/memory_graph_export", post(memory_graph_export_handler))
        .route("/api/memory_scene_extract", post(memory_scene_extract_handler))
        .route("/api/memory_scene_list", post(memory_scene_list_handler))
        .route("/api/memory_persona_generate", post(memory_persona_generate_handler))
        .route("/api/memory_persona_get", post(memory_persona_get_handler))
        .route_layer(from_fn(auth_middleware));

    #[cfg(feature = "litert")]
    let protected = protected
        .route("/api/local_load_model", post(local_load_model_handler))
        .route("/api/local_model_status", post(local_model_status_handler))
        .route("/api/local_chat", post(local_chat_handler))
        .route("/api/local_llm_reset", post(local_llm_reset_handler))
        .route(
            "/api/local_llm_set_thinking",
            post(local_llm_set_thinking_handler),
        )
        .route("/api/local_llm_unload", post(local_llm_unload_handler))
        ;

    #[cfg(feature = "litert")]
    let protected = protected.route(
        "/api/execute_supervisor_plan",
        post(execute_supervisor_plan_handler),
    )
    .route(
        "/api/respond_supervisor_confirmation",
        post(respond_supervisor_confirmation_handler),
    )
    .route("/api/plan_task", post(plan_task_handler));

    // Title generation — no LLM feature gate; only needs auth + Cloudflare creds.
    let protected = protected.route(
        "/api/generate_session_title",
        post(generate_session_title_handler),
    );

    let protected = protected
        .route("/api/office_import_file", post(office_import_file_handler))
        .route("/api/office_list_files", post(office_list_files_handler))
        .route("/api/office_list_templates", post(office_list_templates_handler))
        .route("/api/office_bind_template", post(office_bind_template_handler))
        .route("/api/office_peek_template", post(office_peek_template_handler))
        .route(
            "/api/office_read_document",
            post(office_read_document_handler),
        )
        .route("/api/knowledge_context", post(knowledge_context_handler))
        .route("/api/office_index_file", post(office_index_file_handler))
        .route("/api/knowledge_search", post(knowledge_search_handler))
        .route("/api/knowledge_forget", post(knowledge_forget_handler))
        .route("/api/list_session_files", post(list_session_files_handler))
        .route("/api/knowledge_list", post(knowledge_list_handler))
        .route(
            "/api/knowledge_add_to_session",
            post(knowledge_add_to_session_handler),
        )
        .route(
            "/api/knowledge_import_youtube",
            post(knowledge_import_youtube_handler),
        )
        .route("/api/office_delete_file", post(office_delete_file_handler))
        .route(
            "/api/office_restore_backup",
            post(office_restore_backup_handler),
        )
        .route("/api/office_export_file", post(office_export_file_handler))
        .route(
            "/api/office_export_document",
            post(office_export_document_handler),
        )
        .route("/api/office_read_file", post(office_read_file_handler))
        .route("/api/tauri_open_file", post(tauri_open_file_handler))
        .route(
            "/api/office_capabilities",
            post(office_capabilities_handler),
        );

    // SQL data-source profiles: analytics-only (implies office).
    let protected = protected
        .route("/api/data_preview", post(data_preview_handler))
        .route("/api/sql_profile_list", post(sql_profile_list_handler))
        .route("/api/sql_profile_save", post(sql_profile_save_handler))
        .route("/api/sql_profile_delete", post(sql_profile_delete_handler))
        .route("/api/sql_profile_test", post(sql_profile_test_handler));

    // CodeGraph bridge: always registered (no-op when feature off) so the
    // URL contract is stable; real work only with --features codegraph.
    let protected = protected
        .route("/api/codegraph_explore", post(codegraph_explore_handler))
        .route("/api/codegraph_status", post(codegraph_status_handler))
        .route("/api/codegraph_is_available", post(codegraph_is_available_handler))
        .route("/api/codegraph_init", post(codegraph_init_handler));

    // GraphRAG: always registered (handler is no-op when feature off) so the
    // URL contract is stable; real work only with --features graph.
    let protected = protected
        .route("/api/graph_index_file", post(graph_index_file_handler))
        .route("/api/graph_index_text", post(graph_index_text_handler))
        .route("/api/graph_search", post(graph_search_handler))
        .route("/api/graph_list", post(graph_list_handler))
        .route("/api/graph_forget", post(graph_forget_handler))
        .route("/api/graph_stats", post(graph_stats_handler));

    // TTS: always registered so the URL contract is stable; real work only
    // with --features tts (returns 501 when feature is off).
    let protected = protected
        .route("/api/synthesize_speech", post(synthesize_speech_handler));

    let router = Router::new().merge(public).merge(protected);
    // Supervisor confirmation mailbox (litert only — see mod supervisor).
    #[cfg(feature = "litert")]
    let router = router.layer(Extension(crate::supervisor::PendingConfirmations::default()));
    router.fallback_service(ServeDir::new(dist_dir))
}

pub async fn serve(addr: &str, dist_dir: PathBuf) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    axum::serve(listener, router(dist_dir))
        .await
        .map_err(|e| format!("serve kawai-web: {e}"))
}

/// Authenticated RPC: plan a task against the agent's tool catalog.
#[cfg(feature = "litert")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanTaskRequest {
    goal: String,
    session_id: i64,
    agent_id: Option<String>,
}

/// Authenticated RPC: plan a task against the agent's tool catalog. The
/// planner call rides the user's persona + goal-relevant memories + skills.
#[cfg(feature = "litert")]
async fn plan_task_handler(
    Extension(user_id): Extension<String>,
    Json(req): Json<PlanTaskRequest>,
) -> Result<Json<kawai_router::TaskPlan>, (StatusCode, String)> {
    if !kawai_db::session_exists(&user_id, req.session_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    {
        return Err((
            StatusCode::NOT_FOUND,
            format!("session {} not found", req.session_id),
        ));
    }
    let agent_id = req
        .agent_id
        .as_deref()
        .unwrap_or(crate::agent_registry::OFFICE_AGENT_ID);
    let registry = crate::supervisor::build_supervisor_registry(
        &user_id,
        req.session_id,
        agent_id,
    )
    .await
    .ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "supervisor toolset unavailable".to_string(),
    ))?;
    // Usage-based billing is dormant under local auth (no session token is
    // held anywhere) — flat per-turn in the frontend was removed with it.
    crate::supervisor::plan_task(&user_id, &req.goal, &registry)
        .await
        .map(|(plan, _usage)| Json(plan))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Protected streaming: supervisor plan execution via SSE.
#[cfg(feature = "litert")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteSupervisorPlanRequest {
    plan: kawai_router::TaskPlan,
    session_id: i64,
    agent_id: Option<String>,
        stream_id: String,
}

#[cfg(feature = "litert")]
// NOTE: `Json` must stay the LAST extractor — it is the only FromRequest here;
// an extractor placed after it fails Handler resolution at compile time.
async fn execute_supervisor_plan_handler(
    Extension(pending): Extension<crate::supervisor::PendingConfirmations>,
    Extension(user_id): Extension<String>,
    Json(req): Json<ExecuteSupervisorPlanRequest>,
) -> Result<Sse<impl Stream<Item = Result<SseFrame, Infallible>>>, StatusCode> {
    if !kawai_db::session_exists(&user_id, req.session_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Err(StatusCode::NOT_FOUND);
    }

    let agent_id = req
        .agent_id
        .as_deref()
        .unwrap_or(crate::agent_registry::OFFICE_AGENT_ID);
    let tool_registry = crate::supervisor::build_supervisor_registry(
        &user_id,
        req.session_id,
        agent_id,
    )
    .await
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    let stream = crate::supervisor::execute_plan_stream_with_cancel(
        req.plan, tool_registry,
        tokio_util::sync::CancellationToken::new(), pending,
        req.stream_id,
    );
    let s = stream.map(|event| {
        let name = match &event {
            crate::supervisor::SupervisorEvent::PlanStarted { .. } => "planStarted",
            crate::supervisor::SupervisorEvent::StepStarted { .. } => "stepStarted",
            crate::supervisor::SupervisorEvent::StepCompleted { .. } => "stepCompleted",
            crate::supervisor::SupervisorEvent::StepFailed { .. } => "stepFailed",
            crate::supervisor::SupervisorEvent::StepSkipped { .. } => "stepSkipped",
            crate::supervisor::SupervisorEvent::ConfirmationRequested { .. } => {
                "confirmationRequested"
            }
            crate::supervisor::SupervisorEvent::PlanCompleted { .. } => "planCompleted",
            crate::supervisor::SupervisorEvent::PlanFailed { .. } => "planFailed",
        };
        let data = serde_json::to_string(&event).unwrap_or_default();
        Ok::<_, Infallible>(SseFrame::default().event(name).data(data))
    });
    Ok(Sse::new(s).keep_alive(KeepAlive::default()))
}

#[cfg(feature = "litert")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondSupervisorConfirmationRequest {
    stream_id: String,
    step_id: String,
    approved: bool,
}

#[cfg(feature = "litert")]
async fn respond_supervisor_confirmation_handler(
    Extension(pending): Extension<crate::supervisor::PendingConfirmations>,
    Json(req): Json<RespondSupervisorConfirmationRequest>,
) -> Result<StatusCode, StatusCode> {
    let sender = pending.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .remove(&crate::supervisor::confirmation_key(&req.stream_id, &req.step_id)).ok_or(StatusCode::NOT_FOUND)?;
    let _ = sender.send(req.approved);
    Ok(StatusCode::NO_CONTENT)
}

// ── TTS (piper-rs, feature "tts") ──────────────────────────────────────────
// Always compiled so the router is static; inner dispatch is cfg-gated.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SynthesizeSpeechRequest {
    text: String,
    voice: Option<String>,
    length_scale: Option<f32>,
}

/// Protected RPC: synthesize speech via Piper neural TTS.
/// Returns base64-encoded WAV audio. Returns 501 when tts feature is off.
async fn synthesize_speech_handler(
    Json(req): Json<SynthesizeSpeechRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    let (samples, sample_rate) = crate::logic::tts::synthesize(
        &req.text,
        req.voice.as_deref(),
        req.length_scale,
    )
    .await
    .map_err(|e| (StatusCode::NOT_IMPLEMENTED, e.to_string()))?;

    let wav = crate::logic::tts::pcm_to_wav(&samples, sample_rate);
    // base64 is always available (office deps); synthesis only succeeds when
    // tts is on, so this is always reachable when we get here.
    use base64::Engine;
    Ok(Json(base64::engine::general_purpose::STANDARD.encode(&wav)))
}
