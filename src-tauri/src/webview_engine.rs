//! Web read engine: the platform's own browser, driven from Rust, registered
//! once in `lib.rs` (office builds). Lives outside `logic/` because it owns
//! transport types; `logic::scrape` stays pure and treats it as an injected
//! trait object.
//!
//! Desktop (macOS/Linux/Windows): one throwaway hidden `WebviewWindow` per
//! fetch, `readyState` polled to `complete` plus a settle delay, extractor
//! evaluated via `eval_with_callback` (external pages have no Tauri IPC — the
//! callback IS the return channel), window closed on every exit path. The
//! dance runs inside a spawned task holding the slot permit, so a
//! caller-side timeout drops the future without leaking the window: the task
//! still runs to its own deadline and tears itself down.
//!
//! Android: wry has no detached webview — every webview it creates calls
//! `activity.setContentView` and takes over the app UI, and `visible(false)`
//! is ignored (`wry/src/android/main_pipe.rs`). The Android engine therefore
//! drives a detached WebView owned by `KawaiHeadless.kt` over JNI: same page,
//! same extractor JS, no window and nothing to leak. The Kotlin side hands
//! back the JSON-encoded completion value, which is exactly what desktop's
//! `eval_with_callback` produces, so `fetch_text`/`eval_page` callers see one
//! behavior on every platform.

use std::time::Duration;

use futures_util::future::BoxFuture;

#[cfg(not(target_os = "android"))]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(not(target_os = "android"))]
use std::time::Instant;
use tauri::AppHandle;
#[cfg(not(target_os = "android"))]
use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::logic::scrape::{ScrapeError, WebViewFetch};

/// One fetch at a time app-wide; waiters fall through to Cloudflare.
static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

const SLOT_WAIT: Duration = Duration::from_secs(4);

#[cfg(not(target_os = "android"))]
const DEADLINE: Duration = Duration::from_secs(18);
#[cfg(not(target_os = "android"))]
const SETTLE: Duration = Duration::from_secs(1);
#[cfg(not(target_os = "android"))]
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(not(target_os = "android"))]
pub struct TauriWebViewFetch {
    app: AppHandle,
}

#[cfg(target_os = "android")]
pub struct TauriWebViewFetch;

impl TauriWebViewFetch {
    #[cfg(not(target_os = "android"))]
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    #[cfg(target_os = "android")]
    pub fn new(_app: AppHandle) -> Self {
        Self
    }
}

#[cfg(target_os = "android")]
impl WebViewFetch for TauriWebViewFetch {
    fn fetch_text(&self, url: &str) -> BoxFuture<'static, Result<String, ScrapeError>> {
        self.eval_page(url, EXTRACTOR)
    }

    fn eval_page(&self, url: &str, js: &str) -> BoxFuture<'static, Result<String, ScrapeError>> {
        let url = url.to_string();
        let js = js.to_string();
        Box::pin(async move {
            let permit = match tokio::time::timeout(SLOT_WAIT, SLOT.acquire()).await {
                Ok(Ok(p)) => p,
                _ => return Err(ScrapeError("webview engine busy".into())),
            };
            // JNI + poll loop is blocking work — keep it off the async workers.
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                android::scrape(&url, &js)
            })
            .await
            .map_err(|e| ScrapeError(format!("webview task: {e}")))?
        })
    }
}

#[cfg(not(target_os = "android"))]
impl WebViewFetch for TauriWebViewFetch {
    fn fetch_text(&self, url: &str) -> BoxFuture<'static, Result<String, ScrapeError>> {
        self.eval_page(url, EXTRACTOR)
    }

    fn eval_page(&self, url: &str, js: &str) -> BoxFuture<'static, Result<String, ScrapeError>> {
        let app = self.app.clone();
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

#[cfg(not(target_os = "android"))]
static COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(not(target_os = "android"))]
async fn run(app: &AppHandle, url: &str, js: &str) -> Result<String, ScrapeError> {
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

    let out = extract(&build, js).await;
    let _ = build.close();
    out
}

#[cfg(not(target_os = "android"))]
async fn extract(w: &WebviewWindow, js: &str) -> Result<String, ScrapeError> {
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
    eval_string(w, js).await
}

/// Evaluate `js` and return its JSON-decoded string result (the callback
/// receives the serialized completion value; both call sites return strings).
#[cfg(not(target_os = "android"))]
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

/// Android bridge to `pro.kawai.app.KawaiHeadless` (detached WebView). One
/// blocking call = one render: attach the (tokio blocking) thread to the JVM,
/// `start`, poll every 120 ms until Kotlin hands back a `"V"+result` /
/// `"E"+message` envelope or the deadline passes.
#[cfg(target_os = "android")]
mod android {
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    use jni::objects::{Global, JClassLoader, JClass, JObject, JString, JValue};
    use jni::vm::JavaVM;
    use jni::{jni_sig, jni_str, Env};

    use crate::logic::scrape::ScrapeError;

    /// Kotlin's own budget is 25 s; give it room to deliver its timeout
    /// message instead of racing it with a generic one.
    const DEADLINE: Duration = Duration::from_secs(28);
    const POLL: Duration = Duration::from_millis(120);

    /// Render ids handed to Kotlin; never reused within a process.
    static NEXT_ID: AtomicI64 = AtomicI64::new(1);

    /// `KawaiHeadless` as a global class ref. `Env::find_class` is NOT usable
    /// here: this code runs on a native thread attached outside any Java
    /// frame, so `FindClass` searches the SYSTEM class loader, which cannot
    /// see APK classes (`NoClassDefFoundError`). The app class loader —
    /// reachable from the `Context` that `ndk-context` carries — must do the
    /// lookup (same pattern `rustls-platform-verifier` uses for its verifier
    /// class). Cached once: the ref is valid on every attached thread.
    static CLASS: OnceLock<Global<JClass<'static>>> = OnceLock::new();

    pub fn scrape(url: &str, js: &str) -> Result<String, ScrapeError> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let outcome = vm
            .attach_current_thread(|env| run(env, id, url, js))
            .map_err(|e| ScrapeError(format!("headless webview: {e}")))?;
        match outcome {
            Some(raw) => decode(&raw),
            None => Err(ScrapeError("webview render timeout".into())),
        }
    }

    fn run(
        env: &mut Env<'_>,
        id: i64,
        url: &str,
        js: &str,
    ) -> jni::errors::Result<Option<String>> {
        let class = headless_class(env)?;
        start(env, class, id, url, js)?;
        let deadline = Instant::now() + DEADLINE;
        loop {
            if let Some(raw) = poll(env, class, id)? {
                return Ok(Some(raw));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(POLL);
        }
    }

    fn headless_class(
        env: &mut Env<'_>,
    ) -> jni::errors::Result<&'static Global<JClass<'static>>> {
        if let Some(class) = CLASS.get() {
            return Ok(class);
        }
        let ctx = ndk_context::android_context();
        let context = unsafe { JObject::from_raw(env, ctx.context().cast()) };
        let loader = env
            .call_method(
                &context,
                jni_str!("getClassLoader"),
                jni_sig!(() -> JClassLoader),
                &[],
            )?
            .l()?;
        let loader: JClassLoader = env.cast_local::<JClassLoader>(loader)?;
        let name = env.new_string("pro.kawai.app.KawaiHeadless")?;
        let class: JClass = loader.load_class(env, name)?;
        let global = env.new_global_ref(class)?;
        Ok(CLASS.get_or_init(|| global))
    }

    fn start(
        env: &mut Env<'_>,
        class: &'static Global<JClass<'static>>,
        id: i64,
        url: &str,
        js: &str,
    ) -> jni::errors::Result<()> {
        env.with_local_frame(8, |env| {
            let url = env.new_string(url)?;
            let js = env.new_string(js)?;
            env.call_static_method(
                class,
                jni_str!("start"),
                jni_sig!("(JLjava/lang/String;Ljava/lang/String;)V"),
                &[JValue::Long(id), JValue::from(&url), JValue::from(&js)],
            )?;
            Ok(())
        })
    }

    fn poll(
        env: &mut Env<'_>,
        class: &'static Global<JClass<'static>>,
        id: i64,
    ) -> jni::errors::Result<Option<String>> {
        env.with_local_frame(8, |env| {
            let value = env.call_static_method(
                class,
                jni_str!("poll"),
                jni_sig!("(J)Ljava/lang/String;"),
                &[JValue::Long(id)],
            )?;
            if value.is_null() {
                return Ok(None);
            }
            let object: JObject = value.l()?;
            let string = unsafe { JString::from_raw(env, object.as_raw()) };
            let text: String = string.mutf8_chars(env)?.into();
            Ok(Some(text))
        })
    }

    /// Kotlin envelopes every answer: `"V"` + JSON-encoded result, `"E"` +
    /// plain-text failure. The JSON decoding mirrors desktop's `eval_string`.
    fn decode(raw: &str) -> Result<String, ScrapeError> {
        match raw.chars().next() {
            Some('V') => serde_json::from_str::<String>(&raw[1..])
                .map_err(|_| ScrapeError("eval result decode failed".into())),
            Some('E') => Err(ScrapeError(format!("headless webview: {}", &raw[1..]))),
            _ => Err(ScrapeError("headless webview: malformed result".into())),
        }
    }
}

/// Readability-style harvest executed in the page context. The window is
/// throwaway, so stripping nodes in place is safe. Returns the
/// `{"t":title,"x":body}` payload `logic::scrape::split_payload` expects.
const EXTRACTOR: &str = r#"(function(){try{var t=document.title||"";var r=document.body||document.documentElement;if(r){r.querySelectorAll("script,style,noscript,template,svg,iframe").forEach(function(n){n.remove()});}var x=(r&&(r.innerText||r.textContent)||"").replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();if(x.length>1500000){x=x.substring(0,1500000);}return JSON.stringify({t:t,x:x});}catch(e){return JSON.stringify({t:"",x:"",e:String(e)});}})()"#;
