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

/// Transport-edge webview renderer. `fetch_text` returns the readability
/// extractor payload as JSON text: `{"t":<title>,"x":<body>}`. `eval_page`
/// renders a URL and evaluates caller-supplied extractor JS, returning the
/// JSON-decoded completion value (extractors return `JSON.stringify(...)`).
pub trait WebViewFetch: Send + Sync {
    fn fetch_text(
        &self,
        url: &str,
    ) -> futures_util::future::BoxFuture<'static, Result<String, ScrapeError>>;

    fn eval_page(
        &self,
        url: &str,
        js: &str,
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

// ── web search (Bing SERP over the same engine chain) ──────────────────────

const SEARCH_HITS_CAP: usize = 10;
const SEARCH_DEFAULT_HITS: usize = 5;
const SEARCH_SNIPPET_CAP_CHARS: usize = 300;
const SEARCH_CACHE_PREFIX: &str = "search:";
const SEARCH_SERP_COUNT: usize = 20;

/// Bing organic results live in `li.b_algo` (`h2 a` = title + link,
/// `.b_caption p` = snippet). The harvester returns
/// `{"t":<page title>,"r":[{"u","t","s"}]}` — the page title feeds challenge
/// detection, internal bing/microsoft hops are dropped.
const BING_EXTRACTOR: &str = r#"(function(){function x(n){return n?(n.innerText||n.textContent||"").replace(/\s+/g," ").trim():""}var t=document.title||"";var r=[];try{for(var items=document.querySelectorAll("li.b_algo"),i=0;i<items.length;i++){var it=items[i],a=it.querySelector("h2 a")||it.querySelector("a[href]");if(!a)continue;var u=a.getAttribute("href")||"";if(0!==u.indexOf("http")||/bing\.com|bingj\.com|microsoft\.com|msn\.com/i.test(u))continue;var p=it.querySelector(".b_caption p")||it.querySelector("p");r.push({u:u,t:x(a),s:x(p).substring(0,300)})}}catch(e){}return JSON.stringify({t:t,r:r})})()"#;

/// Host suffixes never surfaced as search hits (SERP-internal navigation).
const SEARCH_HOST_DENYLIST: &[&str] = &["bing.com", "bingj.com", "microsoft.com", "msn.com"];

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchHit {
    pub url: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub query: String,
    pub engine: String,
    pub count: usize,
    pub hits: Vec<SearchHit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl SearchOutcome {
    fn success(query: &str, engine: &str, mut hits: Vec<SearchHit>, cap: usize) -> Self {
        hits.truncate(cap.min(SEARCH_HITS_CAP));
        Self {
            query: query.to_string(),
            engine: engine.to_string(),
            count: hits.len(),
            hits,
            error: None,
            hint: None,
        }
    }

    fn failed(query: &str, error: &str, hint: &str) -> Self {
        Self {
            query: query.to_string(),
            engine: "none".to_string(),
            count: 0,
            hits: Vec::new(),
            error: Some(error.to_string()),
            hint: Some(hint.to_string()),
        }
    }
}

fn parse_hits(payload: &str) -> (String, Vec<SearchHit>) {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        t: String,
        #[serde(default)]
        r: Vec<RawHit>,
    }
    #[derive(Deserialize)]
    struct RawHit {
        #[serde(default)]
        u: String,
        #[serde(default)]
        t: String,
        #[serde(default)]
        s: String,
    }
    let Ok(p) = serde_json::from_str::<Raw>(payload) else {
        return (String::new(), Vec::new());
    };
    (
        p.t,
        p.r.into_iter()
            .filter(|h| !h.u.is_empty() && !h.t.is_empty())
            .map(|h| SearchHit {
                snippet: h.s.chars().take(SEARCH_SNIPPET_CAP_CHARS).collect(),
                title: h.t,
                url: h.u,
            })
            .collect(),
    )
}

/// Cache key for one query: whitespace-collapsed + lowercased (Bing is
/// case-insensitive), prefixed so read and search caches never collide.
pub(crate) fn search_cache_key(raw_query: &str) -> Option<String> {
    let q = raw_query.split_whitespace().collect::<Vec<_>>().join(" ");
    if q.is_empty() || q.chars().count() > 400 {
        return None;
    }
    Some(format!("{SEARCH_CACHE_PREFIX}{}", q.to_lowercase()))
}

fn bing_search_url(query: &str) -> Option<String> {
    let mut u = Url::parse("https://www.bing.com/search").ok()?;
    u.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("count", &SEARCH_SERP_COUNT.to_string());
    Some(u.into())
}

fn host_denied(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .map(|host| SEARCH_HOST_DENYLIST.iter().any(|d| host.ends_with(d)))
        .unwrap_or(true)
}

fn dedupe(hits: Vec<SearchHit>) -> Vec<SearchHit> {
    let mut seen = std::collections::HashSet::new();
    hits.into_iter()
        .filter(|h| seen.insert(h.url.clone()))
        .collect()
}

/// Extract `(text, url)` pairs from Cloudflare's markdown rendering of the
/// SERP (`[title](url)` lines).
fn parse_markdown_links(md: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = md;
    while let Some(open) = rest.find('[') {
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find("](") else {
            break;
        };
        let text = &after_open[..close];
        let after_close = &after_open[close + 2..];
        let Some(paren) = after_close.find(')') else {
            break;
        };
        let link = &after_close[..paren];
        if !text.trim().is_empty() && !link.contains('\n') && link.starts_with("http") {
            out.push((text.trim().to_string(), link.to_string()));
        }
        rest = &after_close[paren + 1..];
    }
    out
}

/// Resolve Bing's `/ck/a` tracking redirects: the real target rides in the
/// `u` query param as `a1` + url-safe base64. Returns `None` for anything
/// else (including redirects that decode to site-relative paths).
fn decode_bing_redirect(url: &str) -> Option<String> {
    use base64::Engine as _;
    let u = Url::parse(url).ok()?;
    if !u.host_str()?.to_lowercase().ends_with("bing.com") || !u.path().starts_with("/ck/") {
        return None;
    }
    let encoded = u.query_pairs().find(|(k, _)| k == "u")?.1;
    let raw = encoded.strip_prefix("a1")?.trim_end_matches('=');
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw).ok()?;
    let decoded = String::from_utf8(bytes).ok()?;
    if decoded.starts_with("http") {
        Some(decoded)
    } else {
        None
    }
}

/// Markdown artifacts out of a SERP hit title (`**Rust**` → `Rust`).
fn clean_search_title(title: &str) -> String {
    title.replace('*', "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Lower is better. Breadcrumb lines (Bing renders the site trail as
/// `[host*url › path* host]`) embed a raw link — never preferred over a
/// real page title; otherwise shorter wins.
fn title_quality(title: &str) -> (u8, usize) {
    (
        u8::from(title.contains("://")),
        title.chars().count(),
    )
}

/// Guard against Bing serving trending-content junk to datacenter IPs (the
/// query stays in the page title while organic slots are swapped out).
/// Passes when any query word (>2 chars) appears in any hit title/URL.
fn hits_relate_to_query(query: &str, hits: &[SearchHit]) -> bool {
    let tokens: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()).to_string())
        .filter(|t| t.chars().count() > 2)
        .collect();
    if tokens.is_empty() {
        return true;
    }
    hits.iter().any(|h| {
        let hay = format!("{} {}", h.title.to_lowercase(), h.url.to_lowercase());
        tokens.iter().any(|t| hay.contains(t))
    })
}

pub async fn search_web(user_id: &str, raw_query: &str, max_results: usize) -> SearchOutcome {
    let query = raw_query.split_whitespace().collect::<Vec<_>>().join(" ");
    let Some(key) = search_cache_key(&query) else {
        return SearchOutcome::failed(
            raw_query,
            "empty or oversized query",
            "Tell the user a non-empty search query is required.",
        );
    };
    let cap = max_results.clamp(1, SEARCH_HITS_CAP);

    if let Some((engine, content)) = cache_get(user_id, &key) {
        if let Ok(hits) = serde_json::from_str::<Vec<SearchHit>>(&content) {
            return SearchOutcome::success(&query, &engine, hits, cap);
        }
    }

    // Tier 0: hidden webview + Bing DOM extractor.
    if let Some(engine) = webview_engine() {
        if let Some(url) = bing_search_url(&query) {
            let fetched =
                tokio::time::timeout(WEBVIEW_TIMEOUT, engine.eval_page(&url, BING_EXTRACTOR)).await;
            if let Ok(Ok(payload)) = fetched {
                let (title, hits) = parse_hits(&payload);
                let titles: String = hits.iter().map(|h| h.title.as_str()).collect();
                if !hits.is_empty() && !looks_like_challenge(&title, &titles) {
                    let hits = dedupe(hits);
                    if let Ok(json) = serde_json::to_string(&hits) {
                        cache_put(user_id, &key, "webview", &json);
                    }
                    return SearchOutcome::success(&query, "webview", hits, cap);
                }
            }
        }
    }

    // Tier 1: Cloudflare Browser Rendering /markdown on the SERP.
    if !cf_configured() {
        return SearchOutcome::failed(
            &query,
            "web search unavailable on-device",
            "Tell the user web search is not available right now.",
        );
    }
    if !reserve_cf(user_id) {
        return SearchOutcome::failed(
            &query,
            "web fetch budget exhausted for today",
            "Tell the user the daily cloud web-fetch limit is reached; try again tomorrow.",
        );
    }
    let Some(url) = bing_search_url(&query) else {
        return SearchOutcome::failed(&query, "bad serp url", "Tell the user the search failed.");
    };
    let client = reqwest::Client::builder()
        .timeout(CF_TIMEOUT)
        .build()
        .unwrap_or_default();
    let tool = browser::generated::BrowserMarkdownExtractTool::new(
        browser::httpclient::ToolOptions::new().with_client(client),
    );
    let args = browser::generated::BrowserMarkdownExtractArgs {
        url: Some(url),
        html: None,
        rejectRequestPattern: None,
        gotoOptions: None,
        userAgent: None,
    };
    match tool.call(args).await {
        Ok(out) if !out.starts_with("API error") => {
            let body = out.trim().to_string();
            if looks_like_challenge("", &body) {
                return SearchOutcome::failed(
                    &query,
                    "search engine is bot-protected right now",
                    "Suggest the user retry in a moment.",
                );
            }
            // Each organic result appears twice in the markdown (breadcrumb
            // line + `## [title]`) pointing at the SAME /ck redirect — keep
            // one hit per resolved URL with the cleanest title.
            let mut hits: Vec<SearchHit> = Vec::new();
            for (text, link) in parse_markdown_links(&body) {
                let target = match decode_bing_redirect(&link) {
                    Some(real) => real,
                    None if !host_denied(&link) => link,
                    None => continue,
                };
                let title = clean_search_title(&text);
                if title.is_empty() {
                    continue;
                }
                if let Some(existing) = hits.iter_mut().find(|h| h.url == target) {
                    if title_quality(&title) < title_quality(&existing.title) {
                        existing.title = title;
                    }
                    continue;
                }
                hits.push(SearchHit {
                    url: target,
                    title,
                    snippet: String::new(),
                });
            }
            if hits.is_empty() || !hits_relate_to_query(&query, &hits) {
                return SearchOutcome::failed(
                    &query,
                    "search engine served no usable results",
                    "Suggest rephrasing the query or retrying in a moment.",
                );
            }
            if let Ok(json) = serde_json::to_string(&hits) {
                cache_put(user_id, &key, "cloudflare", &json);
            }
            SearchOutcome::success(&query, "cloudflare", hits, cap)
        }
        Ok(err) => SearchOutcome::failed(
            &query,
            &format!(
                "cloudflare fetch failed: {}",
                err.chars().take(200).collect::<String>()
            ),
            "Tell the user the search failed.",
        ),
        Err(e) => SearchOutcome::failed(
            &query,
            &format!("cloudflare fetch failed: {e}"),
            "Tell the user the search failed.",
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchArgs {
    pub query: String,
    pub max_results: Option<u32>,
}

pub struct WebSearchTool(pub String);

impl PortableTool for WebSearchTool {
    const NAME: &'static str = "web_search";
    type Args = WebSearchArgs;
    type Output = String;
    type Error = crate::logic::office::OfficeToolError;

    fn description(&self) -> String {
        "Search the public web (Bing) and return ranked results with title, URL, and snippet. Use when you need current information, facts you are unsure of, or anything beyond your training knowledge — do NOT guess URLs. Follow up promising hits with web_read to get full page content.".into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Web search query; plain keywords work best." },
                "maxResults": { "type": "integer", "minimum": 1, "maximum": 10, "description": "How many results to return (default 5)." }
            },
            "required": ["query"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
        let out = search_web(
            &self.0,
            &args.query,
            args.max_results
                .unwrap_or(SEARCH_DEFAULT_HITS as u32) as usize,
        )
        .await;
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

    // -- web search ----------------------------------------------------------

    #[test]
    fn parses_bing_extractor_payload() {
        let payload = r#"{"t":"rust search - Bing","r":[
            {"u":"https://www.rust-lang.org/","t":"Rust Programming Language","s":"A language empowering everyone."},
            {"u":"","t":"dropped empty url"},
            {"u":"https://docs.rs/","t":"docs.rs","s":""}
        ]}"#;
        let (title, hits) = parse_hits(payload);
        assert_eq!(title, "rust search - Bing");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://www.rust-lang.org/");
        assert_eq!(hits[0].snippet, "A language empowering everyone.");
        assert_eq!(hits[1].title, "docs.rs");

        let (title, hits) = parse_hits("not json at all");
        assert!(title.is_empty());
        assert!(hits.is_empty());
    }

    #[test]
    fn builds_encoded_serp_url() {
        let url = bing_search_url("rust async \"send\" bounds").unwrap();
        assert!(url.starts_with("https://www.bing.com/search?"));
        assert!(url.contains("q=rust+async+%22send%22+bounds"));
        assert!(url.contains(&format!("count={SEARCH_SERP_COUNT}")));
    }

    #[test]
    fn search_cache_keys_collapse_whitespace_and_case() {
        assert_eq!(
            search_cache_key("  Rust   ASYNC book "),
            Some("search:rust async book".to_string())
        );
        assert_eq!(search_cache_key("   "), None);
        assert_eq!(
            search_cache_key(&"x".repeat(401)),
            None,
            "oversized queries are rejected"
        );
    }

    #[test]
    fn host_denylist_blocks_serp_internal_links() {
        assert!(host_denied("https://www.bing.com/search?q=x"));
        assert!(host_denied("https://cc.bingj.com/cache.aspx?q=x"));
        assert!(host_denied("https://support.microsoft.com/en-us/topic/x"));
        assert!(host_denied("not a url"), "unparseable links are denied");
        assert!(!host_denied("https://www.rust-lang.org/learn"));
    }

    #[test]
    fn markdown_link_parser_extracts_pairs() {
        let md = "# Results\n\n1. [Rust](https://www.rust-lang.org/) — official site.\n2. [Docs.rs](https://docs.rs) docs\n[broken](ftp://x) dropped (non-http)\n[](https://empty.example/) skipped";
        let pairs = parse_markdown_links(md);
        assert_eq!(
            pairs,
            vec![
                ("Rust".to_string(), "https://www.rust-lang.org/".to_string()),
                ("Docs.rs".to_string(), "https://docs.rs".to_string()),
            ]
        );
    }

    #[test]
    fn dedupe_keeps_first_per_url() {
        let hits = vec![
            SearchHit { url: "https://a".into(), title: "one".into(), snippet: String::new() },
            SearchHit { url: "https://b".into(), title: "two".into(), snippet: String::new() },
            SearchHit { url: "https://a".into(), title: "dup".into(), snippet: String::new() },
        ];
        let d = dedupe(hits);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].title, "one");
    }

    #[test]
    fn decodes_bing_ck_redirects() {
        let redirect = "https://www.bing.com/ck/a?!&&p=bb6b26e6ac3b13ef00d034b085c2c3a1d1069a5d141633d6ea7c95c7179f9320JmltdHM9MTc4NzQ0MzIwMA&ptn=3&ver=2&hsh=4&fclid=2b17987e-ccec-68a1-21dd-8fc0cd7069c1&u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&ntb=1";
        assert_eq!(
            decode_bing_redirect(redirect).as_deref(),
            Some("https://rust-lang.org/")
        );
        // Site-relative target (nav menu) — not a usable hit.
        let nav = "https://www.bing.com/ck/a?!&&p=x&u=a1L2ltYWdlcy9zZWFyY2g";
        assert_eq!(decode_bing_redirect(nav), None);
        // Not a /ck link at all.
        assert_eq!(
            decode_bing_redirect("https://www.rust-lang.org/learn"),
            None
        );
    }

    #[test]
    fn cleans_markdown_out_of_titles() {
        assert_eq!(
            clean_search_title("**Rust** Programming Language"),
            "Rust Programming Language"
        );
        assert_eq!(clean_search_title("   spaced   out "), "spaced out");
        assert_eq!(clean_search_title("***"), "");
    }

    #[test]
    fn breadcrumb_titles_lose_to_real_titles() {
        let breadcrumb = "rust-jp.rshttps://doc.rust-jp.rs rust-jp.rs";
        let real = "Rust by Example";
        assert!(title_quality(real) < title_quality(breadcrumb));
    }

    #[test]
    fn junk_serves_fail_the_relevance_gate() {
        let tokio_hit = SearchHit {
            url: "https://tokio.rs/".into(),
            title: "Tokio - An asynchronous Rust runtime".into(),
            snippet: String::new(),
        };
        let nfl_hit = SearchHit {
            url: "https://www.nfl.com/".into(),
            title: "NFL.com | Official Site".into(),
            snippet: String::new(),
        };
        assert!(hits_relate_to_query("tokio async runtime", &[tokio_hit.clone()]));
        // Token found only in the URL still counts.
        assert!(hits_relate_to_query(
            "tokio async runtime",
            &[SearchHit {
                url: "https://tokio.rs/tokio/tutorial".into(),
                title: "Learn Rust with a web server".into(),
                snippet: String::new(),
            }]
        ));
        assert!(!hits_relate_to_query(
            "tokio async runtime",
            &[nfl_hit.clone()]
        ));
        // Short/tokenless queries can't be gated — always pass.
        assert!(hits_relate_to_query("??", &[nfl_hit]));
    }

    #[test]
    fn search_outcome_caps_hits() {
        let hits: Vec<SearchHit> = (0..20)
            .map(|i| SearchHit {
                url: format!("https://e/{i}"),
                title: format!("t{i}"),
                snippet: String::new(),
            })
            .collect();
        let o = SearchOutcome::success("q", "webview", hits.clone(), SEARCH_HITS_CAP + 5);
        assert_eq!(o.count, SEARCH_HITS_CAP);
        let o = SearchOutcome::success("q", "webview", hits, 3);
        assert_eq!(o.count, 3);

        let f = SearchOutcome::failed("q", "boom", "hint");
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["engine"], "none");
        assert!(v.get("hits").is_some());
        assert!(v.get("hint").is_some());
    }
}
