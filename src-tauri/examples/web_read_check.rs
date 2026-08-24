//! Desktop smoke for the `web_read` tier-0 chain: registers the REAL hidden
//! webview engine exactly like the app shell (`webview_engine.rs` via
//! `TauriWebViewFetch`), reads one URL, prints the `ReadOutcome` JSON.
//!
//! This exercises the layers nothing else can reach headlessly: the
//! readability extractor running inside a real WKWebView/WebKit window
//! (hidden-node strip, media/form strip, href absolutization, `{t,x,h}`
//! payload) plus the Rust-side htmd markdown render and plain-text fallback.
//! Unit tests cover the converter against fixtures; this covers live DOM.
//!
//! Note: the app's configured main window flashes briefly (config windows
//! are created before we exit) — harmless.
//!
//! Usage:
//!   cargo run --example web_read_check --features office
//!   cargo run --example web_read_check --features office -- <url>
//!
//! Exit 0 when usable content came back, 1 otherwise. Tier 0 needs a GUI
//! session (macOS desktop); headless Linux hosts fall through to Cloudflare
//! and still validate the chain below tier 0.

use std::sync::Arc;

use kawai_lib::webview_engine::TauriWebViewFetch;
use webread::{set_webview_engine, ReadOutcome, WebViewFetch};

fn main() {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "https://www.rust-lang.org/".to_string());

    tauri::Builder::default()
        .setup(move |app| {
            let engine = Arc::new(TauriWebViewFetch::new(app.handle().clone()));
            set_webview_engine(Some(engine.clone()));
            let url = url.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("tokio runtime");
                // Probe the raw extractor payload first — read_markdown
                // swallows tier-0 failures silently, this shows WHY.
                match rt.block_on(engine.fetch_text(&url)) {
                    Ok(p) => {
                        let head: String = p.chars().take(200).collect();
                        println!("[probe] payload len={} head:\n{head}", p.chars().count());
                    }
                    Err(e) => println!("[probe] ERROR: {}", e.0),
                }
                let out = rt.block_on(read(&url));
                println!(
                    "[web_read_check] engine={} chars={} truncated={}",
                    out.engine, out.chars, out.truncated
                );
                // CI gate mode: content alone isn't enough — a silent tier-0
                // miss still succeeds via Cloudflare. Require the webview
                // (or cache seeded by one) when the flag is set.
                let require_tier0 = std::env::var("KAWAI_WEB_READ_REQUIRE_TIER0").is_ok();
                let tiered = out.engine == "webview" || out.engine == "cache";
                if require_tier0 && !tiered {
                    eprintln!(
                        "[web_read_check] FAIL: KAWAI_WEB_READ_REQUIRE_TIER0 set but engine={} \
                         — tier 0 did not serve",
                        out.engine
                    );
                }
                if let Some(content) = &out.content {
                    let head: String = content.chars().take(300).collect();
                    println!("[web_read_check] content head:\n{head}");
                }
                if let (Some(err), Some(hint)) = (&out.error, &out.hint) {
                    eprintln!("[web_read_check] FAIL: {err} — {hint}");
                }
                let ok =
                    out.content.is_some() && (!require_tier0 || tiered);
                std::process::exit(i32::from(!ok));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri event loop");
}

async fn read(url: &str) -> ReadOutcome {
    match tokio::time::timeout(
        std::time::Duration::from_secs(90),
        webread::read_markdown("web-read-check", url),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => ReadOutcome {
            url: url.to_string(),
            engine: "none".to_string(),
            chars: 0,
            truncated: false,
            content: None,
            error: Some("smoke timeout (90s)".to_string()),
            hint: Some("engine chain did not settle in time".to_string()),
        },
    }
}
