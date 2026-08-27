# Kawai Architecture

Desktop/mobile app (Tauri) with a React frontend and Rust backend.
The backend also ships as a standalone web server binary (Axum, feature-gated).

## Goals

- Product: **an AI agents app** — a catalog of specialized agents; each agent = LLM persona + curated toolset from `crates/` (per-category crates of agent tools implementing `kawai_tools::AgentTool`, `registry::toolset_for(names)`). UI: three-pane — left = agents rail, center = active agent chat + canvas, right = sessions sidebar.
- End state: **desktop + mobile + web from one core**; app logic is 100% shared, only transport and launcher differ per target.
- Current phase: **MVP, desktop-first** (macOS, on-device LLM, dev-bypass auth). Scope and priorities live in `AGENTS.md` → "Current phase" + "Roadmap"; the phase defers work, never architecture — the invariants in AGENTS.md are what keeps mobile/web cheap later.
- Frontend: React 19 + TypeScript + Vite + Tailwind v4, in `frontend/` (built to `dist/`, Tauri `frontendDist: "../dist"`). Chat components vendored from the main `web/` SPA. **No AI SDK** — stream events are mapped to UIMessage-part shapes by hand (`hooks/use-local-chat.ts` + `lib/ai-types.ts`).
- Backend: Rust, single core logic.
- Auth: MVP = dev-bypass (`set_session` with any token, backend-gated by `KAWAI_AUTH_DEV_USER_ID`). Backend retains Clerk JWKS verification (`auth.rs`, public keys only) for the future prod flow (browser + deep link — see AGENTS.md Roadmap).
- LLM: **on-device Gemma 4 via LiteRT-LM is the orchestrator** (decision 2026-08-16). Cloud subagents stream through the hand-rolled OpenAI-compatible SSE client in `logic/remote.rs` (provider pool with health-aware failover); remote providers are optional configuration. **Hybrid cloud-subagent tier (2026-08-20):** the local model delegates heavy synthesis to cloud subagent *tools* (`deep_write`, `draft_document`) via prompt-based tool calling when a remote LLM is configured (default `zai` via kawai-vault compiled-in key; `logic/remote.rs`). Agent tier uses prompt-based tool calling on the local model; `crates/` (per-category crates of generated agent tools implementing `kawai_tools::AgentTool`, `registry::toolset_for(names)`) provides the toolsets. Design record: `PLAN-hybrid-llm-subagents.md`.
- Persistence: local SQLite via `libsql` crate (desktop MVP). Post-MVP: sqld for multi-device sync.

## Layer diagram

```
┌───────────────────────────────────────────────────────────┐
│  REACT 19 + VITE (frontend/ → dist/) — Tailwind v4        │
│  App.tsx → use-local-chat → lib/api.call() /              │
│                            lib/stream.streamOperation()   │
├───────────────────────────────────────────────────────────┤
│  FRONTEND ABSTRACTION (Tauri-only, no platform branching) │
│  @tauri-apps/api/core.invoke  (RPC)                       │
│  @tauri-apps/api/core.Channel (streaming)                 │
│  ai-types.ts : local UIMessage/part type shim (no ai-sdk) │
├───────────────────────┬───────────────────────────────────┤
│  Desktop / Mobile     │  Web (backend-only)               │
│  Tauri Channel+invoke │  HTTP fetch + SSE (cookie auth)   │
├───────────────────────┴───────────────────────────────────┤
│  BACKEND WRAPPERS (Rust, thin, no business logic)         │
│  commands.rs #[tauri::command]  │  web.rs Axum routes     │
│  (resolve identity at the edge → pass user_id into logic) │
├───────────────────────────────────────────────────────────┤
│  CORE LOGIC (Rust, pure, platform-agnostic)               │
│  logic.rs : fn() -> T  |  fn() -> Stream<Event>           │
│  auth.rs  : Clerk JWKS verify                             │
├───────────────────────────────────────────────────────────┤
│  per-user local SQLite (libsql Builder::new_local)         │
└───────────────────────────────────────────────────────────┘
```

## Request flow — `agent_chat` end-to-end

What happens when a user sends a prompt (the agent-tier chat transport; the standalone `local_chat` op remains but the frontend no longer invokes it):

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant FE as Frontend (use-local-chat)
    participant CMD as commands.rs::agent_chat
    participant AC as logic::agent_chat
    participant LLM as local_llm (Gemma 4)
    participant CLOUD as RemoteLlm (zai)

    U->>FE: type prompt, send
    FE->>CMD: streamOperation("agent_chat", {agentId, sessionId, message, streamId})
    CMD->>CMD: resolve user_id from Session; register cancel token
    CMD->>AC: agent_chat(user_id, agent_id, sid, message)
    AC->>AC: remote = from_env(); toolset_for(...)  (adds deep_write if remote)
    AC->>AC: reset conversation (takeover); build prompt
    AC->>LLM: local_chat(stream)
    LLM-->>FE: Token events (live render)
    LLM-->>AC: full text
    AC->>AC: parse_tool_call(text)
    alt tool call = deep_write / draft_document AND remote set
        AC->>CLOUD: completion(task)  (stream)
        CLOUD-->>FE: Token events (answer)
        CLOUD-->>AC: result
        AC->>LLM: feed result back (loop)
    else no tool call
        AC-->>FE: final answer
    end
    AC->>AC: db::log_turn (provider, tool, latency)
    AC-->>FE: Finished
```

1. **Frontend capture & invoke.** `App.tsx` → `hooks/use-local-chat.ts` calls `streamOperation("agent_chat", { agentId, sessionId, message, streamId })` (use-local-chat.ts hardcodes `"agent_chat"`). Streaming arrives over a Tauri `Channel` as `#[serde(tag="type")]` events; the frontend mirrors the union in `LocalChatEvent` (`Started`, `Token`, `ToolCall`, `ToolResult`, `Finished`, `Error`).

2. **Transport — Tauri command.** `commands.rs::agent_chat` takes `stream_id`, `on_event: Channel`, `State<Session>`, `State<StreamRegistry>`. The wrapper resolves `user_id` from the session claims (identity at the edge, never inside `logic.rs`), registers a `CancellationToken` keyed by `stream_id`, then calls `logic::agent_chat(...)`. (Web: the equivalent Axum route in `web.rs` mounts on the protected router and takes `Extension<auth::Claims>`.)

3. **Setup (`logic/agent.rs`).** `agent_chat` resolves the agent (`get_agent(agent_id)`), builds the persona (system prompt — richer when a remote is configured), and calls `remote = RemoteLlm::from_env()` — default `zai` (glm-5.3) using a **compiled-in kawai-vault key** (zero-config — providers/models/keys compile in; an empty vault ⇒ `from_env()` returns `None` ⇒ pure-local). It builds `toolset = toolset_for(agent_id, user_id, sid, remote.as_ref())`, which adds `deep_write` **only when `remote.is_some()`** and `draft_document` under the `office` feature. It `yield`s `Started`, loads `prior_turns` from SQLite, and appends the user message.

4. **Generation loop — local model is the orchestrator.** If the conversation manifest isn't injected yet, `agent_chat` **resets the engine conversation** (singleton per user; clears any framing left by `local_chat`) and builds the full prompt = persona + tool manifest + `compact_transcript(prior_turns)` + the user message. It calls `local_llm::local_chat` (LiteRT-LM Conversation API, on-device Gemma 4) — tokens stream out as `Token` events rendered live. On completion `parse_tool_call(&text)`:
   - **tool call + tool ∈ {`deep_write`, `draft_document`} + `remote.is_some()`** → *intercept* (don't run a Rust tool), delegate to the cloud subagent (step 5).
   - other native tool → dispatch via `toolset` (Rust execution), `yield ToolResult`, loop again.
   - **no tool call** → final answer.
   - prefill K/V overflow (`KAWAI_LLM_MAX_TOKENS`, default 16384) → reset + retry once.

5. **Cloud subagent delegation (`logic/remote.rs`).** `deep_write` streams a completion from `zai` and the long-form result is streamed back to the frontend as the answer (with a `ToolResult` card: "cloud writer produced the answer (zai)"). `draft_document` has the cloud write a file via the office engine. The result is fed back into the loop so Gemma 4 can synthesize the final response.

6. **Finalize.** The final answer triggers `db::log_turn` (`logic/db.rs`) — one row in `turn_log`: `provider` (`local` | `zai`), `tool` (`deep_write`/`draft_document`/`NULL`), `latency_ms`, `outcome=answer` — used to calibrate delegation via `turn_log_report`. `agent_chat` `yield`s `Finished`; the frontend completes the UIMessage parts (text + tool cards).

**Design invariant:** Gemma 4 local is the *permanent orchestrator*; the cloud is the most expensive *tool* the model may choose for heavy synthesis. No user-facing provider switch and no kill-switch env — an empty vault IS the off state (no keys ⇒ pure-local agents).

## Agent catalog & toolset map

Three catalog agents (`logic/agent.rs:list_agents()`), each a persona + curated toolset. Toolsets are built per-call by `toolset_for(agent_id, user_id, session_id, remote)` — tools that require runtime resources (webread engines, SQL profiles, Binance credentials) are registered only when available (capability-probe rule).

### `builtin.office` — Office

Document assistant for docx/xlsx/pptx/pdf/HTML decks/YouTube transcripts.

| Tool | Source | Notes |
|------|--------|-------|
| `office_list_files` | `office::tools` | List all stored files |
| `knowledge_search` | `office::tools` | Hybrid retrieval (vector + BM25) over session-scoped indexed chunks |
| `office_create_document` | `office::tools` | Create docx/xlsx/pptx from markdown blocks (exact-content only) |
| `office_create_deck` | `office::tools` | Create a reveal.js HTML deck (default for presentations): sanitized model HTML + vendored runtime, one self-contained `.html`; `<img data-file>` embeds stored charts |
| `office_export_deck` | `office::tools` | Deterministic deck → `.pptx` conversion (parse → PptxWriter, no LLM) |
| `office_read_document` | `office::tools` | Read docx/xlsx/pptx/html-decks as markdown |
| `office_document_info` | `office::tools` | File metadata + structure |
| `office_edit_document` | `office::tools` | In-place edits (declarative ops, pure Rust) |
| `office_restore_backup` | `office::tools` | Undo last edit (swap pre-edit snapshot) |
| `pdf_extract_text` | `office::tools` | PDF → page-separated markdown |
| `pdf_search_text` | `office::tools` | Regex search across PDF text |
| `pdf_replace_text` | `office::tools` | Regex find-replace in PDF (DOM-based) |
| `pdf_merge` | `office::tools` | Merge multiple PDFs |
| `pdf_split` | `office::tools` | Split PDF by page range |
| `pdf_info` | `office::tools` | PDF metadata |
| `web_read` | `webread` | Read a URL → markdown *(capability-probe: engine must exist)* |
| `web_search` | `webread` | Bing SERP → markdown *(capability-probe: engine must exist)* |
| `artifact_recall` | `agent.rs` | Page through oversized tool results from this turn |
| `deep_write` | `agent.rs` | **Subagent only.** Cloud long-form synthesis — streamed to user as final answer *(remote only)* |
| `draft_document` | `agent.rs` | **Subagent only.** Cloud document composition → file created in-process *(remote only)* |

Persona rules: `OFFICE_PERSONA` in `logic/agent.rs` (office feature); `DRAFT_DOCUMENT_RULE` appended when remote is configured.

### `builtin.binance` — Binance

Crypto market data and technical analysis on Binance spot.

| Tool | Source | Notes |
|------|--------|-------|
| `binance_price` | `crates/toolsets/binance` | 24h price stats |
| `binance_depth` | `crates/toolsets/binance` | Order book + derived spread/mid |
| `binance_klines` | `crates/toolsets/binance` | Raw OHLCV candle data |
| `binance_ta_analyze` | `crates/toolsets/binance` | Fetches klines + runs indicator suites in-process (ema/sma/rsi/macd/bb/atr + 12 more) |
| `binance_balances` | `crates/toolsets/binance` | Signed read-only spot balances *(only when `BINANCE_API_KEY` + `BINANCE_API_SECRET` set)* |
| `binance_open_orders` | `crates/toolsets/binance` | Signed read-only open orders *(only when `BINANCE_API_KEY` + `BINANCE_API_SECRET` set)* |
| `web_read` | `webread` | Read a URL → markdown *(capability-probe: engine must exist)* |
| `web_search` | `webread` | Bing SERP → markdown *(capability-probe: engine must exist)* |
| `artifact_recall` | `agent.rs` | Page through oversized tool results from this turn |
| `deep_write` | `agent.rs` | **Subagent only.** Cloud long-form synthesis *(remote only)* |

No `draft_document` — this agent does not create files.

Persona: `BINANCE_PERSONA` in `logic/agent.rs` (binance + not-android).

### `builtin.analytics` — Analytics

Structured queries over tabular data files (csv/parquet/Excel) and SQL sources.

| Tool | Source | Notes |
|------|--------|-------|
| `data_schema` | `logic::analytics` | Discover columns, dtypes, sample rows, sheet names (for xlsx) |
| `data_query` | `logic::analytics` | AST queries: filters → groupBy → aggregations → sort → limit |
| `office_list_files` | `office::tools` | Shared with office agent — list stored files |
| `data_tables` | `logic::analytics` | List tables from configured SQL sources *(only when SQL profiles exist)* |
| `data_import` | `logic::analytics` | Snapshot a SQL table → csv in office store *(only when SQL profiles exist)* |
| `artifact_recall` | `agent.rs` | Page through oversized tool results from this turn |
| `deep_write` | `agent.rs` | **Subagent only.** Cloud long-form synthesis *(remote only)* |

No `draft_document` — analytics produces data answers, not documents.

Persona: `ANALYTICS_PERSONA` in `logic/agent.rs` (analytics feature).

### Subagent wiring

Subagents are tools whose implementation calls a cloud LLM. They are **registered in the ToolSet for manifest visibility** but **intercepted by the loop before dispatch** — the cloud streams tokens directly to the user; the local model never sees their raw output.

| Subagent | Agents that get it | When registered | Behavior |
|----------|-------------------|-----------------|----------|
| `deep_write` | all three | `remote.is_some()` | Streams completion from cloud (default: zai/glm-5.3); result is the final answer token stream to the user. Materials rendered from `TurnMemory` on demand. |
| `draft_document` | office only | `remote.is_some()` + `office` feature | Cloud writes structured JSON `blocks` → file created in-process by Rust (`ooxml::create_document_from_blocks`). Local only sees a short receipt; cloud JSON never enters local K/V context. |
| `artifact_recall` | all three | always (all agents with tools) | Pages the session's persistent process log (`TurnMemory`, backed by the `session_artifacts` table) for oversized tool results — dispatched by the loop, not the ToolSet. |

**Failure handling:** cloud timeout or error → local degrades to answering from its own knowledge; the turn never dies. `draft_document` JSON parse failure → one automatic correction round with the cloud, then falls back.

## Web read tiering (`web_read`, webread feature)

One agent tool, one engine chain — the model asks to read a URL, the backend picks the cheapest engine that succeeds (`crates/toolsets/webread/src/scrape.rs`):

1. **Cache** — 15-min LRU (64/user) keyed by normalized URL, cross-engine.
2. **Tier 0: on-device webview** — `webview_engine.rs` renders the page in a hidden `WebviewWindow` (`WebviewUrl::External`, `visible(false)`), polls `readyState`, harvests text via `eval_with_callback` (external pages have no Tauri IPC — the eval callback is the only return channel), always tears the window down. Free, device-native TLS.
3. **Tier 1: Cloudflare `/markdown`** — the generated `browser` crate tool (vault key pool). Tier-0 misses (anti-bot markers, thin content, timeout, busy slot) fall through. Bounded by `KAWAI_CF_PER_USER_DAILY` (25) + `KAWAI_CF_GLOBAL_DAILY` (300); exhaustion returns a guidance-carrying result, not an error.

Purity: `crates/toolsets/webread/src/scrape.rs` defines the `WebViewFetch` trait; the tauri shell injects the implementation at startup (`lib.rs`). `kawai-web` registers nothing and degrades to Cloudflare-only; no engine anywhere ⇒ the tool is not registered (capability-probe rule). Content is capped at 12k chars per read. The tools are reusable by any agent: office registers them under `any_engine()`; binance behind the standalone `webread` cargo feature (`office` implies `webread`).

## Directory layout

```
kawai/
├── package.json              # bun; react, vite, tailwind, vendored-component deps
├── vite.config.ts            # root=frontend/, outDir=dist/, @ → frontend/src, port 1420 strictPort
├── tsconfig{,.app,.node}.json
├── components.json           # shadcn config (aliases @/components, @/lib, @/hooks)
├── frontend/                 # React SPA (vite root)
│   ├── index.html            # entry (dark theme)
│   └── src/
│       ├── main.tsx          # React root
│       ├── App.tsx           # three-pane UI: agents rail, chat + canvas (artifact/knowledge panel), sessions sidebar
│       ├── panels/           # pane components: agents-rail, conversation-panel, sessions-panel, chat-composer, knowledge-panel
│       ├── lib/
│       │   ├── ai-types.ts   # LOCAL UIMessage/part type shim — NO ai-sdk runtime
│       │   ├── api.ts        # call() RPC + errText + payload types
│       │   ├── stream.ts     # streamOperation(): Channel + cancel_stream
│       │   └── streamdown/   # vendored markdown/streaming renderer (from web/)
│       ├── hooks/
│       │   └── use-local-chat.ts  # LocalChatEvent → UIMessage parts; sessions; model mgmt
│       ├── components/
│       │   ├── ai-elements/  # vendored chat components (from web/, trimmed)
│       │   └── ui/           # shadcn primitives (from web/)
│       └── platform/         # slim capability adapter (browser APIs only)
├── crates/                     # agent crates (kawai_tools::AgentTool) — auth/remote-llm/db/skills/memory/office/knowledge/analytics-tools/agent + analytics/graph/webread/ragloader + per-category tools/* (registry::toolset_for)
├── local-llm/                  # on-device LLM engine bindings (litert feature; KAWAI_LLM_MAX_TOKENS)
├── cognee-litert-lm/           # Rust bindings for the LiteRT-LM C API (+ vendored upstream submodule)
├── office_oxide/               # submodule: pure-Rust docx/xlsx/pptx create/read/edit (office feature)
├── scripts/
│   ├── dev.sh                  # tauri dev launcher (litert rpath + dev-bypass auth + profraw off)
│   ├── tauri.sh                # wraps the tauri npm script
│   ├── kv_sweep.sh             # K/V budget sweep wrapper
│   └── bundle-litert-dylibs.sh  # prep LiteRT dylibs into native/ for .app bundling
├── .env                      # KAWAI_AUTH_* + KAWAI_DB_* (gitignored)
├── .env.local                # VITE_CLERK_PUBLISHABLE_KEY (gitignored; reference only)
└── src-tauri/
    ├── Cargo.toml            # axum/tower-http behind "web"; kawai-* crates behind litert/office/analytics/graph/webread
    ├── tauri.conf.json       # devUrl :1420, frontendDist ../dist, beforeBuildCommand "bun run build"
    ├── build.rs              # tauri_build + embeds @executable_path/../Frameworks rpath
    ├── migrations/           # versioned SQLite schema (now also in crates/foundation/db/migrations/, include_str! via kawai-db)
    ├── examples/             # headless dev tools (all require litert feature)
    └── src/
        ├── main.rs           # desktop binary entry
        ├── lib.rs            # Tauri builder + module decls
        ├── logic.rs          # PURE helpers (greet/whoami/generate_activity, resolve_model_path/ensure_model, generate_session_title → kawai-db)
        ├── logic/            # thin shims → crates/* (pub use kawai_*::*): db/db_migrations/skills/memory/office/knowledge/rag/graph/analytics/sql_remote/agent/evidence_cache
        ├── auth.rs           # shim → kawai-auth (pure auth; Clerk JWKS verify + Session)
        ├── commands.rs       # #[tauri::command] wrappers
        ├── web.rs            # Axum router + auth_middleware
        ├── webview_engine.rs # on-device webview fetch engine (office feature)
        └── bin/
            └── web.rs        # standalone web server entry
```

## Layers

1. **`logic.rs`** — the only place for business logic. Pure async fns, no Tauri/Axum imports. Returns `T` (RPC) or `impl Stream<Item = Event>` (streaming). Events tagged `#[serde(tag = "type")]`. Home of `libsql` (per-user DB), the remote SSE client (`remote.rs`), and `mint_db_token` (EdDSA token sqld accepts).
2. **`auth.rs`** — pure auth. `Verifier` validates Clerk session JWTs against the public JWKS (cached by `kid`); `Session` holds the in-process identity for desktop/mobile; `mint` helpers live in `logic.rs`. No transport imports.
3. **`commands.rs`** — thin wrappers. Each core fn → one `#[tauri::command]`. Streaming commands take a `Channel<E>` plus the business args. Auth-required commands read `State<Session>` and pass `claims.sub` as `user_id`.
4. **`web.rs`** — thin wrappers. Each core fn → one Axum route. `auth_middleware` reads the `kawai_session` cookie, verifies it, and injects `Extension<Claims>`. No frontend static serving (Tauri desktop handles frontend).
5. **Launcher**:
   - Desktop/Mobile (`main.rs` → `lib.rs::run()`): Tauri builder, registers commands + `.manage(Verifier)` + `.manage(Session)`. **Does NOT run Axum.**
   - Web (`bin/web.rs`): binds `0.0.0.0:PORT`, serves `/api/*` router. Not a Tauri app.
6. **Frontend** — React SPA (`frontend/`), bundled by Vite into `dist/` and served by Tauri. RPC via `@tauri-apps/api/core.invoke`; streaming via `Channel` + `cancel_stream`. Chat state lives in `hooks/use-local-chat.ts`, which folds backend stream events (`token`/`toolCall`/`toolResult`/terminals) into `UIMessage[]` parts; `lib/ai-types.ts` defines those shapes locally (no `ai` npm package — field names stay AI-SDK-v5-compatible so the vendored `ai-elements` components render them unmodified).

## Core dependencies (in `logic.rs` / `auth.rs`)

- **`reqwest`** — remote tier transport: the OpenAI-compatible SSE client in `logic/remote.rs` (provider pool, health-aware failover) and JWKS fetch in `auth.rs`. rustls-only. Local Gemma 4 via LiteRT-LM is the model (decision 2026-08-16); remote providers are optional configuration, not a requirement.
- **`libsql`** — per-user local SQLite via `Builder::new_local`; connections are per-op and migrations run on every open. Post-MVP: sqld embedded replicas.
- **`jsonwebtoken`** — RS256 (Clerk JWKS verify in `auth.rs`) and EdDSA (sqld token mint in `logic.rs`). Two versions coexist (9.x direct + 10.x transitive) — expected.
- All compile clean across desktop, android arm64, and ios arm64 (default/web/litert feature combos). One rustls (0.23) across the graph — libsql runs core-only (`Builder::new_local` everywhere; re-add its `remote` feature with sqld sync).
- **Frontend**: `@types/hast` pinned to 3.0.4 via `resolutions` (3.0.5 breaks the vendored streamdown — see AGENTS.md Landmines).
