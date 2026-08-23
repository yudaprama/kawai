//! Tauri-side `WebViewFetch` engine: hidden `WebviewWindow` + `eval`
//! extractor, registered once in `lib.rs` (office builds). Lives outside
//! `logic/` because it owns transport types; `logic::scrape` stays pure and
//! treats it as an injected trait object.
//!
//! Lifecycle: one throwaway hidden window per fetch, `readyState` polled to
//! `complete` plus a settle delay, extractor evaluated via
//! `eval_with_callback` (external pages have no Tauri IPC — the callback IS
//! the return channel), window closed on every exit path. The whole dance
//! runs inside a spawned task holding the slot permit, so a caller-side
//! timeout drops the future without leaking the window: the task still runs
//! to its own deadline and tears itself down.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::logic::scrape::{ScrapeError, WebViewFetch};

static COUNTER: AtomicU64 = AtomicU64::new(0);
/// One hidden window at a time app-wide; waiters fall through to Cloudflare.
static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

const SLOT_WAIT: Duration = Duration::from_secs(4);
const DEADLINE: Duration = Duration::from_secs(18);
const SETTLE: Duration = Duration::from_secs(1);
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);

pub struct TauriWebViewFetch(AppHandle);

impl TauriWebViewFetch {
    pub fn new(app: AppHandle) -> Self {
        Self(app)
    }
}

impl WebViewFetch for TauriWebViewFetch {
    fn fetch_text(&self, url: &str) -> BoxFuture<'static, Result<String, ScrapeError>> {
        let app = self.0.clone();
        let url = url.to_string();
        Box::pin(async move {
            let permit = match tokio::time::timeout(SLOT_WAIT, SLOT.acquire()).await {
                Ok(Ok(p)) => p,
                _ => return Err(ScrapeError("webview engine busy".into())),
            };
            let (tx, rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let _permit = permit;
                let out = run(&app, &url).await;
                let _ = tx.send(out);
            });
            rx.await
                .map_err(|_| ScrapeError("webview engine task died".into()))?
        })
    }
}

async fn run(app: &AppHandle, url: &str) -> Result<String, ScrapeError> {
    let label = format!("kawai-scrape-{}", COUNTER.fetch_add(1, Ordering::Relaxed));
    let parsed =
        tauri::Url::parse(url).map_err(|e| ScrapeError(format!("bad url: {e}")))?;
    let app = app.clone();
    let label = label.clone();
    let build = tokio::task::spawn_blocking(move || {
        WebviewWindowBuilder::new(
            &app,
            &label,
            WebviewUrl::External(parsed),
        )
        .visible(false)
        .on_navigation(|u| matches!(u.scheme(), "http" | "https"))
        .build()
    })
    .await
    .map_err(|e| ScrapeError(format!("window spawn: {e}")))?
    .map_err(|e| ScrapeError(format!("window build: {e}")))?;

    let out = extract(&build).await;
    let _ = build.close();
    out
}

async fn extract(w: &WebviewWindow) -> Result<String, ScrapeError> {
    let started = Instant::now();
    loop {
        if started.elapsed() >= DEADLINE {
            return Err(ScrapeError("webview render timeout".into()));
        }
        let state = eval_string(w, "document.readyState").await?;
        if state.contains("complete") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    tokio::time::sleep(SETTLE).await;
    eval_string(w, EXTRACTOR).await
}

/// Evaluate `js` and return its JSON-decoded string result (the callback
/// receives the serialized completion value; both call sites return strings).
async fn eval_string(w: &WebviewWindow, js: &str) -> Result<String, ScrapeError> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    w.eval_with_callback(js, move |s| {
        let _ = tx.send(s);
    })
    .map_err(|e| ScrapeError(format!("eval: {e}")))?;
    match tokio::time::timeout(EVAL_TIMEOUT, rx.recv()).await {
        Ok(Some(raw)) => serde_json::from_str::<String>(&raw)
            .map_err(|_| ScrapeError("eval result decode failed".into())),
        Ok(None) => Err(ScrapeError("eval channel closed".into())),
        Err(_) => Err(ScrapeError("eval timeout".into())),
    }
}

/// Readability-style harvest executed in the page context. The window is
/// throwaway, so stripping nodes in place is safe. Returns the
/// `{"t":title,"x":body}` payload `logic::scrape::split_payload` expects.
const EXTRACTOR: &str = r#"(function(){try{var t=document.title||"";var r=document.body||document.documentElement;if(r){r.querySelectorAll("script,style,noscript,template,svg,iframe").forEach(function(n){n.remove()});}var x=(r&&(r.innerText||r.textContent)||"").replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();if(x.length>1500000){x=x.substring(0,1500000);}return JSON.stringify({t:t,x:x});}catch(e){return JSON.stringify({t:"",x:"",e:String(e)});}})()"#;
