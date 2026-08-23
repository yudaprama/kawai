# Implementation Plan — Web read tiering: on-device webview first, Cloudflare fallback (kawai)

Status: **IMPLEMENTED (2026-08-23)** — phase 1 (desktop) shipped: `web_read`
tool on the office agent, `logic/scrape.rs` engine chain + budgets + cache,
`webview_engine.rs` hidden-webview tier registered in `lib.rs`. This doc is
now a design record; live status in `AGENTS.md` → Roadmap 5 ✅.

Implementation deltas from the original design (discovered while building):

- **Data return uses `eval_with_callback`, not a custom scheme.** Tauri 2's
  `WebviewWindow::eval_with_callback(js, cb)` hands Rust the serialized
  completion value through an `mpsc` channel — no `kawai-scrape://`
  navigation interception needed (the §3.2 scheme design was superseded;
  §7's "no `__TAURI_INTERNALS__` on external pages" reasoning still holds).
- **`fallback.rs` was NOT deleted.** The pre-implementation analysis called
  it a dead stub — wrong: the generated Cloudflare tools call
  `crate::fallback::*` on every error path, and the no-feature half of the
  file (no-op stubs) is live code. Only its `browser-oxide` half is dead
  (the dependency and feature are not declared in the crate manifest).
  It stays as shipped.

Decision context (2026-08-23): the existing `rig-components/tools/browser`
crate ships five generated Cloudflare Browser Rendering tools. They are real
but (a) **not wired into any agent toolset**, and (b) every call costs money
against a **compiled-in vault token shared by all users** — quota and spend are
communal, and the token is extractable from the binary. Meanwhile the app runs
inside a system webview (Android WebView / WKWebView / macOS WKWebView) that
can render pages for free with a device-native fingerprint. The design below
makes the free engine the default and the paid engine the fallback, with
explicit budget guards. Client-side stealth engines (`browser_oxide` =
V8/`deno_core`, CDP drivers like chaser-oxide, Boa, Lightpanda) are
**excluded**: they cannot cross-compile to the mobile targets (roadmap 13) and
are unnecessary for the office agent's read-a-URL use case.

---

## 1. Core concept

> **One agent tool, `web_read(url)`, backed by an engine chain.** The model
> never chooses an engine — it asks to read a page; the backend resolves the
> cheapest engine that succeeds. Engine identity is reported in the result
> body for auditability (`turn_log`), never in the tool manifest.

```
agent (Gemma 4) ── web_read(url) ──▶ logic::scrape::read_markdown(user_id, url)
                                         │
                                         ├─ cache hit (15 min TTL)? ──▶ return (+engine: cache)
                                         │
                                         ├─ Tier 0: webview engine (registered? probe ok?)
                                         │    hidden Tauri webview · system TLS · free
                                         │    challenge/blocked/empty/timeout ──▶ fall through
                                         │
                                         └─ Tier 1: Cloudflare /markdown (browser crate)
                                              budget guard (per-user + global) ──▶ run or refuse
```

Division of labor:

| Concern | Executor | Why |
|---|---|---|
| Ordinary pages, docs, articles, SPAs that render client-side | **Tier 0 webview** | Free, device-native fingerprint, works offline of any API |
| Bot-walled pages (Cloudflare challenge, DataDome, Kasada), webview-unavailable builds | **Tier 1 Cloudflare** | Real headless Chrome server-side; costs quota/money |
| AI extraction (`browser_json_extract` via Workers AI), element scraping | **not wired** (phase 2+) | Inference cost on top of session cost; office agent doesn't need it yet |
| Anything requiring a full stealth engine on-device | **excluded** | V8/deno_core cannot cross-compile to android/ios arm64; violates mobile roadmap |

Hard rule (mirrors the subagent rule in `PLAN-hybrid-llm-subagents.md`): the
engine chain is **invisible to the model**. `web_read` is a deterministic tool
with one arg. Engine choice is an infrastructure concern, not an LLM decision.

## 2. Goals / Non-goals

**Goals**

1. `web_read(url)` tool on the office agent: readable markdown of a public
   page, truncated to the agent context budget.
2. Zero Cloudflare spend for pages the on-device webview can render.
3. Bounded worst-case spend: per-user and global daily CF call caps, response
   cache, and a refusal message (not an error) when the budget is exhausted.
4. All invariants respected: `logic.rs` stays pure (no tauri/axum imports);
   no new RPC op (tool-only — no `commands.rs`/`web.rs`/frontend changes);
   `cargo check`, `cargo check --features web`, and mobile checks stay green.
5. Transport-aware capability: desktop/mobile register the webview engine at
   startup; `kawai-web` never does and degrades to CF-only automatically.
6. Remove the dead `browser_oxide` fallback stub (it cannot compile: no dep,
   no feature declared — see §7).

**Non-goals**

- No click/type/form automation — read-only scraping. Interaction is a future
  design if a use case lands.
- No `browser_json_extract` (Workers AI cost), `browser_scrape_elements`,
  `browser_links_extract`, `browser_content_extract` in phase 1. The generated
  tools stay in the crate; only `/markdown` is wired as Tier 1.
- No self-hosted `browser_oxide` server tier (future, server-side only).
- No BYO-user CF credentials (post-billing feature).
- No changes to the web frontend (existing ToolCall/ToolResult events render
  the tool as-is).

## 3. Architecture

### 3.1 Purity boundary — trait in logic, impl at the edge

`logic.rs` may not import tauri, but the webview engine requires
`tauri::AppHandle`. Resolution follows the existing injected-setter pattern
(`logic::db::set_data_root`, `office::store::set_docs_dir`):

```rust
// src-tauri/src/logic/scrape.rs  (PURE — no tauri/axum)
pub mod scrape;   // added in logic.rs

/// Injected at app startup by the Tauri shell (lib.rs setup hook).
/// kawai-web never registers one; `None` = Tier 0 unavailable.
pub trait WebViewFetch: Send + Sync {
    /// Render `url` in a hidden webview, return the page's readable text
    /// (see §3.3 contract). Must respect the timeout itself or be cancelled.
    fn fetch_text(&self, url: &str) -> futures::future::BoxFuture<'static, Result<String, ScrapeError>>;
}

pub fn set_webview_engine(engine: Option<Arc<dyn WebViewFetch>>); // OnceLock
pub fn webview_engine() -> Option<Arc<dyn WebViewFetch>>;
```

```rust
// src-tauri/src/webview_engine.rs  (tauri-side impl; imported ONLY by lib.rs)
// Creates a hidden WebviewWindow per fetch, injects the extractor + callback
// via eval, receives the payload through the on_navigation guard (§3.2),
// tears the window down. AppHandle comes from the lib.rs setup hook.
```

`webview_engine.rs` imports tauri; `lib.rs` already does. Nothing in
`logic/` gains a transport import. The `web` feature build never compiles
`webview_engine.rs` (kawai-web's entry is `src/bin/web.rs` + `web.rs`).

### 3.2 Webview data-return path (no `__TAURI_INTERNALS__` on external pages)

An external page cannot use Tauri IPC — `@tauri-apps/api` is not loaded there
and `window.__TAURI_INTERNALS__` does not exist (also forbidden by AGENTS.md
invariant 4). The correct channel is a **custom navigation scheme intercepted
by the embedder**:

1. Rust builds a hidden `WebviewWindow` (`visible(false)`) with
   `WebviewUrl::External(url)` — note: `External`, never `App` (that mistake
   circulated in the research notes this plan supersedes).
2. `on_navigation` callback accepts `http(s)://` navigations and **rejects**
   `kawai-scrape://` ones, forwarding their payload instead.
3. After page load (+2s settle for late redirects/challenges), `eval()` a
   small extractor: readability-style text harvest → JSON
   `{title, text, markers}` → base64 → chunked navigations
   `kawai-scrape://chunk/<seq>/<b64>` (≤1.5 KB each), ending with
   `kawai-scrape://end`.
4. The engine reassembles chunks (cap total payload at 2 MB), resolves the
   pending `oneshot`, drops the webview window.
5. `tokio::time::timeout(20 s)` around the whole dance; timeout = engine
   miss → Tier 1. A `Semaphore(1)` serializes fetches app-wide (no window
   spam); waiters queue behind it (bound the queue at 3, beyond that return
   a busy miss).

Webview eval (`evaluateJavaScript` / wry equivalent) runs in the page context
regardless of page CSP, so a strict-CSP target cannot block the callback.

### 3.3 Challenge/block detection (the fallback trigger)

Tier 0 output is checked before being trusted. A page is a **miss** if any of:

- engine error/timeout, or reassembled text empty / < 500 chars;
- marker substring (case-insensitive) in title or body:
  `"just a moment"`, `"checking your browser"`, `"cf-chl"`,
  `"challenge-platform"`, `"attention required"`,
  `"verify you are human"`, `"enable javascript and cookies"`,
  `"request you followed has expired"` (Cloudflare/akamai/datadome families);
- the page is nothing but a meta-refresh/JS redirect to a challenge path.

False positives cost one CF call — acceptable. Detection lives in
`logic/scrape.rs` (pure), so both engines are judged by the same rule.

### 3.4 Tier 1 — reuse the generated CF tool, single code path

Tier 1 does **not** hand-roll HTTP. It calls the existing generated tool from
the `browser` crate, which already owns vault resolution, placeholder
substitution, and error-as-content behavior:

```rust
use browser::cloudflare::BrowserMarkdownExtractTool; // via generated re-export
// args: { url } only — no gotoOptions/userAgent overrides in phase 1
// 30 s timeout; CF session cold-start is the slow path.
```

This adds `browser = { path = "../rig-components/tools/browser" }` to
`src-tauri/Cargo.toml` (pure reqwest+rustls deps — mobile/web checks safe).

### 3.5 The tool

```rust
// logic/scrape.rs
pub struct WebReadTool;
impl PortableTool for WebReadTool {
    const NAME: &'static str = "web_read";
    // args: { url: String }  (required)
    // description: "Read a public webpage as clean text/markdown and return
    //   it. Use when the user shares a URL or asks to look up / summarize /
    //   quote a specific web page. Not a search engine — you must already
    //   have the exact URL."
}
```

Result body (JSON string, mirrors the office tools' envelope style):

```json
{ "url": "...", "engine": "webview|cloudflare|cache", "chars": 8412,
  "truncated": true, "content": "…markdown, capped at 12_000 chars…" }
```

- Cap = `KNOWLEDGE_PER_FILE_CAP` (12k chars) — same budget as one
  @-mentioned document; `truncated` tells the model there is more.
- Budget-refusal result: `{ "error": "web fetch budget exhausted for today",
  "hint": "tell the user the daily cloud-fetch limit is reached" }` — a
  *successful* tool result carrying guidance, so the local model narrates it
  instead of treating it as a tool failure.
- No file ids in results → no interaction with the doc-alias machinery in
  `agent.rs` (no `alias_rewrite_body` arm needed).

### 3.6 Budget guards & cache (pure logic)

| Guard | Default | Env override |
|---|---|---|
| CF calls per user per day | 25 | `KAWAI_CF_PER_USER_DAILY` |
| CF calls globally per day (dev-wallet fuse) | 300 | `KAWAI_CF_GLOBAL_DAILY` |
| Cache TTL | 15 min | — |
| Cache entries per user | 64 (LRU) | — |
| Tier 0 timeout | 20 s | — |
| Tier 1 timeout | 30 s | — |

- State in `OnceLock<Mutex<…>>` keyed by `user_id`; day = local calendar day
  of the data root (UTC date is fine for v1).
- Cache is keyed by normalized URL (scheme+host+path+sorted query; drop
  fragments), shared across engines, and stores the **post-detection**
  markdown — a cached CF answer is never re-fetched by the webview and vice
  versa. Cache hits report `engine: "cache"` (free, and auditable).
- Vault key pool: `httpclient.rs` already resolves comma-separated values by
  random pick (`resolve_env_vars`) — filling the vault pair with multiple
  accounts spreads quota with **zero code change**. Documented, not coded.

### 3.7 Wiring into the agent

```rust
// logic/office/mod.rs::toolset
set.add_tool(tools::WebReadTool);   // registered when scrape::any_engine()
```

- `scrape::any_engine()` = `webview_engine().is_some() || cf_configured()`
  (vault pair present). No engine anywhere (e.g. dev without vault, web
  server with vault stripped) → tool not registered, never offered to the
  model — same rule as the office capability probe.
- `agent.rs` needs **no new dispatch arm**: `web_read` flows through the
  generic ToolSet path; ToolCall/ToolResult events already render in the UI.
- Toolset bloat discipline: one tool, one arg. Gemma 4's tool-choice accuracy
  degrades with manifest size — resist adding the other four CF tools.

### 3.8 Transport matrix

| Build | Tier 0 (webview) | Tier 1 (CF) | Behavior |
|---|---|---|---|
| Desktop Tauri (macOS, `litert`) | ✅ hidden window | ✅ | full chain — the design target |
| Mobile Tauri (future, roadmap 13) | best-effort probe | ✅ | wry/Android/iOS offscreen support verified on-device in phase 2; probe failure degrades to CF-only |
| `kawai-web` (axum, `web` feature) | ❌ never registered | ✅ | CF-only automatically — same tool, same limits |
| CI `linux-check` / `cargo check` | compile-only | compile-only | `scrape.rs` is pure; `browser` crate is reqwest-only; checks stay green |

## 4. Cleanup riding this change (same-commit, per doc hygiene)

1. ~~Delete `rig-components/tools/browser/src/fallback.rs`~~ — **kept**: the
   generated Cloudflare tools call `crate::fallback::*` on their error paths
   and the no-feature half of the file is live (see the status deltas above).
   Its dead `browser-oxide` half (undeclared dep + feature) stays inert.
2. On implementation, update: `AGENTS.md` (layout tree, Roadmap 5 sub-entry),
   `ARCHITECTURE.md` (web read tiering section), this file's Status →
   IMPLEMENTED.

## 5. Testing

- Unit (pure `scrape.rs`): challenge-marker detection truth table; URL
  normalization; cache TTL/LRU eviction; budget counters (per-user, global,
  day rollover); truncation flag; `any_engine()` under
  engine-registered/engine-absent.
- Unit: `WebReadTool` result envelope shapes (success, truncated, refusal).
- Integration (desktop, `litert`): register a stub `WebViewFetch`
  (miss → hit → challenge-text cases) + real CF path behind the existing
  vault; assert chain order, cache short-circuit, and refusal copy.
- E2E manual: `bun tauri dev`, ask the office agent to read a plain page
  (expect `engine: webview`) and a Cloudflare-walled page (expect
  `engine: cloudflare`); confirm both render as tool cards; check
  `turn_log` shows the engine per call (TROUBLESHOT.md §1 queries).
- `agent_eval`: add one scenario — "read this URL and quote the first
  heading" against a local fixture server (not live internet) in phase 2.
- Gates before done: `bun run build` (untouched, but cheap),
  `cargo check`, `cargo check --features web`,
  `cargo check --features litert`, mobile checks (`cargo ndk -t arm64-v8a -P 24
  check`, `cargo check --target aarch64-apple-ios`) since `logic.rs` changes.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Hidden webview unsupported/broken on mobile wry | Capability probe + CF-only degradation; verified on-device in phase 2 before shipping mobile |
| External page redirects to a challenge after render | +2s settle before eval; marker detection runs on the final DOM text |
| Vault token is compiled-in and communal (extractable, shared quota) | Accepted for MVP (same posture as the remote-LLM vault keys); key pool spreads quota; BYO keys post-billing; global daily fuse caps loss |
| CF API latency (cold browser session 5–15 s) | 30 s timeout; cache; tool description tells the model to expect slow results |
| Local model misuses `web_read` as a search engine | Description states "not a search engine — you need the exact URL"; agent_eval scenario guards |
| Window churn on desktop under rapid calls | `Semaphore(1)` + queue bound 3; window is dropped on completion and on timeout |
| `kawai-web` users drain the shared CF budget | Same per-user caps apply (identity is transport-edge-resolved; caps keyed by `user_id`) |

## 7. Superseded research notes

During design (2026-08-23) three external write-ups were evaluated. Recorded
corrections so they don't resurface as decisions:

- `reqwest + rustls` does **not** impersonate JA3/JA4 — ClientHello control
  needs a BoringSSL-class stack; irrelevant anyway because Tier 1 is an API
  call to Cloudflare itself, not a fingerprint-sensitive fetch.
- The circulating Tauri scraper snippet using
  `WebviewUrl::App("https://…")` + `window.__TAURI_INTERNALS__.invoke` is
  wrong twice: external URLs need `WebviewUrl::External`, and external pages
  have no Tauri IPC (hence the custom-scheme channel in §3.2).
- "System webview = 100% undetectable" is an overclaim; webviews carry
  detectable tells. That is why Tier 1 exists.

## 8. File manifest (as implemented)

| File | Change |
|---|---|
| `src-tauri/src/logic.rs` | `#[cfg(feature = "office")] pub mod scrape;` |
| `src-tauri/src/logic/scrape.rs` | NEW — trait, engine chain, detection, cache, budgets, `WebReadTool` (+ unit tests) |
| `src-tauri/src/webview_engine.rs` | NEW — tauri-side `WebViewFetch` impl (hidden window, `eval_with_callback` + mpsc, guaranteed teardown) |
| `src-tauri/src/lib.rs` | office module gate + setup hook: `scrape::set_webview_engine(Some(...))` |
| `src-tauri/src/logic/office/mod.rs` | `toolset()` registers `WebReadTool` when `scrape::any_engine()` |
| `src-tauri/Cargo.toml` | `browser` path dep + `url` dep (both office-gated); tokio gains `sync` feature |
| `rig-components/tools/browser` | unchanged |
| `AGENTS.md` / `ARCHITECTURE.md` | updated with this change |

No changes: `commands.rs`, `web.rs`, `generate_handler!`, frontend,
`agent.rs` event union, migrations.
