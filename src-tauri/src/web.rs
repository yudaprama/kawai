use crate::auth::{Claims, Verifier};
use crate::logic::{
    self, ActivityEvent, ActivityInput, ChatMessage, ChatSession, UserInfo,
};
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
struct CreateChatSessionRequest {
    agent_id: Option<String>,
}

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateSessionTitleRequest {
    session_id: i64,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

async fn greet_handler(Json(req): Json<GreetRequest>) -> Json<String> {
    Json(logic::greet(&req.name))
}

/// Public RPC: the agent catalog (same op as the Tauri `list_agents` command).
async fn list_agents_handler() -> Json<Vec<logic::agent::AgentInfo>> {
    Json(logic::agent::list_agents())
}

async fn generate_activity_handler(
    Json(input): Json<ActivityInput>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    let s = logic::generate_activity(input).map(|event| Ok::<_, Infallible>(event_to_sse(event)));
    Sse::new(s).keep_alive(KeepAlive::default())
}

/// Verify the posted JWT and set the session cookie. Not behind the auth
/// middleware (it IS the login). Returns the resolved user.
///
/// Reads `Verifier` from `Extension` (not `State`) so this handler doesn't
/// force the router to be parameterized by a state type — that lets the
/// protected sub-router stay `Router<()>` and merge cleanly. The Tauri twin
/// uses `State<Verifier>` (its native injection); the difference lives here in
/// the wrapper, not in `logic.rs`.
async fn set_session_handler(
    Extension(verifier): Extension<Verifier>,
    Json(req): Json<SetSessionRequest>,
) -> Response {
    match verifier.verify(&req.token).await {
        Ok(claims) => {
            let user = logic::whoami(&claims.sub);
            // NOTE: `Secure` is intentionally omitted so this works on plain
            // HTTP localhost dev. Behind a real HTTPS origin, add `; Secure`.
            let cookie = format!(
                "{SESSION_COOKIE}={}; HttpOnly; SameSite=Lax; Path=/; Max-Age={COOKIE_MAX_AGE}",
                req.token
            );
            let mut resp = Json(user).into_response();
            if let Ok(val) = HeaderValue::from_str(&cookie) {
                resp.headers_mut().append(header::SET_COOKIE, val);
            }
            resp
        }
        Err(e) => error_response(StatusCode::UNAUTHORIZED, &e.to_string()),
    }
}

async fn logout_handler() -> Response {
    let cookie = format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    let mut resp = StatusCode::NO_CONTENT.into_response();
    if let Ok(val) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().append(header::SET_COOKIE, val);
    }
    resp
}

/// Protected: identity is injected by `auth_middleware` as `Extension<Claims>`.
async fn whoami_handler(Extension(claims): Extension<Claims>) -> Json<UserInfo> {
    Json(logic::whoami(&claims.sub))
}

/// Map DbError to an HTTP status: NotFound → 404, everything else 500.
fn db_status(e: &logic::DbError) -> StatusCode {
    if matches!(e, logic::DbError::NotFound(_)) {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

/// Protected RPC: start a new chat session (agent-ready schema; MVP uses the
/// implicit builtin agent when `agentId` is absent).
async fn create_chat_session_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateChatSessionRequest>,
) -> Result<Json<ChatSession>, (StatusCode, String)> {
    logic::create_chat_session(&claims.sub, req.agent_id.as_deref())
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: list the user's chat sessions, newest first. Defaults to the
/// active (non-archived) sidebar list; `{ "archived": true }` for the archive.
/// The body is optional so an empty POST lists the active sessions.
async fn list_chat_sessions_handler(
    Extension(claims): Extension<Claims>,
    body: Option<Json<ListChatSessionsRequest>>,
) -> Result<Json<Vec<ChatSession>>, (StatusCode, String)> {
    let archived = body.and_then(|Json(req)| req.archived).unwrap_or(false);
    logic::list_chat_sessions(&claims.sub, archived)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: rename a session (sidebar inline rename).
async fn rename_chat_session_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<RenameChatSessionRequest>,
) -> Result<Json<ChatSession>, (StatusCode, String)> {
    logic::rename_chat_session(&claims.sub, req.session_id, &req.title)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: archive or restore a session.
async fn set_chat_session_archived_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<SetChatSessionArchivedRequest>,
) -> Result<Json<ChatSession>, (StatusCode, String)> {
    logic::set_chat_session_archived(&claims.sub, req.session_id, req.archived)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: list a session's messages, oldest first.
async fn list_chat_messages_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<ListChatMessagesRequest>,
) -> Result<Json<Vec<ChatMessage>>, (StatusCode, String)> {
    logic::list_chat_messages(&claims.sub, req.session_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

/// Protected RPC: append a message to a session.
async fn append_chat_message_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<AppendChatMessageRequest>,
) -> Result<Json<ChatMessage>, (StatusCode, String)> {
    logic::append_chat_message(&claims.sub, req.session_id, &req.role, &req.content)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn delete_chat_session_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<DeleteChatSessionRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::delete_chat_session(&claims.sub, req.session_id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn generate_session_title_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<GenerateSessionTitleRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::generate_session_title(&claims.sub, req.session_id)
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<LocalLoadModelRequest>,
) -> Result<Json<logic::local_llm::LocalModelInfo>, (StatusCode, String)> {
    let model_path = match req.model_path {
        Some(p) if !p.is_empty() => p,
        _ => logic::resolve_model_path()?,
    };
    logic::local_llm::load_model(
        &claims.sub,
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<LocalChatRequest>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    let s = logic::local_llm::local_chat(claims.sub, req.prompt, req.image, req.audio)
        .map(|event| Ok::<_, Infallible>(local_event_to_sse(event)));
    Sse::new(s).keep_alive(KeepAlive::default())
}

#[cfg(feature = "litert")]
fn local_event_to_sse(event: logic::local_llm::LocalChatEvent) -> SseFrame {
    use logic::local_llm::LocalChatEvent;
    let name = match &event {
        LocalChatEvent::Started => "started",
        LocalChatEvent::Token { .. } => "token",
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
    Extension(claims): Extension<Claims>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::local_llm::reset_conversation(&claims.sub)
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<LocalSetThinkingRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::local_llm::set_thinking(&claims.sub, req.enabled);
    Ok(StatusCode::NO_CONTENT)
}

/// Protected RPC: unload the on-device model and free all resources.
#[cfg(feature = "litert")]
async fn local_llm_unload_handler(
    Extension(claims): Extension<Claims>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::local_llm::unload_model(&claims.sub)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

// ── Office document ops (feature "office") ──────────────────────────────────

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeImportFileRequest {
    source_path: Option<String>,
    name: Option<String>,
    data_base64: Option<String>,
}

#[cfg(feature = "office")]
async fn office_import_file_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<OfficeImportFileRequest>,
) -> Result<Json<logic::office::OfficeFile>, (StatusCode, String)> {
    let result = match (
        req.source_path.as_deref(),
        (req.name.as_deref(), req.data_base64.as_deref()),
    ) {
        (Some(src), _) => logic::office::import_path(&claims.sub, src),
        (None, (Some(name), Some(data))) => logic::office::import_base64(&claims.sub, name, data),
        _ => Err("provide sourcePath, or name + dataBase64".into()),
    };
    result.map(Json).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeContextRequest {
    file_ids: Vec<String>,
}

#[cfg(feature = "office")]
async fn knowledge_context_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<KnowledgeContextRequest>,
) -> Result<Json<logic::office::KnowledgeContext>, (StatusCode, String)> {
    logic::office::knowledge_context(&claims.sub, &req.file_ids)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSearchRequest {
    session_id: i64,
    query: String,
    mode: Option<logic::rag::SearchMode>,
}

#[cfg(feature = "office")]
async fn knowledge_search_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<KnowledgeSearchRequest>,
) -> Result<Json<Vec<logic::rag::RagHit>>, (StatusCode, String)> {
    logic::rag::knowledge_search(claims.sub, req.session_id, req.query, req.mode)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeForgetRequest {
    session_id: Option<i64>,
    file_ids: Vec<String>,
}

#[cfg(feature = "office")]
async fn knowledge_forget_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<KnowledgeForgetRequest>,
) -> Result<Json<usize>, (StatusCode, String)> {
    logic::rag::forget_file(claims.sub, req.session_id, req.file_ids)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSessionFilesRequest {
    session_id: i64,
}

#[cfg(feature = "office")]
async fn list_session_files_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<ListSessionFilesRequest>,
) -> Result<Json<Vec<logic::office::OfficeFile>>, (StatusCode, String)> {
    logic::rag::list_session_files(&claims.sub, req.session_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeIndexFileRequest {
    session_id: Option<i64>,
    file_id: String,
}

#[cfg(feature = "office")]
async fn office_index_file_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<OfficeIndexFileRequest>,
) -> Result<Json<usize>, (StatusCode, String)> {
    logic::rag::office_index_file(claims.sub, req.session_id, req.file_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeListRequest {
    session_id: Option<i64>,
}

#[cfg(feature = "office")]
async fn knowledge_list_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<KnowledgeListRequest>,
) -> Result<Json<Vec<logic::rag::KnowledgeFileInfo>>, (StatusCode, String)> {
    logic::rag::knowledge_list(&claims.sub, req.session_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeAddToSessionRequest {
    session_id: i64,
    file_ids: Vec<String>,
}

#[cfg(feature = "office")]
async fn knowledge_add_to_session_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<KnowledgeAddToSessionRequest>,
) -> Result<Json<usize>, (StatusCode, String)> {
    logic::rag::knowledge_add_to_session(&claims.sub, req.session_id, &req.file_ids)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeImportYoutubeRequest {
    url: String,
    session_id: Option<i64>,
}

#[cfg(feature = "office")]
async fn knowledge_import_youtube_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<KnowledgeImportYoutubeRequest>,
) -> Result<Json<logic::office::OfficeFile>, (StatusCode, String)> {
    logic::rag::knowledge_import_youtube(&claims.sub, req.session_id, &req.url)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeDeleteFileRequest {
    file_id: String,
}

#[cfg(feature = "office")]
async fn office_delete_file_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<OfficeDeleteFileRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    logic::rag::office_delete_file(&claims.sub, &req.file_id)
        .await
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
async fn office_list_files_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<logic::office::OfficeFile>>, (StatusCode, String)> {
    logic::office::list_files(&claims.sub)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeReadDocumentRequest {
    file_id: String,
}

#[cfg(feature = "office")]
async fn office_read_document_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<OfficeReadDocumentRequest>,
) -> Result<Json<logic::office::ReadDocumentResult>, (StatusCode, String)> {
    let markdown = logic::office::read_document(&claims.sub, &req.file_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(logic::office::ReadDocumentResult { markdown }))
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeExportFileRequest {
    file_id: String,
    dest_path: Option<String>,
}

#[cfg(feature = "office")]
async fn office_export_file_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<OfficeExportFileRequest>,
) -> Result<Json<std::collections::HashMap<String, String>>, (StatusCode, String)> {
    logic::office::export_file(&claims.sub, &req.file_id, req.dest_path.as_deref())
        .map(|path| {
            Json(std::collections::HashMap::from([(
                "path".to_string(),
                path,
            )]))
        })
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
async fn office_capabilities_handler(
    Extension(claims): Extension<Claims>,
) -> Json<logic::office::OfficeCapabilities> {
    let _ = &claims.sub;
    Json(logic::office::capabilities())
}

#[cfg(feature = "office")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeReadFileRequest {
    file_id: String,
}

#[cfg(feature = "office")]
async fn office_read_file_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<OfficeReadFileRequest>,
) -> Result<Json<logic::office::ReadFileResult>, (StatusCode, String)> {
    logic::office::read_file_b64(&claims.sub, &req.file_id)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Protected streaming: agent chat (tool-calling loop) via SSE.
#[cfg(feature = "litert")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentChatRequest {
    agent_id: String,
    session_id: Option<i64>,
    message: String,
}

#[cfg(feature = "litert")]
async fn agent_chat_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<AgentChatRequest>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    let s = logic::agent::agent_chat(claims.sub, req.agent_id, req.session_id, req.message)
        .map(|event| Ok::<_, Infallible>(agent_event_to_sse(event)));
    Sse::new(s).keep_alive(KeepAlive::default())
}

#[cfg(feature = "litert")]
fn agent_event_to_sse(event: logic::agent::AgentChatEvent) -> SseFrame {
    use logic::agent::AgentChatEvent;
    let name = match &event {
        AgentChatEvent::Started { .. } => "started",
        AgentChatEvent::Token { .. } => "token",
        AgentChatEvent::ToolCall { .. } => "toolCall",
        AgentChatEvent::ToolResult { .. } => "toolResult",
        AgentChatEvent::Finished => "finished",
        AgentChatEvent::Error { .. } => "error",
    };
    let data = serde_json::to_string(&event).unwrap_or_default();
    SseFrame::default().event(name).data(data)
}

/// Reads the `kawai_session` cookie, verifies it, and injects `Claims` as a
/// request extension. 401 on missing/expired token. Uses `from_fn` (state `()`)
/// and pulls `Verifier` from `Extension`, so it composes with a `Router<()>`.
async fn auth_middleware(
    Extension(verifier): Extension<Verifier>,
    mut req: Request,
    next: Next,
) -> Response {
    let token = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| extract_cookie(s, SESSION_COOKIE));
    let Some(token) = token else {
        return error_response(StatusCode::UNAUTHORIZED, "no session");
    };
    match verifier.verify(token).await {
        Ok(claims) => {
            req.extensions_mut().insert(claims);
            next.run(req).await
        }
        Err(e) => error_response(StatusCode::UNAUTHORIZED, &e.to_string()),
    }
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
/// endpoints); `protected` sits behind `auth_middleware`. The single `Verifier`
/// is shared via an `Extension` layer so both can read it without a state type.
pub fn router(dist_dir: PathBuf, verifier: Verifier) -> Router {
    let public = Router::new()
        .route("/api/greet", post(greet_handler))
        .route("/api/list_agents", post(list_agents_handler))
        .route("/api/generate_activity", post(generate_activity_handler))
        .route("/api/set_session", post(set_session_handler))
        .route("/api/logout", post(logout_handler));

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
        .route_layer(from_fn(auth_middleware));

    let protected = protected.route(
        "/api/generate_session_title",
        post(generate_session_title_handler),
    );

    #[cfg(feature = "litert")]
    let protected = protected
        .route("/api/local_load_model", post(local_load_model_handler))
        .route("/api/local_chat", post(local_chat_handler))
        .route("/api/local_llm_reset", post(local_llm_reset_handler))
        .route(
            "/api/local_llm_set_thinking",
            post(local_llm_set_thinking_handler),
        )
        .route("/api/local_llm_unload", post(local_llm_unload_handler))
        .route("/api/agent_chat", post(agent_chat_handler));

    #[cfg(feature = "office")]
    let protected = protected
        .route("/api/office_import_file", post(office_import_file_handler))
        .route("/api/office_list_files", post(office_list_files_handler))
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
        .route("/api/office_export_file", post(office_export_file_handler))
        .route("/api/office_read_file", post(office_read_file_handler))
        .route(
            "/api/office_capabilities",
            post(office_capabilities_handler),
        );

    Router::new()
        .merge(public)
        .merge(protected)
        .layer(Extension(verifier))
        .fallback_service(ServeDir::new(dist_dir))
}

pub async fn serve(addr: &str, dist_dir: PathBuf, verifier: Verifier) {
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, router(dist_dir, verifier))
        .await
        .unwrap();
}
