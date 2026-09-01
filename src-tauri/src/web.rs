use crate::auth::{Claims, Verifier};
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<MemoryCreateRequest>,
) -> Result<Json<logic::memory::MemoryItem>, (StatusCode, String)> {
    logic::memory::memory_create(&claims.sub, &req.kind, &req.title, &req.content)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn memory_list_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<logic::memory::MemoryItem>>, (StatusCode, String)> {
    logic::memory::memory_list(&claims.sub)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn memory_update_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<MemoryUpdateRequest>,
) -> Result<Json<Option<logic::memory::MemoryItem>>, (StatusCode, String)> {
    logic::memory::memory_update(
        &claims.sub,
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<MemoryDeleteRequest>,
) -> Result<Json<bool>, (StatusCode, String)> {
    logic::memory::memory_delete(&claims.sub, &req.memory_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn memory_extract_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<MemoryExtractRequest>,
) -> Result<Json<Vec<logic::memory::MemoryItem>>, (StatusCode, String)> {
    logic::memory::memory_extract(&claims.sub, req.session_id)
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<MemorySearchRequest>,
) -> Result<Json<Vec<logic::memory::MemoryItem>>, (StatusCode, String)> {
    logic::memory::memory_search(&claims.sub, &req.query, req.limit)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryConsolidateRequest {}

async fn memory_consolidate_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<logic::memory::ConsolidationReport>, (StatusCode, String)> {
    logic::memory::memory_consolidate(&claims.sub)
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<MemoryGraphSearchRequest>,
) -> Result<Json<Vec<logic::memory::MemoryGraphHit>>, (StatusCode, String)> {
    logic::memory::memory_graph_search(&claims.sub, &req.query, req.limit)
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<MemoryGraphExportRequest>,
) -> Result<Json<logic::memory::MemoryGraphExport>, (StatusCode, String)> {
    logic::memory::memory_graph_export(&claims.sub, req.limit)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemorySceneExtractRequest {}

async fn memory_scene_extract_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<logic::memory::SceneHit>>, (StatusCode, String)> {
    logic::memory::memory_scene_extract(&claims.sub)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemorySceneListRequest {}

async fn memory_scene_list_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<logic::memory::SceneHit>>, (StatusCode, String)> {
    logic::memory::memory_scene_list(&claims.sub)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryPersonaGenerateRequest {}

async fn memory_persona_generate_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<String>, (StatusCode, String)> {
    logic::memory::memory_persona_generate(&claims.sub)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryPersonaGetRequest {}

async fn memory_persona_get_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<Option<String>>, (StatusCode, String)> {
    logic::memory::memory_persona_get(&claims.sub)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn skill_create_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<SkillCreateRequest>,
) -> Result<Json<logic::skills::Skill>, (StatusCode, String)> {
    logic::skills::skill_create(
        &claims.sub,
        &req.name,
        req.description.as_deref().unwrap_or(""),
        &req.content,
    )
    .await
    .map(Json)
    .map_err(|e| (db_status(&e), e.to_string()))
}

async fn skill_list_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<logic::skills::SkillSummary>>, (StatusCode, String)> {
    logic::skills::skill_list(&claims.sub)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn skill_get_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<SkillGetRequest>,
) -> Result<Json<Option<logic::skills::Skill>>, (StatusCode, String)> {
    logic::skills::skill_get(&claims.sub, &req.skill_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
}

async fn skill_update_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<SkillUpdateRequest>,
) -> Result<Json<Option<logic::skills::Skill>>, (StatusCode, String)> {
    logic::skills::skill_update(
        &claims.sub,
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<SkillDeleteRequest>,
) -> Result<Json<bool>, (StatusCode, String)> {
    logic::skills::skill_delete(&claims.sub, &req.skill_id)
        .await
        .map(Json)
        .map_err(|e| (db_status(&e), e.to_string()))
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
async fn list_agents_handler() -> Json<Vec<crate::agent_registry::AgentInfo>> {
    Json(crate::agent_registry::builtin().list())
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
    logic::create_chat_session(&claims.sub)
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

/// Protected RPC: return the current on-device model status.
#[cfg(feature = "litert")]
async fn local_model_status_handler(
    Extension(claims): Extension<Claims>,
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

// ── SQL data-source profiles (analytics agent) ──────────────────────────────

#[cfg(feature = "analytics")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataPreviewRequest {
    file_id: String,
}

#[cfg(feature = "analytics")]
async fn data_preview_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<DataPreviewRequest>,
) -> Result<Json<logic::analytics::SchemaInfo>, (StatusCode, String)> {
    logic::analytics::data_preview(&claims.sub, &req.file_id)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

#[cfg(feature = "analytics")]
async fn sql_profile_list_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<logic::analytics::SqlProfile>>, (StatusCode, String)> {
    logic::analytics::sql_profile_list(&claims.sub)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "analytics")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlProfileSaveRequest {
    name: String,
    source: String,
}

#[cfg(feature = "analytics")]
async fn sql_profile_save_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<SqlProfileSaveRequest>,
) -> Result<Json<logic::analytics::SqlProfile>, (StatusCode, String)> {
    logic::analytics::sql_profile_save(&claims.sub, &req.name, &req.source)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

#[cfg(feature = "analytics")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlProfileDeleteRequest {
    name: String,
}

#[cfg(feature = "analytics")]
async fn sql_profile_delete_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<SqlProfileDeleteRequest>,
) -> Result<Json<()>, (StatusCode, String)> {
    logic::analytics::sql_profile_delete(&claims.sub, &req.name)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "analytics")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SqlProfileTestRequest {
    name: String,
}

#[cfg(feature = "analytics")]
async fn sql_profile_test_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<SqlProfileTestRequest>,
) -> Result<Json<logic::analytics::SqlProfileTest>, (StatusCode, String)> {
    logic::analytics::sql_profile_test(&claims.sub, &req.name)
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
async fn office_restore_backup_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<OfficeDeleteFileRequest>,
) -> Result<Json<logic::office::OfficeFile>, (StatusCode, String)> {
    logic::office::store::restore_backup(&claims.sub, &req.file_id)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[cfg(feature = "office")]
async fn office_list_templates_handler() -> Json<Vec<logic::office::TemplateListing>> {
    Json(logic::office::list_templates())
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
struct OfficeExportDocumentRequest {
    markdown: String,
    format: String,
}

#[cfg(feature = "office")]
async fn office_export_document_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<OfficeExportDocumentRequest>,
) -> Result<Response, (StatusCode, String)> {
    let _ = &claims.sub;
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

#[cfg(feature = "office")]
async fn tauri_open_file_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<OfficeReadFileRequest>,
) -> Result<Json<String>, (StatusCode, String)> {
    logic::office::file_path(&claims.sub, &req.file_id)
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<CodegraphExploreRequest>,
) -> Result<Json<logic::codegraph::CodegraphExploreResult>, (StatusCode, String)> {
    logic::codegraph::codegraph_explore(&claims.sub, req.query, req.project_path)
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<CodegraphStatusRequest>,
) -> Result<Json<logic::codegraph::CodegraphStatusResult>, (StatusCode, String)> {
    logic::codegraph::codegraph_status(&claims.sub, req.project_path)
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<CodegraphInitRequest>,
) -> Result<Json<logic::codegraph::CodegraphStatusResult>, (StatusCode, String)> {
    logic::codegraph::codegraph_init(&claims.sub, req.project_path)
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
    Extension(claims): Extension<Claims>,
    Json(req): Json<GraphIndexFileRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    #[cfg(feature = "graph")]
    {
        let (n, e) = logic::graph::graph_index_file(claims.sub, req.file_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(Json(serde_json::json!({"nodes": n, "edges": e})))
    }
    #[cfg(not(feature = "graph"))]
    {
        let _ = (claims, req);
        Err((
            StatusCode::NOT_IMPLEMENTED,
            "graph feature not enabled (build with --features graph)".into(),
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphIndexTextRequest {
    file_id: String,
    text: String,
}
async fn graph_index_text_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<GraphIndexTextRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    #[cfg(feature = "graph")]
    {
        let (n, e) = logic::graph::graph_index_text(&claims.sub, &req.file_id, &req.text)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(Json(serde_json::json!({"nodes": n, "edges": e})))
    }
    #[cfg(not(feature = "graph"))]
    {
        let _ = (claims, req);
        Err((
            StatusCode::NOT_IMPLEMENTED,
            "graph feature not enabled".into(),
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphSearchRequest {
    query: String,
    mode: Option<String>,
    limit: Option<usize>,
}
async fn graph_search_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<GraphSearchRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    #[cfg(feature = "graph")]
    {
        let m = match req.mode.as_deref().unwrap_or("hybrid") {
            "naive" => logic::graph::GraphSearchMode::Naive,
            "local" => logic::graph::GraphSearchMode::Local,
            "global" => logic::graph::GraphSearchMode::Global,
            "mix" => logic::graph::GraphSearchMode::Mix,
            _ => logic::graph::GraphSearchMode::Hybrid,
        };
        let hits = logic::graph::graph_search(claims.sub, req.query, Some(m), req.limit)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(Json(
            serde_json::to_value(hits).unwrap_or(serde_json::Value::Array(vec![])),
        ))
    }
    #[cfg(not(feature = "graph"))]
    {
        let _ = (claims, req);
        Err((
            StatusCode::NOT_IMPLEMENTED,
            "graph feature not enabled".into(),
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphListRequest {
    limit: Option<usize>,
}
async fn graph_list_handler(
    Extension(claims): Extension<Claims>,
    body: Option<Json<GraphListRequest>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    #[cfg(feature = "graph")]
    {
        let lim = body.and_then(|Json(r)| r.limit);
        let (nodes, edges) = logic::graph::graph_list(&claims.sub, lim)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(Json(serde_json::json!({"nodes": nodes, "edges": edges})))
    }
    #[cfg(not(feature = "graph"))]
    {
        let _ = (claims, body);
        Err((
            StatusCode::NOT_IMPLEMENTED,
            "graph feature not enabled".into(),
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphForgetRequest {
    file_ids: Vec<String>,
}
async fn graph_forget_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<GraphForgetRequest>,
) -> Result<Json<usize>, (StatusCode, String)> {
    #[cfg(feature = "graph")]
    {
        logic::graph::graph_forget(&claims.sub, req.file_ids)
            .await
            .map(Json)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
    }
    #[cfg(not(feature = "graph"))]
    {
        let _ = (claims, req);
        Err((
            StatusCode::NOT_IMPLEMENTED,
            "graph feature not enabled".into(),
        ))
    }
}

async fn graph_stats_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    #[cfg(feature = "graph")]
    {
        let stats = logic::graph::graph_stats(&claims.sub)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(Json(
            serde_json::to_value(stats).unwrap_or(serde_json::json!({})),
        ))
    }
    #[cfg(not(feature = "graph"))]
    {
        let _ = claims;
        Err((
            StatusCode::NOT_IMPLEMENTED,
            "graph feature not enabled".into(),
        ))
    }
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

    let protected = protected.route(
        "/api/generate_session_title",
        post(generate_session_title_handler),
    );

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

    #[cfg(all(feature = "router", feature = "litert"))]
    let protected = protected.route(
        "/api/execute_supervisor_plan",
        post(execute_supervisor_plan_handler),
    )
    .route(
        "/api/respond_supervisor_confirmation",
        post(respond_supervisor_confirmation_handler),
    )
    .route("/api/plan_task", post(plan_task_handler));

    #[cfg(feature = "office")]
    let protected = protected
        .route("/api/office_import_file", post(office_import_file_handler))
        .route("/api/office_list_files", post(office_list_files_handler))
        .route("/api/office_list_templates", post(office_list_templates_handler))
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
    #[cfg(feature = "analytics")]
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

    Router::new()
        .merge(public)
        .merge(protected)
        .layer(Extension(verifier))
        .fallback_service(ServeDir::new(dist_dir))
}

pub async fn serve(addr: &str, dist_dir: PathBuf, verifier: Verifier) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    axum::serve(listener, router(dist_dir, verifier))
        .await
        .map_err(|e| format!("serve kawai-web: {e}"))
}

/// Authenticated RPC: plan a task against the agent's tool catalog.
#[cfg(all(feature = "router", feature = "litert"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanTaskRequest {
    goal: String,
    session_id: i64,
    agent_id: Option<String>,
}

/// Authenticated RPC: plan a task against the agent's tool catalog. The
/// planner call rides the user's persona + goal-relevant memories + skills.
#[cfg(all(feature = "router", feature = "litert"))]
async fn plan_task_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<PlanTaskRequest>,
) -> Result<Json<kawai_router::TaskPlan>, (StatusCode, String)> {
    if !kawai_db::session_exists(&claims.sub, req.session_id)
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
        &claims.sub,
        req.session_id,
        agent_id,
    )
    .await
    .ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "supervisor toolset unavailable".to_string(),
    ))?;
    crate::supervisor::plan_task(&claims.sub, &req.goal, &registry)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Protected streaming: supervisor plan execution via SSE.
#[cfg(all(feature = "router", feature = "litert"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteSupervisorPlanRequest {
    plan: kawai_router::TaskPlan,
    session_id: i64,
    agent_id: Option<String>,
        stream_id: String,
}

#[cfg(all(feature = "router", feature = "litert"))]
async fn execute_supervisor_plan_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<ExecuteSupervisorPlanRequest>,
    Extension(pending): Extension<crate::supervisor::PendingConfirmations>,
) -> Result<Sse<impl Stream<Item = Result<SseFrame, Infallible>>>, StatusCode> {
    if !kawai_db::session_exists(&claims.sub, req.session_id)
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
        &claims.sub,
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
            crate::supervisor::SupervisorEvent::PlanCompleted { .. } => "planCompleted",
            crate::supervisor::SupervisorEvent::PlanFailed { .. } => "planFailed",
        };
        let data = serde_json::to_string(&event).unwrap_or_default();
        Ok::<_, Infallible>(SseFrame::default().event(name).data(data))
    });
    Ok(Sse::new(s).keep_alive(KeepAlive::default()))
}

#[cfg(all(feature = "router", feature = "litert"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondSupervisorConfirmationRequest {
    stream_id: String,
    step_id: String,
    approved: bool,
}

#[cfg(all(feature = "router", feature = "litert"))]
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
    // base64 is available when tts or office feature is on; synthesis only
    // succeeds when tts is on, so this is always reachable when we get here.
    #[cfg(any(feature = "tts", feature = "office"))]
    {
        use base64::Engine;
        Ok(Json(base64::engine::general_purpose::STANDARD.encode(&wav)))
    }
    #[cfg(not(any(feature = "tts", feature = "office")))]
    {
        // Dead code: synthesis always fails when tts is off.
        // But the compiler needs a return path.
        Err((StatusCode::NOT_IMPLEMENTED, "base64 not available".into()))
    }
}
