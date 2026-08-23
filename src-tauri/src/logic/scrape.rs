//! Web read tiering for the agent tier: one `web_read` tool backed by an
//! engine chain — on-device webview first (free, device-native TLS), then
//! the Cloudflare Browser Rendering `/markdown` quick action as the paid
//! fallback. Pure logic: the webview engine is injected at the transport
//! edge (`webview_engine.rs`, registered in `lib.rs`); `kawai-web` registers
//! nothing and degrades to Cloudflare-only. Tier-0 misses are decided by
//! challenge/emptiness detection, cloud spend is bounded by per-user +
//! global daily budgets, and a short-TTL LRU cache dedupes repeat reads.

use rig::tool::PortableTool;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

/// Content handed to the model is capped at the same budget as one
/// @-mentioned document (`KNOWLEDGE_PER_FILE_CAP` in `logic::office`).
pub const CONTENT_CAP_CHARS: usize = 12_000;

const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const CACHE_PER_USER: usize = 64;
const CACHE_VALUE_CAP_CHARS: usize = 200_000;
const WEBVIEW_TIMEOUT: Duration = Duration::from_secs(20);
const CF_TIMEOUT: Duration = Duration::from_secs(30);
const CF_PER_USER_DAILY_DEFAULT: u32 = 25;
const CF_GLOBAL_DAILY_DEFAULT: u32 = 300;
const MIN_USABLE_CHARS: usize = 500;

#[derive(Debug)]
pub struct ScrapeError(pub String);

impl std::fmt::Display for ScrapeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

// ── tier-0 engine injection ─────────────────────────────────────────────────

/// Transport-edge webview renderer. `fetch_text` returns the extractor
/// payload as JSON text: `{"t":<title>,"x":<body>}`.
pub trait WebViewFetch: Send + Sync {
    fn fetch_text(
        &self,
        url: &str,
    ) -> futures_util::future::BoxFuture<'static, Result<String, ScrapeError>>;
}

fn engine_cell() -> &'static OnceLock<Option<Arc<dyn WebViewFetch>>> {
    static CELL: OnceLock<Option<Arc<dyn WebViewFetch>>> = OnceLock::new();
    &CELL
}

/// Register the platform webview engine (Tauri shells only, at startup).
pub fn set_webview_engine(engine: Option<Arc<dyn WebViewFetch>>) {
    let _ = engine_cell().set(engine);
}

pub fn webview_engine() -> Option<Arc<dyn WebViewFetch>> {
    engine_cell().get().cloned().flatten()
}

/// Whether any Cloudflare vault pair is compiled in (empty = not configured).
pub fn cf_configured() -> bool {
    let (account, token) = kawai_constants::cloudflare::get_cf_account_id_and_token();
    !account.is_empty() && !token.is_empty()
}

/// Whether `web_read` has any engine at all; gates tool registration.
pub fn any_engine() -> bool {
    webview_engine().is_some() || cf_configured()
}

// ── detection ───────────────────────────────────────────────────────────────

const CHALLENGE_MARKERS: &[&str] = &[
    "just a moment",
    "checking your browser",
    "cf-chl",
    "challenge-platform",
    "attention required",
    "verify you are human",
    "enable javascript and cookies",
    "request you followed has expired",
    "ddos protection by",
    "unusual traffic",
];

/// Anti-bot interstitial detector (Cloudflare / Akamai / DataDome families).
/// A false positive costs one Cloudflare call; a false negative hands the
/// model a challenge page as content — biased toward over-matching.
pub fn looks_like_challenge(title: &str, body: &str) -> bool {
    let window: String = body.chars().take(4000).collect();
    let hay = format!("{} {}", title, window).to_lowercase();
    CHALLENGE_MARKERS.iter().any(|m| hay.contains(m))
}

fn usable_text(body: &str) -> bool {
    body.chars().count() >= MIN_USABLE_CHARS
}

/// Split the engine payload into (title, body). Non-JSON payloads are
/// treated as body-only so a partial extractor result still reaches the
/// detector.
fn split_payload(raw: &str) -> (String, String) {
    #[derive(Deserialize, Default)]
    struct Payload {
        #[serde(default)]
        t: String,
        #[serde(default)]
        x: String,
    }
    match serde_json::from_str::<Payload>(raw) {
        Ok(p) => (p.t, p.x),
        Err(_) => (String::new(), raw.to_string()),
    }
}

// ── url normalization (cache key) ───────────────────────────────────────────

/// Canonical http(s) cache key: lowercase host (+port), sorted query,
/// fragment dropped. `None` for non-http(s) or hostless URLs.
pub fn normalize_url(raw: &str) -> Option<String> {
    let u = Url::parse(raw.trim()).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let host = u.host_str()?.to_lowercase();
    let host = match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    };
    let mut pairs: Vec<(String, String)> = u
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    pairs.sort();
    let mut q = String::new();
    for (k, v) in &pairs {
        if !q.is_empty() {
            q.push('&');
        }
        q.push_str(k);
        q.push('=');
        q.push_str(v);
    }
    Some(format!(
        "{}://{}{}{}",
        u.scheme(),
        host,
        u.path(),
        if q.is_empty() { String::new() } else { format!("?{q}") }
    ))
}

// ── cache + budgets ─────────────────────────────────────────────────────────

struct CacheEntry {
    stored_at: Instant,
    engine: String,
    content: String,
}

struct UserState {
    order: Vec<String>,
    cache: HashMap<String, CacheEntry>,
    day: u64,
    cf_used: u32,
}

impl UserState {
    fn fresh() -> Self {
        Self {
            order: Vec::new(),
            cache: HashMap::new(),
            day: 0,
            cf_used: 0,
        }
    }
}

struct GlobalState {
    day: u64,
    cf_used: u32,
}

struct ScrapeState {
    users: HashMap<String, UserState>,
    global: GlobalState,
}

impl ScrapeState {
    fn fresh() -> Self {
        Self {
            users: HashMap::new(),
            global: GlobalState { day: 0, cf_used: 0 },
        }
    }
}

fn state() -> &'static Mutex<ScrapeState> {
    static STATE: OnceLock<Mutex<ScrapeState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ScrapeState::fresh()))
}

fn entry_fresh(stored_at: Instant, ttl: Duration) -> bool {
    stored_at.elapsed() < ttl
}

fn cache_get(user: &str, key: &str) -> Option<(String, String)> {
    let mut st = state().lock().unwrap();
    let u = st.users.get_mut(user)?;
    let e = u.cache.get(key)?;
    if !entry_fresh(e.stored_at, CACHE_TTL) {
        return None;
    }
    u.order.retain(|k| k != key);
    u.order.push(key.to_string());
    Some((e.engine.clone(), e.content.clone()))
}

fn cache_put(user: &str, key: &str, engine: &str, content: &str) {
    let capped: String = content.chars().take(CACHE_VALUE_CAP_CHARS).collect();
    let mut st = state().lock().unwrap();
    let u = st
        .users
        .entry(user.to_string())
        .or_insert_with(UserState::fresh);
    u.cache.insert(
        key.to_string(),
        CacheEntry {
            stored_at: Instant::now(),
            engine: engine.to_string(),
            content: capped,
        },
    );
    u.order.retain(|k| k != key);
    u.order.push(key.to_string());
    while u.order.len() > CACHE_PER_USER {
        let evict = u.order.remove(0);
        u.cache.remove(&evict);
    }
}

fn utc_day() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

fn cf_caps() -> (u32, u32) {
    let per_user = std::env::var("KAWAI_CF_PER_USER_DAILY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(CF_PER_USER_DAILY_DEFAULT);
    let global = std::env::var("KAWAI_CF_GLOBAL_DAILY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(CF_GLOBAL_DAILY_DEFAULT);
    (per_user, global)
}

fn try_reserve(
    st: &mut ScrapeState,
    user: &str,
    day: u64,
    per_user_cap: u32,
    global_cap: u32,
) -> bool {
    if st.global.day != day {
        st.global = GlobalState { day, cf_used: 0 };
    }
    let u = st
        .users
        .entry(user.to_string())
        .or_insert_with(UserState::fresh);
    if u.day != day {
        u.day = day;
        u.cf_used = 0;
    }
    if u.cf_used >= per_user_cap || st.global.cf_used >= global_cap {
        return false;
    }
    u.cf_used += 1;
    st.global.cf_used += 1;
    true
}

fn reserve_cf(user_id: &str) -> bool {
    let (per_user, global) = cf_caps();
    try_reserve(
        &mut state().lock().unwrap(),
        user_id,
        utc_day(),
        per_user,
        global,
    )
}

// ── outcomes ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOutcome {
    pub url: String,
    pub engine: String,
    pub chars: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl ReadOutcome {
    fn success(url: &str, engine: &str, text: &str) -> Self {
        let total = text.chars().count();
        let (content, truncated) = if total > CONTENT_CAP_CHARS {
            (
                text.chars().take(CONTENT_CAP_CHARS).collect::<String>(),
                true,
            )
        } else {
            (text.to_string(), false)
        };
        Self {
            url: url.to_string(),
            engine: engine.to_string(),
            chars: total,
            truncated,
            content: Some(content),
            error: None,
            hint: None,
        }
    }

    fn failed(url: &str, error: &str, hint: &str) -> Self {
        Self {
            url: url.to_string(),
            engine: "none".to_string(),
            chars: 0,
            truncated: false,
            content: None,
            error: Some(error.to_string()),
            hint: Some(hint.to_string()),
        }
    }
}

// ── the read chain ──────────────────────────────────────────────────────────

pub async fn read_markdown(user_id: &str, raw_url: &str) -> ReadOutcome {
    let Some(url) = normalize_url(raw_url) else {
        return ReadOutcome::failed(
            raw_url,
            "invalid url",
            "Tell the user only absolute http(s) URLs can be read.",
        );
    };

    if let Some((_engine, content)) = cache_get(user_id, &url) {
        return ReadOutcome::success(&url, "cache", &content);
    }

    if let Some(engine) = webview_engine() {
        let fetched = tokio::time::timeout(WEBVIEW_TIMEOUT, engine.fetch_text(&url)).await;
        if let Ok(Ok(payload)) = fetched {
            let (title, body) = split_payload(&payload);
            if !looks_like_challenge(&title, &body) && usable_text(&body) {
                cache_put(user_id, &url, "webview", &body);
                return ReadOutcome::success(&url, "webview", &body);
            }
        }
    }

    if !cf_configured() {
        return ReadOutcome::failed(
            &url,
            "page could not be read on-device",
            "Tell the user the page could not be read (blocked or unreachable).",
        );
    }
    if !reserve_cf(user_id) {
        return ReadOutcome::failed(
            &url,
            "web fetch budget exhausted for today",
            "Tell the user the daily cloud web-fetch limit is reached; try again tomorrow.",
        );
    }

    let client = reqwest::Client::builder()
        .timeout(CF_TIMEOUT)
        .build()
        .unwrap_or_default();
    let tool = browser::generated::BrowserMarkdownExtractTool::new(
        browser::httpclient::ToolOptions::new().with_client(client),
    );
    let args = browser::generated::BrowserMarkdownExtractArgs {
        url: Some(url.clone()),
        html: None,
        rejectRequestPattern: None,
        gotoOptions: None,
        userAgent: None,
    };
    match tool.call(args).await {
        Ok(out) if !out.starts_with("API error") => {
            let body = out.trim().to_string();
            if looks_like_challenge("", &body) {
                return ReadOutcome::failed(
                    &url,
                    "page is bot-protected and could not be read",
                    "Tell the user the page blocks automated access.",
                );
            }
            cache_put(user_id, &url, "cloudflare", &body);
            ReadOutcome::success(&url, "cloudflare", &body)
        }
        Ok(err) => ReadOutcome::failed(
            &url,
            &format!("cloudflare fetch failed: {}", err.chars().take(200).collect::<String>()),
            "Tell the user the page could not be read.",
        ),
        Err(e) => ReadOutcome::failed(
            &url,
            &format!("cloudflare fetch failed: {e}"),
            "Tell the user the page could not be read.",
        ),
    }
}

// ── agent tool ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebReadArgs {
    pub url: String,
}

pub struct WebReadTool(pub String);

impl PortableTool for WebReadTool {
    const NAME: &'static str = "web_read";
    type Args = WebReadArgs;
    type Output = String;
    type Error = crate::logic::office::OfficeToolError;

    fn description(&self) -> String {
        "Read a public web page and return its text content. Use when the user shares a specific URL, or asks to fetch / look up / summarize / quote a particular web page. You must already have the exact URL — this is NOT a search engine.".into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "Absolute http(s) URL of the page to read." }
            },
            "required": ["url"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let out = read_markdown(&self.0, &args.url).await;
        serde_json::to_string(&out)
            .map_err(|e| crate::logic::office::OfficeToolError(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset() {
        *state().lock().unwrap() = ScrapeState::fresh();
    }

    #[test]
    fn detects_known_challenge_pages() {
        assert!(looks_like_challenge(
            "Just a moment...",
            "Checking your browser before accessing example.com."
        ));
        assert!(looks_like_challenge("", "Enable JavaScript and cookies to continue"));
        assert!(looks_like_challenge("Attention Required! | Cloudflare", "ray id 8f2a"));
        assert!(!looks_like_challenge(
            "Rust Programming Language",
            "A language empowering everyone to build reliable and efficient software. This is a long enough body of regular page text that would never match any challenge marker in the list."
        ));
    }

    #[test]
    fn normalizes_urls_for_cache_keys() {
        assert_eq!(
            normalize_url("HTTPS://Example.COM/a?b=2&a=1#frag"),
            Some("https://example.com/a?a=1&b=2".to_string())
        );
        assert_eq!(
            normalize_url("https://example.com:8443/x"),
            Some("https://example.com:8443/x".to_string())
        );
        assert_eq!(normalize_url("javascript:alert(1)"), None);
        assert_eq!(normalize_url("ftp://example.com/f"), None);
        assert_eq!(normalize_url("not a url"), None);
    }

    #[test]
    fn cache_lru_evicts_oldest() {
        reset();
        for i in 0..=CACHE_PER_USER {
            cache_put("u", &format!("https://x/{i}"), "webview", "body");
        }
        assert!(cache_get("u", "https://x/0").is_none());
        assert!(cache_get("u", &format!("https://x/{}", CACHE_PER_USER)).is_some());
    }

    #[test]
    fn expired_entries_are_not_served() {
        assert!(!entry_fresh(Instant::now(), Duration::ZERO));
        assert!(entry_fresh(Instant::now(), CACHE_TTL));
    }

    #[test]
    fn budget_caps_and_day_rollover() {
        let mut st = ScrapeState::fresh();
        for _ in 0..3 {
            assert!(try_reserve(&mut st, "u", 7, 3, 100));
        }
        assert!(!try_reserve(&mut st, "u", 7, 3, 100));
        assert!(try_reserve(&mut st, "u", 8, 3, 100), "day rollover resets");

        let mut st2 = ScrapeState::fresh();
        for _ in 0..2 {
            assert!(try_reserve(&mut st2, "a", 7, 25, 2));
        }
        assert!(!try_reserve(&mut st2, "b", 7, 25, 2), "global cap binds");
    }

    #[test]
    fn outcome_truncation_flags_content() {
        let long = "x".repeat(CONTENT_CAP_CHARS + 500);
        let o = ReadOutcome::success("https://e", "webview", &long);
        assert!(o.truncated);
        assert_eq!(o.chars, CONTENT_CAP_CHARS + 500);
        assert_eq!(o.content.unwrap().chars().count(), CONTENT_CAP_CHARS);

        let short = ReadOutcome::success("https://e", "cache", "hi");
        assert!(!short.truncated);
    }

    #[test]
    fn failure_outcome_shape() {
        let o = ReadOutcome::failed("https://e", "boom", "say sorry");
        assert_eq!(o.engine, "none");
        assert!(o.content.is_none());
        let v = serde_json::to_value(&o).unwrap();
        assert!(v.get("content").is_none());
        assert_eq!(v["error"], "boom");
    }
}
