# Kawai Architecture

Desktop/mobile app (Tauri) with a React frontend and Rust backend.
The backend also ships as a standalone web server binary (Axum, feature-gated).

## Goals

- Product: **an AI agents app** — a catalog of specialized agents; each agent = LLM persona + curated toolset from domain crates, composed through `AgentDefinition` tool builders. UI: three-pane — left = agents rail, center = active agent chat + canvas, right = sessions sidebar.
- End state: **desktop + mobile + web from one core**; app logic is 100% shared, only transport and launcher differ per target.
- Current phase: **MVP, desktop-first** (macOS, on-device LLM, dev-bypass auth). Scope and priorities live in `AGENTS.md` → "Current phase" + "Roadmap"; the phase defers work, never architecture — the invariants in AGENTS.md are what keeps mobile/web cheap later.
- Frontend: React 19 + TypeScript + Vite + Tailwind v4, in `frontend/` (built to `dist/`, Tauri `frontendDist: "../dist"`). Chat components vendored from the main `web/` SPA. **No AI SDK** — stream events are mapped to UIMessage-part shapes by hand (`features/chat/hooks/use-supervisor-plan.ts` + `lib/ai-types.ts`).
- Backend: Rust, single core logic. Built-in agent composition is owned by the application root (`src-tauri/src/agent_registry.rs`); the reusable orchestration engine consumes an injected `AgentRegistry`.
- Auth: MVP = dev-bypass (`set_session` with any token, backend-gated by `KAWAI_AUTH_DEV_USER_ID`). Backend retains Clerk JWKS verification (`auth.rs`, public keys only) for the future prod flow (browser + deep link — see AGENTS.md Roadmap).
- LLM: **on-device Gemma 4 via LiteRT-LM is the orchestrator** (decision 2026-08-16). Cloud subagents stream through the hand-rolled OpenAI-compatible SSE client in `crates/foundation/remote-llm` (provider pool with health-aware failover); remote providers are optional configuration. The local model delegates heavy synthesis to cloud subagent tools (`deep_write`, `draft_document`) when a remote LLM is configured. Agent toolsets come from domain crates and are composed by the application root. Design record: `PLAN-hybrid-llm-subagents.md`.
- Persistence: local SQLite via `libsql` crate (desktop MVP). Post-MVP: sqld for multi-device sync.

## Layer diagram

```
┌───────────────────────────────────────────────────────────┐
│  REACT 19 + VITE (frontend/ → dist/) — Tailwind v4        │
│  App.tsx → use-supervisor-plan → lib/api.call() /          │
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

## Request flow — Supervisor end-to-end

What happens when a user sends a prompt. The Supervisor (`kawai-router`) is the **sole desktop execution path**: the LLM only writes a validated plan; a deterministic Rust scheduler executes it against the tool registry. The legacy `agent_chat` prompt-based tool-calling transport is fully removed (engine loop, command, Axum handler, frontend hook, `AgentChatEvent`).

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant FE as Frontend (use-supervisor-plan)
    participant PLAN as commands.rs::plan_task
    participant REG as supervisor::ToolRegistry
    participant EXEC as commands.rs::execute_supervisor_plan
    participant SCHED as kawai-router::run_plan_with_cancel
    participant TOOLS as ToolSet::execute

    U->>FE: type goal, send
    FE->>PLAN: call("plan_task", {goal, sessionId})
    PLAN->>REG: build_supervisor_registry(user, session)
    PLAN->>PLAN: plan_prompt_with_tools(registry) → RemoteLlm
    PLAN->>PLAN: parse_supervisor_plan (extract JSON + validate against registry)
    PLAN-->>FE: validated TaskPlan
    FE->>EXEC: streamOperation("execute_supervisor_plan", {plan, sessionId, streamId})
    EXEC->>SCHED: run_plan_with_cancel(plan, dispatch, limits, cancel)
    loop per wave (max_parallel steps)
        SCHED->>TOOLS: dispatch(step, resolved_args, inputs)
        TOOLS-->>SCHED: StepResult (+ typed Artifacts)
        SCHED-->>FE: SchedulerEvent (stepStarted/Completed/Failed/Skipped)
    end
    opt side-effect step
        SCHED-->>FE: confirmationRequested (streamId + stepId)
        U->>FE: approve / reject
        FE->>EXEC: respond_supervisor_confirmation
    end
    SCHED-->>FE: PlanCompleted / PlanFailed
    FE->>FE: persist user + assistant messages (append_chat_message)
```

1. **Frontend capture & invoke.** `app/App.tsx` routes every composer submission through `features/chat/hooks/use-supervisor-plan.ts`: `plan_task` returns a validated `TaskPlan`, then `streamOperation("execute_supervisor_plan", …)` runs it. Events arrive over a Tauri `Channel` as `SupervisorEvent`s (`planStarted`, `stepStarted`, `confirmationRequested`, `stepCompleted`, `stepFailed`, `stepSkipped`, `planCompleted`, `planFailed`) and are folded into `UIMessage[]` parts. There is exactly one execution path.

2. **Planner.** `supervisor::plan_task` renders `plan_prompt_with_tools(registry)` (tool name/kind/description/input-schema per registered tool), streams one completion from the remote pool (`RemoteLlm`), then `parse_supervisor_plan` extracts the JSON and validates it: structural invariants (caps, deps, acyclicity) plus every step's dispatch key against the `ToolRegistry`. Invalid plans never reach execution.

3. **Execution.** `commands.rs::execute_supervisor_plan` validates session ownership, builds the session-bound registry, and runs `kawai-router::run_plan_with_cancel`: wave-based deterministic scheduling (max parallel, per-step timeout/retries/`onError`), argument resolution with artifact references (`{fromStep, output}`), confirmation gates parked on oneshot channels keyed by `streamId + stepId`, and live `SchedulerEvent`s bridged to `SupervisorEvent`s. Tool output is promoted to typed artifacts (`Text`/`File`/`Structured`).

4. **Confirmation.** Side-effect steps with `requiresConfirmation` emit `confirmationRequested` and pause; the frontend approves/rejects via `respond_supervisor_confirmation` (Tauri command + Axum route). Stale pending gates are swept when the plan stream ends.

5. **Persistence.** The frontend appends the user goal and the plan's final output to session history via the existing `append_chat_message` op; per-step progress renders from live supervisor state.

## Agent catalog & toolset map

Four catalog agents are composed by `src-tauri/src/agent_registry.rs`, each as an `AgentDefinition` containing persona, metadata, a per-turn tool builder, and capability resolvers. Domain definitions live in `crates/engines/office/src/agent.rs`, `crates/toolsets/binance/src/agent.rs`, and `crates/toolsets/analytics-tools/src/agent.rs`. Tools that require runtime resources (webread engines, SQL profiles, Binance credentials) are registered only when available (capability-probe rule). Cross-cutting `codegraph_explore`/`codegraph_status` (feature `codegraph`, sidecar cached) are added to every agent when `litert` + `codegraph` are on.

### `builtin.office` — Office

Document assistant for docx/xlsx/pptx/pdf/HTML decks/YouTube transcripts. It owns document editing, PDF operations, and general file workflows; presentation authoring is focused in `builtin.presentation`.

| Tool | Source | Notes |
|------|--------|-------|
| `office_list_files` | `office::tools` | List all stored files |
| `knowledge_search` | `office::tools` | Hybrid retrieval (vector + BM25) over session-scoped indexed chunks |
| `office_create_document` | `office::tools` | Create docx/xlsx/pptx from markdown blocks (exact-content only) |
| `office_create_deck` | `office::tools` | Compatibility: create a reveal.js HTML deck; dedicated presentation authoring lives in `builtin.presentation` |
| `office_export_deck` | `office::tools` | Compatibility: deterministic deck → `.pptx` conversion (parse → PptxWriter, no LLM) |
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

Persona rules: the Office definition in `crates/engines/office/src/agent.rs`; remote writing rules are appended by the runtime when the definition advertises the document-drafter capability.

### `builtin.presentation` — Presentation

Focused deck-authoring agent for presentations, pitch decks, and speaker decks. It shares the office file store and source-reading tools, but does not receive document-editing or PDF-mutation tools.

| Tool | Source | Notes |
|------|--------|-------|
| `office_list_files` | `office::tools` | Discover source files and existing decks |
| `office_read_document` | `office::tools` | Read source documents and existing decks |
| `office_document_info` | `office::tools` | Inspect source structure before reading |
| `office_create_deck` | `office::tools` | Create a sanitized, self-contained reveal.js HTML deck |
| `office_export_deck` | `office::tools` | Deterministic deck → `.pptx` conversion when explicitly requested |
| `knowledge_search` | `knowledge` | Search session-scoped source material |
| `web_read` / `web_search` | `webread` | Optional research tools when an engine is available |
| `artifact_recall` / `deep_write` | `agent.rs` | Runtime memory and optional cloud narrative synthesis |

The Presentation persona emphasizes audience, narrative structure, one idea per slide, concise content, and local deck authoring. It never uses `draft_document` for a presentation.

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

Persona: the Binance definition in `crates/toolsets/binance/src/agent.rs` (binance + not-android).

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

Persona: the Analytics definition in `crates/toolsets/analytics-tools/src/agent.rs` (analytics feature).

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

## CodeGraph bridge (`codegraph_explore`, `codegraph` feature)

Surgical code context for frequent agent invocations — the model asks how code works, the backend returns verbatim source + call paths + blast radius in one call (`crates/toolsets/codegraph/src/lib.rs`):

1. **Sidecar** — `codegraph explore --json` via `tokio::process::Command` (`CODEGRAPH_BIN` override, default `codegraph` on PATH). Full pipeline (extract + resolution + graph + search) runs in the external CLI; results are guidance-shaped on not-indexed.
2. **Cache** — 15-min LRU (64 entries, global) + single-flight dedup. Repeat queries (1-5 explores/turn is typical) coelesce; hits are free and bypass the 12/min budget on cache misses. `explore_with_cache` is shared by the AgentTool and the Tauri `logic/codegraph.rs` wrapper.
3. **Wiring** — `crates/toolsets/codegraph` provides `CodegraphExploreTool`/`CodegraphStatusTool` (`kawai_tools::AgentTool`). `src-tauri/src/agent_registry.rs` adds both to every agent when `litert` + `codegraph` are on. Tauri `codegraph_explore/status/is_available/init` + Axum `/api/codegraph_*` are thin wrappers (auth at edge, `user_id` first arg). `codegraph_init` registers a repo (runs `codegraph init` — long-running on large repos) and returns the status shape. Frontend `CodeAssetPage` (`frontend/src/features/codegraph/components/code-page.tsx`) shows status + Register-repo (init) + explore input + result view; `frontend/src/lib/api.ts` exposes `codegraphExplore`/`codegraphStatus`/`codegraphInit`. Zero cost when feature off.

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
│       ├── features/          # feature-organized domain code (auth, agents, chat, knowledge, memory, skills, analytics, codegraph, tools, assets)
│       ├── lib/
│       │   ├── ai-types.ts   # LOCAL UIMessage/part type shim — NO ai-sdk runtime
│       │   ├── api.ts        # call() RPC + errText + payload types
│       │   ├── stream.ts     # streamOperation(): Channel + cancel_stream
│       │   └── streamdown/   # vendored markdown/streaming renderer (from web/)
│       ├── hooks/
│       │   └── use-supervisor-plan.ts  # SupervisorEvent → UIMessage parts; plan runs; confirmations
│       ├── components/
│       │   ├── ai-elements/  # vendored chat components (from web/, trimmed)
│       │   └── ui/           # shadcn primitives (from web/)
│       └── platform/         # slim capability adapter (browser APIs only)
├── crates/                     # agent crates (kawai_tools::AgentTool) — auth/remote-llm/db/skills/memory/office/knowledge/analytics-tools/agent/codegraph + analytics/graph/webread/ragloader + per-category tools/*
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
    ├── Cargo.toml            # axum/tower-http behind "web"; kawai-* crates behind litert/office/analytics/graph/webread/codegraph
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
6. **Frontend** — React SPA (`frontend/`), bundled by Vite into `dist/` and served by Tauri. RPC via `@tauri-apps/api/core.invoke`; streaming via `Channel` + `cancel_stream`. Chat state lives in `features/chat/hooks/use-supervisor-plan.ts`, which folds supervisor stream events (`planStarted`/`stepStarted`/`stepCompleted`/`stepFailed`/`stepSkipped`/terminals) into `UIMessage[]` parts; `lib/ai-types.ts` defines those shapes locally (no `ai` npm package — field names stay AI-SDK-v5-compatible so the vendored `ai-elements` components render them unmodified).

## Core dependencies (in `logic.rs` / `auth.rs`)

- **`reqwest`** — remote tier transport: the OpenAI-compatible SSE client in `crates/foundation/remote-llm` (provider pool, health-aware failover) and JWKS fetch in `auth.rs`. rustls-only. Local Gemma 4 via LiteRT-LM is the model (decision 2026-08-16); remote providers are optional configuration, not a requirement.
- **`libsql`** — per-user local SQLite via `Builder::new_local`; connections are per-op and migrations run on every open. Post-MVP: sqld embedded replicas.
- **`jsonwebtoken`** — RS256 (Clerk JWKS verify in `auth.rs`) and EdDSA (sqld token mint in `logic.rs`). Two versions coexist (9.x direct + 10.x transitive) — expected.
- All compile clean across desktop, android arm64, and ios arm64 (default/web/litert feature combos). One rustls (0.23) across the graph — libsql runs core-only (`Builder::new_local` everywhere; re-add its `remote` feature with sqld sync).
- **Frontend**: `@types/hast` pinned to 3.0.4 via `resolutions` (3.0.5 breaks the vendored streamdown — see AGENTS.md Landmines).
