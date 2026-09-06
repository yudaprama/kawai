use std::path::PathBuf;

/// Standalone web server entry for independent deployment.
/// Build with:
///   cargo build -p kawai-web --release
///   cargo run -p kawai-web
///
/// Serves the prebuilt frontend from ../dist plus the /api/* routes.
/// No Tauri/WebView linked — Cloudflare tier only for `web_read`.
#[tokio::main]
async fn main() {
    kawai_lib::auth::load_dotenv();
    kawai_lib::logging::init();

    // dist/ is at the project root. When running via `cargo run -p kawai-web`
    // the manifest dir is kawai-web/, so we go one level up.
    // In Docker, dist is copied to /app/dist and WORKDIR is /app.
    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"),
        PathBuf::from("dist"),
        PathBuf::from("/app/dist"),
    ];
    let dist_dir = candidates
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"));

    let addr = std::env::var("KAWAI_WEB_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_string());
    eprintln!("[kawai-web] serving {} with dist {}", addr, dist_dir.display());
    if let Err(e) = kawai_lib::web::serve(&addr, dist_dir).await {
        eprintln!("fatal: {e}");
        std::process::exit(1);
    }
}
