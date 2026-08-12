use crate::logic::{self, ActivityEvent, ActivityInput};
use axum::{
    extract::Json,
    response::{
        sse::{Event, KeepAlive},
        Sse,
    },
    routing::post,
    Router,
};
use futures_core::Stream;
use futures_util::StreamExt;
use serde::Deserialize;
use std::{convert::Infallible, path::PathBuf};
use tower_http::services::ServeDir;

#[derive(Deserialize)]
struct GreetRequest {
    name: String,
}

async fn greet_handler(Json(req): Json<GreetRequest>) -> Json<String> {
    Json(logic::greet(&req.name))
}

async fn generate_activity_handler(
    Json(input): Json<ActivityInput>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let s = logic::generate_activity(input)
        .map(|event| Ok::<_, Infallible>(event_to_sse(event)));
    Sse::new(s).keep_alive(KeepAlive::default())
}

fn event_to_sse(event: ActivityEvent) -> Event {
    let name = match &event {
        ActivityEvent::Started { .. } => "started",
        ActivityEvent::Progress { .. } => "progress",
        ActivityEvent::Finished => "finished",
        ActivityEvent::Error { .. } => "error",
    };
    let data = serde_json::to_string(&event).unwrap_or_default();
    Event::default().event(name).data(data)
}

pub fn router(dist_dir: PathBuf) -> Router {
    Router::new()
        .route("/api/greet", post(greet_handler))
        .route("/api/generate_activity", post(generate_activity_handler))
        .fallback_service(ServeDir::new(dist_dir))
}

pub async fn serve(addr: &str, dist_dir: PathBuf) {
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, router(dist_dir)).await.unwrap();
}
