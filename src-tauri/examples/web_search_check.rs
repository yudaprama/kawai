//! Headless check for the `web_search` agent tool chain: cache key → Bing
//! SERP URL → engine tier (none headless — no webview) → Cloudflare
//! `/markdown` fallback → markdown-link parsing. Exercises everything except
//! tier 0, which needs a running Tauri shell (`bun tauri dev`).
//!
//! Usage: cargo run --example web_search_check --features office
//!        cargo run --example web_search_check --features office -- <query> [maxResults]

use webread::search_web;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let query = args
        .first()
        .cloned()
        .unwrap_or_else(|| "rust programming language".to_string());
    let max: usize = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(5);

    println!("[web_search_check] query={query:?} maxResults={max}");
    if std::env::var("KAWAI_SEARCH_DEBUG").is_ok() {
        return debug_dump_serp(&query).await;
    }
    let out = search_web("demo", &query, max).await;
    println!(
        "[web_search_check] engine={} count={} error={:?}",
        out.engine, out.count, out.error
    );
    for h in &out.hits {
        println!("  - {} | {}\n    {}", h.title, h.url, h.snippet);
    }
    if out.hits.is_empty() {
        eprintln!(
            "[web_search_check] FAIL: no hits (error={:?} hint={:?})",
            out.error, out.hint
        );
        std::process::exit(1);
    }
    println!("[web_search_check] OK");
}

/// Dump the raw Cloudflare `/markdown` rendering of the Bing SERP.
async fn debug_dump_serp(query: &str) {
    use browser::generated::BrowserMarkdownExtractArgs;
    use browser::generated::BrowserMarkdownExtractTool;
    use browser::httpclient::ToolOptions;
    use rig::tool::PortableTool;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();
    let tool = BrowserMarkdownExtractTool::new(ToolOptions::new().with_client(client));
    let mut u = url::Url::parse("https://www.bing.com/search").unwrap();
    u.query_pairs_mut().append_pair("q", query).append_pair("count", "20");
    let args = BrowserMarkdownExtractArgs {
        url: Some(u.into()),
        html: None,
        rejectRequestPattern: None,
        gotoOptions: None,
        userAgent: None,
    };
    match tool.call(args).await {
        Ok(out) => {
            println!("=== RAW ({}) ===\n{}", out.len(), &out[..out.len().min(4000)]);
        }
        Err(e) => eprintln!("cloudflare error: {e}"),
    }
}
