use crate::auth::{Claims, Verifier};
use crate::logic::{self, ActivityEvent, ActivityInput, Note, NoteEvent, UserInfo};
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

#[derive(Deserialize)]
struct CreateNoteRequest {
    body: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

async fn greet_handler(Json(req): Json<GreetRequest>) -> Json<String> {
    Json(logic::greet(&req.name))
}

async fn generate_activity_handler(
    Json(input): Json<ActivityInput>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    let s = logic::generate_activity(input)
        .map(|event| Ok::<_, Infallible>(event_to_sse(event)));
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

/// Protected RPC: create a note scoped to the signed-in user.
async fn create_note_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateNoteRequest>,
) -> Result<Json<Note>, (StatusCode, String)> {
    logic::create_note(&claims.sub, &req.body)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Protected RPC: list the signed-in user's notes.
async fn list_notes_handler(
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<Note>>, (StatusCode, String)> {
    logic::list_notes(&claims.sub)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Protected streaming: notes via SSE, same shape as `generate_activity`.
async fn stream_notes_handler(
    Extension(claims): Extension<Claims>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    let s = logic::stream_notes(claims.sub)
        .map(|event| Ok::<_, Infallible>(note_event_to_sse(event)));
    Sse::new(s).keep_alive(KeepAlive::default())
}

fn note_event_to_sse(event: NoteEvent) -> SseFrame {
    let name = match &event {
        NoteEvent::Notes { .. } => "notes",
        NoteEvent::Finished => "finished",
        NoteEvent::Error { .. } => "error",
    };
    let data = serde_json::to_string(&event).unwrap_or_default();
    SseFrame::default().event(name).data(data)
}

/// Protected RPC: load an on-device model (`.litertlm`).
#[cfg(feature = "litert")]
#[derive(Deserialize)]
struct LocalLoadModelRequest {
    model_path: String,
    gpu: Option<bool>,
    speculative_decoding: Option<bool>,
}

#[cfg(feature = "litert")]
async fn local_load_model_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<LocalLoadModelRequest>,
) -> Result<Json<logic::local_llm::LocalModelInfo>, (StatusCode, String)> {
    logic::local_llm::load_model(
        &claims.sub,
        &req.model_path,
        req.gpu.unwrap_or(true),
        req.speculative_decoding.unwrap_or(false),
    )
    .await
    .map(Json)
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Protected streaming: on-device chat via SSE, same shape as `stream_notes`.
#[cfg(feature = "litert")]
#[derive(Deserialize)]
struct LocalChatRequest {
    prompt: String,
}

#[cfg(feature = "litert")]
async fn local_chat_handler(
    Extension(claims): Extension<Claims>,
    Json(req): Json<LocalChatRequest>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    let s = logic::local_llm::local_chat(claims.sub, req.prompt)
        .map(|event| Ok::<_, Infallible>(local_event_to_sse(event)));
    Sse::new(s).keep_alive(KeepAlive::default())
}

#[cfg(feature = "litert")]
fn local_event_to_sse(event: logic::local_llm::LocalChatEvent) -> SseFrame {
    use logic::local_llm::LocalChatEvent;
    let name = match &event {
        LocalChatEvent::Started => "started",
        LocalChatEvent::Token { .. } => "token",
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
        .route("/api/generate_activity", post(generate_activity_handler))
        .route("/api/set_session", post(set_session_handler))
        .route("/api/logout", post(logout_handler));

    let protected = Router::new()
        .route("/api/whoami", post(whoami_handler))
        .route("/api/create_note", post(create_note_handler))
        .route("/api/list_notes", post(list_notes_handler))
        .route("/api/stream_notes", post(stream_notes_handler))
        .route_layer(from_fn(auth_middleware));

    #[cfg(feature = "litert")]
    let protected = protected
        .route("/api/local_load_model", post(local_load_model_handler))
        .route("/api/local_chat", post(local_chat_handler))
        .route("/api/local_llm_reset", post(local_llm_reset_handler))
        .route(
            "/api/local_llm_set_thinking",
            post(local_llm_set_thinking_handler),
        )
        .route("/api/local_llm_unload", post(local_llm_unload_handler));

    Router::new()
        .merge(public)
        .merge(protected)
        .layer(Extension(verifier))
        .fallback_service(ServeDir::new(dist_dir))
}

pub async fn serve(addr: &str, dist_dir: PathBuf, verifier: Verifier) {
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, router(dist_dir, verifier)).await.unwrap();
}
