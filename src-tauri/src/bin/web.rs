use std::path::PathBuf;

/// Standalone web server entry. Build with:
///   cargo build --bin kawai-web --features web
///   cargo run --bin kawai-web --features web
///
/// Serves the prebuilt frontend from ../dist plus the /api/* routes.
#[tokio::main]
async fn main() {
    kawai_lib::auth::load_dotenv();
    kawai_lib::logging::init();
    // Server-surface telemetry: without this the whole web process is dark —
    // no tracing subscriber (warn!/error! dropped), no Loki layer, no OTel
    // providers (failover/token counters land in the no-op meter → recap
    // bills zero), and record_generation no-ops on the uninitialized queue.
    kawai_telemetry::init();
    kawai_telemetry::set_app_version(env!("CARGO_PKG_VERSION").into());
    // dist/ is at the project root, one level above src-tauri/.
    let dist_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    if let Err(e) = kawai_lib::web::serve("0.0.0.0:3000", dist_dir).await {
        eprintln!("fatal: {e}");
        std::process::exit(1);
    }
}
