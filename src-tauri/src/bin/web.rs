use std::path::PathBuf;

/// Standalone web server entry. Build with:
///   cargo build --bin kawai-web --features web
///   cargo run --bin kawai-web --features web
///
/// Serves the prebuilt frontend from ../dist plus the /api/* routes.
#[tokio::main]
async fn main() {
    // dist/ is at the project root, one level above src-tauri/.
    let dist_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    kawai_lib::web::serve("0.0.0.0:3000", dist_dir).await;
}
