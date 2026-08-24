//! Tauri-side implementation of the `webread::WebViewFetch` engine: hidden
//! `WebviewWindow` + `eval` extractor, registered once in `lib.rs`
//! (webread builds). Lives outside `logic/` because it owns transport types;
//! `webread::scrape` stays pure and treats it as an injected trait object.
//!
//! Lifecycle: one throwaway hidden window per fetch, `readyState` polled to
//! `complete` plus a settle delay, extractor evaluated via
//! `eval_with_callback` (external pages have no Tauri IPC — the callback IS
//! the return channel), window closed on every exit path. `fetch_text` runs
//! the built-in readability extractor; `eval_page` runs caller-supplied
//! extractor JS (e.g. the Bing SERP harvester in `webread::scrape`). The whole
//! dance runs inside a spawned task holding the slot permit, so a
//! caller-side timeout drops the future without leaking the window: the task
//! still runs to its own deadline and tears itself down.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use webread::{ScrapeError, WebViewFetch};

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
        self.eval_page(url, EXTRACTOR)
    }

    fn eval_page(&self, url: &str, js: &str) -> BoxFuture<'static, Result<String, ScrapeError>> {
        let app = self.0.clone();
        let url = url.to_string();
        let js = js.to_string();
        Box::pin(async move {
            let permit = match tokio::time::timeout(SLOT_WAIT, SLOT.acquire()).await {
                Ok(Ok(p)) => p,
                _ => return Err(ScrapeError("webview engine busy".into())),
            };
            let (tx, rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let _permit = permit;
                let out = run(&app, &url, &js).await;
                let _ = tx.send(out);
            });
            rx.await
                .map_err(|_| ScrapeError("webview engine task died".into()))?
        })
    }
}

async fn run(app: &AppHandle, url: &str, js: &str) -> Result<String, ScrapeError> {
    let label = format!("kawai-scrape-{}", COUNTER.fetch_add(1, Ordering::Relaxed));
    let parsed = tauri::Url::parse(url).map_err(|e| ScrapeError(format!("bad url: {e}")))?;
    let app = app.clone();
    let label = label.clone();
    let build = tokio::task::spawn_blocking(move || {
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
            .visible(false)
            .on_navigation(|u| matches!(u.scheme(), "http" | "https"))
            .build()
    })
    .await
    .map_err(|e| ScrapeError(format!("window spawn: {e}")))?
    .map_err(|e| ScrapeError(format!("window build: {e}")))?;

    let out = extract(&build, js).await;
    let _ = build.close();
    out
}

async fn extract(w: &WebviewWindow, js: &str) -> Result<String, ScrapeError> {
    let started = Instant::now();
    // Polls that land during provisional navigation are dropped by WKWebView
    // WITHOUT the callback ever firing (channel closes) — treat every failed
    // or incomplete poll as retryable until the deadline, never a hard fail.
    loop {
        if started.elapsed() >= DEADLINE {
            return Err(ScrapeError("webview render timeout".into()));
        }
        match eval_string(w, "document.readyState").await {
            Ok(state) if state.contains("complete") => break,
            _ => tokio::time::sleep(Duration::from_millis(300)).await,
        }
    }
    tokio::time::sleep(SETTLE).await;
    eval_string(w, js).await
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
/// `{"t":title,"x":plain-text,"h":main-content html}` payload
/// `webread::scrape::split_payload` expects (`h` is rendered to markdown
/// Rust-side via html-to-markdown-rs; `x` is the fallback when conversion
/// yields too little). Steps:
///   1. Strip invisible/noise elements (script, style, noscript, template, svg, iframe, canvas)
///   2. Strip structural noise (landmark roles, site chrome, ad/comment/share/cookie containers)
///   3. Try to find the main content area (<article>, <main>, or high-text-density parent)
///   4. Fallback to full body if no main area detected
///   5. Within the main area: strip hidden nodes (attribute + computed style),
///      media, and form controls; absolutize anchor hrefs against the final
///      page URL (post-redirect, which Rust never sees)
///   6. Normalize whitespace and cap output sizes
const EXTRACTOR: &str = r#"(function(){try{var t=document.title||"";var noiseSel="script,style,noscript,template,svg,iframe,canvas,[role='navigation'],[role='banner'],[role='complementary'],nav,aside,body>header,body>footer,[class~='nav'],[class~='menu'],[class~='sidebar'],[class~='footer'],[class~='cookie'],[class~='consent'],[class~='banner'],[class~='ad'],[class~='ads'],[id~='ad'],[id~='ads'],[class*='advert'],[id*='advert'],[class*='adsense'],[class*='adunit'],[class~='share'],[class*='share-bar'],[class*='sharebuttons'],[class~='social'],[class*='related'],[class*='recommend'],[class*='comment'],[id='nav'],[id='menu'],[id='sidebar'],[id='footer'],[id='cookie'],[id='banner'],[id='comments']";var r=document.body||document.documentElement;if(r){var s=r.querySelectorAll(noiseSel);for(var i=0;i<s.length;i++){s[i].remove();}}var c=null;var cands=[document.querySelector('article'),document.querySelector('main'),document.querySelector('[role="main"]')];for(var j=0;j<cands.length;j++){if(cands[j]&&cands[j].innerText.length>200){c=cands[j];break;}}if(!c){var best=r;var bestScore=0;var all=r.querySelectorAll('*');for(var k=0;k<all.length;k++){var n=all[k];var txt=n.innerText||n.textContent||"";if(txt.length<50)continue;var words=txt.trim().split(/\s+/).length;var children=n.children.length||1;var score=words/Math.max(1,children);if(score>bestScore){bestScore=score;best=n;}}c=best;}try{var hideSel="[hidden],[aria-hidden='true'],[style*='display:none'],[style*='display: none'],[style*='visibility:hidden'],[style*='visibility: hidden'],img,picture,source,video,audio,button,select,input,textarea,label,optgroup,fieldset,datalist,output,progress,meter";var hs=c.querySelectorAll(hideSel);for(var m=0;m<hs.length;m++){hs[m].remove();}}catch(e2){}try{var deep=c.querySelectorAll('*');for(var q=0;q<deep.length&&q<4000;q++){var st=null;try{st=getComputedStyle(deep[q]);}catch(e3){}if(st&&(st.display==='none'||st.visibility==='hidden')){deep[q].remove();}}}catch(e4){}try{var as=c.querySelectorAll('a[href]');for(var p=0;p<as.length;p++){var href=as[p].getAttribute('href');if(href){try{as[p].setAttribute('href',new URL(href,location.href).href);}catch(e5){}}}}catch(e6){}var x=(c.innerText||c.textContent||"").replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();if(x.length>1500000){x=x.substring(0,1500000);}var h=c.innerHTML||"";if(h.length>2000000){h=h.substring(0,2000000);}return JSON.stringify({t:t,x:x,h:h});}catch(e){return JSON.stringify({t:"",x:"",e:String(e)});}})()"#;
