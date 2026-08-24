use std::path::PathBuf;

/// Standalone web server entry. Build with:
///   cargo build --bin kawai-web --features web
///   cargo run --bin kawai-web --features web
///
/// Serves the prebuilt frontend from ../dist plus the /api/* routes.
#[tokio::main]
async fn main() {
    kawai_lib::auth::load_dotenv();
    // dist/ is at the project root, one level above src-tauri/.
    let dist_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    let verifier = kawai_lib::auth::Verifier::from_env();
    if verifier.has_dev_bypass() {
        eprintln!(
            "⚠️  KAWAI_AUTH_DEV_USER_ID set — auth bypassed (dev only, DO NOT use in production)"
        );
    }
    if let Err(e) = kawai_lib::web::serve("0.0.0.0:3000", dist_dir, verifier).await {
        eprintln!("fatal: {e}");
        std::process::exit(1);
    }
}
