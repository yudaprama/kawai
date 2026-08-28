# AGENTS.md — agent guide for kawai

Read this before touching the code. Full design lives in `ARCHITECTURE.md`.
This file is the operational rulebook.

## 🚨 GIT SAFETY — ABSOLUTE, NON-OVERRIDABLE RULE 🚨

***NEVER EVER run `git reset` (any mode: `--hard`, `--mixed`, `--soft`), `git revert`, `git checkout <path>`, `git restore`, `git clean`, `git stash drop/pop`, `git commit --amend`, `git rebase`, force-push, or ANY OTHER command that rewrites, moves, or discards commits, staged state, or working-tree content.***

***NOT to fix a wrong commit message. NOT to untangle mixed-up changes. NOT because the diff "looks like someone else's work". NOT as part of restructuring commits. NOT EVEN ONCE, NOT EVEN SOFT/MIXED, NOT WITHOUT AN EXPLICIT PER-COMMAND ORDER FROM THE USER IN THE CURRENT MESSAGE.***

Git usage from an agent is ADDITIVE ONLY: `status`, `log`, `diff`, `show`, `add`, `commit`. If a commit turns out wrong, mislabeled, or tangled: LEAVE IT IN PLACE, report it to the user, and wait — only the user decides whether history gets touched.

**MULTIPLE CODING AGENTS WORK IN THIS REPOSITORY IN PARALLEL.** Expect foreign changes in `git status` / `git log` at any moment. Never assume uncommitted work or a recent commit is yours; NEVER "clean up", revert, re-commit, or build on top of another agent's in-flight changes. Stage and commit ONLY files you yourself edited; if the tree looks tangled or a diff makes no sense to you, report it and stop.

## What this project is

**Product: an AI agents app.** Users pick from a catalog of specialized agents (finance, knowledge, weather, …); each agent is an LLM persona with a curated toolset assembled from domain crates and the application registry (per-category crates of generated agent tools implementing `kawai_tools::AgentTool`). UI: three-pane layout (left sidebar = agent list, center = active agent's chat/content, right sidebar = sessions of the selected agent), dark theme.

Desktop/mobile app (Tauri), with a standalone web server binary.
**End state: desktop + mobile + web from one core. Current phase: MVP, desktop-first — see "Current phase" below.**

- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 (`frontend/`, alias `@/` → `frontend/src`). UI components vendored from the `web/` SPA (`ai-elements/`, `ui/`, `lib/streamdown/`). NO ai-sdk — `lib/ai-types.ts` is a type-only local shim of the `UIMessage`/parts shapes; streaming is raw Tauri `Channel` mapped by `hooks/use-local-chat.ts`.
- **Auth**: dev-bypass via `set_session` for MVP (`KAWAI_AUTH_DEV_USER_ID=demo`). Clerk backend verification (`auth.rs`, public JWKS) remains for the future prod auth flow (post-MVP roadmap: browser + deep link). **No Clerk UI is wired in the React frontend.**
- **Backend**: Rust. Single core logic, two thin transport wrappers.
- **Transport**: Tauri `Channel`+`invoke` (desktop/mobile); HTTP `fetch`+SSE (web — backend only, no web frontend).
- **LLM (on-device)**: LiteRT-LM via `cognee-litert-lm` (path dep, vendored at `cognee-litert-lm/vendor/LiteRT-LM` = upstream `google-ai-edge` main). Behind the `litert` cargo feature. Gemma 4 / Qwen `.litertlm` verified streaming on macOS arm64 CPU. **Auto-download**: if the model is not found locally, `logic::ensure_model()` downloads `gemma-4-E4B-it.litertlm` (3.7 GB) from the public `litert-community/gemma-4-E4B-it-litert-lm` HuggingFace repo (Apache-2.0, no token required) into `~/.kawai/models/` with resume support and progress logging to stderr.
- **LLM (remote)**: hand-rolled OpenAI-compatible SSE client in `crates/foundation/remote-llm` (reqwest POST `/chat/completions`, stream parser). Local Gemma 4 is always the orchestrator; a remote provider pool with health-aware failover serves only the hybrid cloud-subagent tier (details: Configuration below + Roadmap Shipped).
- **DB**: local SQLite via `libsql` crate (desktop MVP). Post-MVP: sqld for multi-device sync.

## Current phase: MVP (desktop-first)

Short-term focus is a **macOS desktop MVP**. The end state is unchanged — desktop + mobile + web from one core — so this phase defers *work*, never *architecture*. The invariants below are exactly what keeps mobile/web cheap later; they all stay law during MVP.

**MVP scope (work only these):**
- macOS desktop app (Tauri, feature `litert`): on-device LLM chat (LiteRT-M), chat history in local SQLite, dev-bypass auth (`KAWAI_AUTH_DEV_USER_ID=demo`).
- Chat UI (React): session sidebar with period grouping, streaming conversation, tool call cards, thinking toggle.
- MVP gaps: none remaining — chat history persistence, the distributable build, and the streaming regression gate are all shipped (see Roadmap → Shipped).

**Deferred — do NOT start without the user asking (tracked in Roadmap):**
- Mobile LLM bazel builds + mobile UI; web frontend; LoRA; GPU/Metal; production hardening. (Agent tier, knowledge/RAG, hybrid cloud subagents, web read/search — all shipped; see Roadmap → Shipped.)
- Prod auth (deep-link) and keychain session persistence are the *first post-MVP milestones* — required before any public release, not part of MVP.

**Still mandatory during MVP (end-state insurance, all cheap):**
- Every new op still gets BOTH wrappers (`commands.rs` + `web.rs`) — this is what keeps web/mobile near-free later.
- `cargo check --features web` stays green for every change; mobile checks whenever shared code changes (`logic.rs`, `auth.rs`, shared deps).
- Identity stays resolved at the transport edge (`user_id` as first arg into `logic.rs`) — never shortcut it for dev-bypass convenience.
- The dev bypass stays env-gated (`KAWAI_AUTH_DEV_USER_ID`), off by default, and NEVER in a shipped build.

## Non-negotiable invariants

1. **`logic.rs` is pure.** Never import `tauri`, `axum`, or any transport type there. It owns business logic and returns `T` or `impl Stream<Item = Event>`.
2. **Two thin wrappers per operation.** One `#[tauri::command]` in `commands.rs`, one Axum route in `web.rs`. Both call the same `logic.rs` fn. No business logic in wrappers.
3. **One operation = one snake_case string**, used identically for: the Rust fn name, the invoke name, and the URL path (`POST /api/<name>`). Tauri uses the fn name **verbatim** (no kebab/camel conversion). Arguments are camelCase on the JS side, mapping to snake_case Rust params.
4. **Frontend uses the `@tauri-apps/api` npm package** (`invoke` / `Channel` from `@tauri-apps/api/core`). The React app is bundled by Vite (`frontend/` → `dist/`, `frontendDist: "../dist"`); never reference `window.__TAURI__` in new code.
5. **No AI SDK.** The chat state is produced by `hooks/use-local-chat.ts` from raw Tauri stream events; the UIMessage/part shapes in `lib/ai-types.ts` are a LOCAL type contract only (field names stay AI-SDK-v5-compatible so the vendored ai-elements components work unmodified). Never add a runtime dep on `ai` / `@ai-sdk/*`.
6. **Web deps stay gated.** `axum`/`tower-http` are `optional`, behind the `web` Cargo feature. The `web` module is `#[cfg(feature = "web")]`. The `kawai-web` binary has `required-features = ["web"]`. Never make axum a non-optional dep — it must stay out of desktop/mobile binaries.
7. **Events.** `#[serde(tag = "type")]` in `logic.rs`; frontend reads `event.type` at runtime. Terminal variants are `finished` / `error`. The frontend mirror of the event union lives in `hooks/use-local-chat.ts` (`LocalChatEvent`) — update BOTH sides when adding a variant (plus `agent.rs` matches on it too).
8. **Identity is resolved at the transport edge, not in `logic.rs`.** Wrappers verify the token and pass `user_id` (`claims.sub`) into `logic.rs` fns as the first param. The frontend NEVER sends `user_id`. `auth.rs` is pure (no tauri/axum): it does JWKS verification (Clerk).
9. **DB builder selection is `cfg`-gated in `logic.rs`, not branched on a transport type.** `#[cfg(feature = "web")]` → remote client; `#[cfg(not(feature = "web"))]` → local SQLite. Keeps `logic.rs` pure.
10. **Vendored components stay in sync with the shim.** `components/ai-elements/*`, `components/ui/*`, `lib/streamdown/` come from the `web/` SPA. When pulling updates from `web/`, re-run the same trims: `ai` imports → `@/lib/ai-types`, strip `react-i18next`, no `@/platform` beyond the slim local adapter (`src/platform/`), no Lexical, no `@xyflow`, no `tokenlens`.

## Commands

Package manager is **bun** (not npm/yarn).

```sh
# Frontend (React, Vite) — dev server on :1420 (Tauri devUrl)
bun run dev            # from kawai/ (vite, root=frontend/)
bun run build          # tsc -b && vite build → dist/
bun run typecheck      # tsc -b --force

# Desktop (Tauri) — the `tauri` npm script is wrapped by scripts/tauri.sh.
# `dev` = on-device LLM stack: litert feature + native/ rpath + dev-bypass
# auth + profraw off (needs the Bazel-built dylibs; run bundle:litert once).
# `build` and everything else pass through unchanged.
bun tauri dev
bun tauri build

# Manual equivalent of `bun tauri dev` (for extra flags like office dev):
cd src-tauri && env \
  RUSTFLAGS="-C link-arg=-Wl,-rpath,<ABS>/cognee-litert-lm/native" \
  LITERT_LM_LIB_DIR=<ABS>/cognee-litert-lm/native \
  LLVM_PROFILE_FILE=/dev/null \
  KAWAI_AUTH_DEV_USER_ID=demo \
  tauri dev -- --features litert

# Prepare the dev dylibs once (fills cognee-litert-lm/native/):
bun run bundle:litert

# Release CI (.github/workflows/release.yml): push to main → bot bumps the patch
# version + tags vX.Y.Z → builds macOS/Linux/Windows bundles + kawai-web into a
# DRAFT GitHub release. Details live in the workflow's own comments.

# Build the LiteRT-LM C library (first build ~15-30 min; cached afterwards)
cd cognee-litert-lm/vendor/LiteRT-LM && bazel build //c:litert-lm --config=macos_arm64 --jobs=6
# then copy + fix the dylib (see Landmines: rpath recipe)

# Distributable build (bundles LiteRT dylibs into the .app)
# First build the dylib (see Landmines), then:
bun run tauri:build:litert-office     # prepare dylibs + build (office ops are in-process)
# Or step by step:
#   bash scripts/bundle-litert-dylibs.sh
#   bun tauri build -- --features litert,office --config .github/tauri-litert.json

# Web standalone server (Axum serves /api/*; no frontend)
cargo run --bin kawai-web --features web

# Dev-bypass auth (accept ANY token as user "demo"; NEVER in prod):
KAWAI_AUTH_DEV_USER_ID=demo cargo run --bin kawai-web --features web

# Android (requires ANDROID_NDK_HOME + ANDROID_NDK_ROOT exported; uses cargo-ndk)
cargo ndk -t arm64-v8a -P 24 check      # NOTE: -P (capital), not -p
cargo ndk -t arm64-v8a -P 24 build

# iOS (requires full Xcode + xcode-select -s)
cargo check --target aarch64-apple-ios
cargo check --target aarch64-apple-ios-sim
```

## Verify before considering work done

Run all that apply. Everything must pass clean:

```sh
bun run build                  # frontend: tsc -b + vite build (frontend changes)
cargo check                    # desktop — axum must NOT compile here
cargo check --features web     # web module + kawai-web bin
cargo check --features litert  # local LLM (bindgen only; no C lib needed)
cargo check --features codegraph  # CodeGraph sidecar AgentTool + LRU cache (zero cost off)
cargo check --features analytics  # data analysis agent (implies office)
```

For mobile, also (during MVP: only when shared code changes — `logic.rs`, `auth.rs`, shared deps; UI/commands-only changes don't need these): `cargo ndk -t arm64-v8a -P 24 check` and/or `cargo check --target aarch64-apple-ios` (NDK r29 at `/opt/homebrew/share/android-ndk`; sim target needs `rustup target add aarch64-apple-ios-sim`).

## Documentation hygiene

Docs describe the **current state only**. History lives in git log, not in the rulebook.

- **Present tense, no migration story.** Never write "X was deleted", "X replaced Y", "superseded by", "formerly", "leftover from". Rewrite the section to describe what exists NOW.
- **Same-commit cleanup.** The change that deletes/replaces a component also removes its mentions everywhere: AGENTS.md (incl. the layout tree + Roadmap), `ARCHITECTURE.md`, `PLAN-*.md`, script/workflow comments, config samples. Before committing, `grep -rn "<thing>" AGENTS.md ARCHITECTURE.md PLAN-*.md scripts/ .github/` must come back clean.
- **Roadmap ✅ entries collapse.** Once an item ships, its entry states the current architecture in one block — drop sub-item history and delete superseded tiers (fold any surviving fact into the successor entry).
- **"legacy" is allowed only while the code still supports it** (e.g. the `KAWAI_DB_DIR` fallback) — otherwise it is stale content and goes.
- **Code comments follow the same rule**: describe what the code does, never what it used to do.

## Troubleshooting

When debugging agent/tool-calling/hybrid-cloud misbehavior, follow
`TROUBLESHOT.md` (repo root): §1 evidence queries (messages, turn_log,
app.log traces), §2 the healthy-turn log shape, §3 symptom→root-cause→action
with exact commands, §4 the post-fix verification block.

## Landmines (things that already bit us)

- **`@types/hast` must stay pinned to 3.0.4.** `resolutions` in `package.json` forces it across the tree. 3.0.5 rewrites `Properties.className` to `string[]` and bun nests per-package copies (under `mdast-util-to-hast`, `@shikijs/*`, …), which SPLITS the `hast` module identity: `mdast-util-to-hast`'s module augmentation (`RootContentMap.raw`) stops applying to the copy `streamdown/lib/markdown.ts` sees → TS2367/TS2339 across the markdown renderer. If you bump it, `bun install --force` and re-check `find node_modules -path '*node_modules/@types/hast' -maxdepth 5 -type d | wc -l` is 1.
- **Frontend deps must be installed before `tauri dev`/`tauri build`.** `bun install` in `kawai/` (Vite root is `frontend/`; deps live at the repo package root). CI already does this.
- **Vite `server.port: 1420` is `strictPort`** (Tauri `devUrl` expects exactly this port) and `watch.ignored` covers `src-tauri/**` — don't let vite watch the Rust side (rebuild loop).
- **`async_stream` streams are not `Unpin`.** `Box::pin(...)` before calling `.next()` in a loop.
- **`Channel::send` takes the value by value**, not `&event` (Tauri 2: `send(data: T)`).
- **`-p` in cargo-ndk collides with cargo `--package`.** Use `-P` / `--platform`. cargo-ndk's panic handler **dumps all env vars to stdout** — never let it panic, and keep secrets out of shell env.
- **`libsql-sys` / `aws-lc-sys` are C.** Mobile needs NDK clang (Android) or Xcode clang (iOS) plus libclang for bindgen. Verified working on android arm64 + ios arm64.
- **Cancellation is asymmetric by design.** Web: `AbortController` (connection drop auto-cancels the backend future). Desktop/mobile: frontend `cancel()` calls `invoke('cancel_stream', {streamId})` → `CancellationToken` in the shared registry breaks the `select!` loop. Streaming commands must accept a `stream_id` param and register/clean up a token.
- **Axum 0.8 `from_fn` hardcodes state to `()`.** A middleware that needs shared state can't use `from_fn` + `State<S>`; use `Extension` (our `auth_middleware` reads `Extension<Verifier>`) or `from_fn_with_state`. Don't fight the type inference by annotating `Router<S>` — switch to `Extension`.
- **`libsql` positional tuple params start at arity 2.** `(&str,)` is NOT `IntoParams`; use `vec![x]` (or an array) for a single param. Tuples `(A,B)` and up are fine. Params blanket-impl `T: TryInto<Value>` (so `&str`, `String`, `i64`, … all work).
- **Clerk JWTs are RS256; sqld accepts only EdDSA (post-MVP).** When sqld is added for multi-device sync, never pass a Clerk session JWT to sqld — mint an EdDSA token in the backend first.
- **`dotenvy` does not override existing env vars.** Shell-exported vars win over `.env`. To force dev-bypass auth, `KAWAI_AUTH_DEV_USER_ID=demo cargo run ...`.
- **Two `reqwest` versions coexist** (0.12 direct + jigsawstack; 0.13 via `youtube_transcript`, office-gated). Expected.
- **Clerk dev-mode does NOT work in the Tauri webview.** Dev instances need the `dev_browser` third-party cookie; WKWebView (macOS) blocks third-party cookies → `clerk.load()` always rejects. That's why the React frontend doesn't wire Clerk at all for MVP — it calls `set_session(<any-token>)` which only succeeds when the backend runs the dev bypass (see `use-local-chat.ts` bootstrap). Production auth = browser + deep link (post-MVP roadmap); consider reusing the Kratos OIDC deep-link pattern from the main `web/` SPA (`web/src/platform/tauri.ts`) when that lands.
- **Bazel-built dylibs emit `default.profraw` into the CWD.** If that CWD is `src-tauri/`, the `tauri dev` watcher sees the file change after every run and rebuild-loops the app forever (window opens/closes infinitely). Always set `LLVM_PROFILE_FILE=/dev/null` when running instrumented dylibs from `tauri dev`.
- **The LiteRT-LM dylib's install name is a bazel-relative path.** `dyld` can't find it from `target/debug/kawai` unless you: (1) copy it out of bazel-bin, (2) `install_name_tool -id @rpath/liblitert-lm.dylib` + re-codesign, (3) embed an rpath in the consuming binary via `RUSTFLAGS="-C link-arg=-Wl,-rpath,<dir>"` (a dependency's `cargo:rustc-link-arg` does NOT propagate to the final binary; the app crate's own `build.rs` DOES — it now embeds `@executable_path/../Frameworks` for litert+macOS), and (4) `scripts/bundle-litert-dylibs.sh` copies all companions into `native/`, strips the baked-in `_solib` rpaths, and adds `@loader_path/../Frameworks` so the bundle (`.github/tauri-litert.json` → `Contents/Frameworks/`) and dev both resolve. `DYLD_LIBRARY_PATH` does NOT survive through the tauri CLI.
- **LiteRT-LM streaming C calls are fire-and-forget async.** `litert_lm_conversation_send_message_stream` returns before generation starts; tokens arrive on an engine thread. Dropping the engine/conversation mid-generation segfaults. The blocking task must block until the final callback (`recv_timeout` on a channel fed from the callback) — see `logic::local_llm::local_chat`.
- **sentencepiece needs the patched recipe on macOS.** Upstream's v0.2.2 layout fails strict `hdrs_check`; our vendored WORKSPACE carries the fix (strip-to-src + `PATCH.sentencepiece_darts` + absl/protobuf seds + full absl deps in `BUILD.sentencepiece`). If you change the sentencepiece stanza, `bazel sync --only=sentencepiece` does NOT refetch — delete the repo dir under `/private/var/tmp/_bazel_*/external/sentencepiece` + its marker, then rebuild.
- **Tauri invoke rejects with a bare string, not an `Error`.** Read it via a helper (`errText` in `frontend/src/lib/api.ts`).
- **Web request structs need `#[serde(rename_all = "camelCase")]`.** Tauri maps camelCase invoke args → snake_case params automatically; Axum `Json<T>` does NOT — without the rename, camelCase bodies 422 (bit us 2026-08-16 with the chat ops). Every web request struct with a multi-word field carries the rename.
- **Tool call events in `LocalChatEvent`.** The `local_chat` stream emits `ToolCall` and `ToolResult` variants (not just `Token`). The frontend (`use-local-chat.ts`) AND `agent.rs` both match on the union — add arms for new variants in all matchers or events are silently dropped.
- **pdf_oxide is a git dep (crates.io-free), not a submodule.** `src-tauri` pulls it from `https://github.com/yfedoseev/pdf_oxide` behind the `office` feature; `crates/integrations/ragloader` and `crates/office-tools/pdf` resolve it through the workspace (same version source as src-tauri's lockfile). MSRV 1.88, default features only (`icc` + `legacy-crypto`; no `rendering`/`ocr`/`fips` — keeps it C-dep-free). Cold compile of the office feature grows by a few minutes (pure Rust, cached afterwards).
- **PDF text replace is DOM-based, not content-stream regex.** `pdf_replace_text` composes `find_text` (regex predicate per element) + `set_text` — a match that spans fragmented sibling text elements in the content stream is NOT found, and replaced text keeps the original element bbox (no reflow). Fine for token substitutions (dates, names, codes); heavy rewrites should regenerate the source document (the `pdf_replace_text` tool description says exactly this).

## Where things live

```
frontend/                        # React 19 + Vite + Tailwind v4 SPA (vite root) — full file-level map lives in frontend/AGENTS.md
src-tauri/src/logic.rs           # PURE helpers (greet/whoami/generate_activity, resolve_model_path/ensure_model auto-download, delete_chat_session → evidence_cache); re-exports db::*; generate_session_title now in kawai-db
src-tauri/src/logic/             # thin shims → crates/* (pub use kawai_*::*), one per domain — logic.rs stays pure, wrappers stay thin
crates/
├── foundation/                     # shared infrastructure
│   ├── agent-contract/ (kawai-agent-contract) # AgentContext/SqlProfile/ToolBuilder/AgentInfo/AgentDefinition (capabilities + capability/confirmation/summary resolvers)/AgentRegistry — no domain deps
│   ├── auth/ (kawai-auth)         # pure auth — Verifier/Claims/Session, JWKS verify + dev bypass, dotenv loader (no tauri/axum)
│   ├── db/ (kawai-db)             # per-user SQLite — libsql Builder::new_local, user_data_dir/DataRoot, sessions/messages/artifacts/turn_log + migrations 0001-0009 (office/analytics gated) + generate_session_title (Workers AI)
│   ├── remote-llm/ (remote-llm)   # hybrid cloud pool (zai→venice→opencode→openrouter→ollama→poolside→empero, health-aware failover, SSE)
│   ├── skills/ (kawai-skills)     # SKILL.md CRUD (skl-* base62, unique name, version bump) + prompt_block 4k/skill, 12k total (ungated)
│   └── memory/ (kawai-memory)     # L1 memories CRUD (preference/rule/event/fact/goal, mem-* base62) + memory_extract via remote-llm + prompt_block 800/4k/24
├── engines/                        # domain logic & business engines
│   ├── agent/ (kawai-agent)       # registry-injected prompt tool-calling runtime (opener/delta K/V, TurnState, TurnMemory, alias, parsing, subagents, evidence_cache); catalog.rs only holds agent ID constants — built-in composition lives in src-tauri/src/agent_registry.rs
│   ├── analytics/ (analytics)      # polars engine (discover/query/ta_suite/chart, office_oxide xlsx bridge) — pure, no kawai deps
│   ├── graph/ (graph)             # standalone libSQL GraphRAG (Naive/Local/Global/Hybrid/Mix) — pure, used by kawai-knowledge/graph via kawai-agent
│   ├── knowledge/ (kawai-knowledge) # RAG — chunk 1500/200 (MarkdownSplitter) → embed (kawai-embedding) → libSQL vector + FTS5/BM25 RRF, session_files scoping, KnowledgeSearchTool; GraphRAG 5 arms (graph/*)
│   └── office/ (kawai-office)     # per-user docs store (opaque ids, meta.json, kawai-db) + ooxml (DocBlock→docx/xlsx/pptx, office_oxide) + pdf (pdf_oxide search/replace/merge/split/info) + deck (reveal.js html, assets/reveal.*) + AgentTool wrappers (office_* , pdf_*)
├── toolsets/                       # agent toolset adapters
│   ├── analytics-tools/ (kawai-analytics) # thin AgentTool wrappers over crates/engines/analytics engine — data_schema/query/ta/chart (spawn_blocking) + sql_profiles/effective_profiles + DataTablesTool/DataImportTool (sqlx Postgres/MySQL, analytics-sql)
│   ├── binance/                   # Binance agent tools (hand-written, feature "binance"): keyless public spot market data via binance-sdk + in-process TA over ta
│   ├── codegraph/ (codegraph)     # CodeGraph bridge (feature "codegraph" sidecar cached): codegraph_explore/status AgentTools — 15m LRU + single-flight + 12/min budget
│   └── webread/ (webread)         # web read + search tiering (feature "webread", implied by "office"; reusable by any agent): web_read + web_search PortableTools — on-device webview engine (injected trait) → Cloudflare /markdown fallback; web_search = Bing SERP over the same chain with every hit's page auto-fetched; challenge detection, daily budgets, LRU cache
├── integrations/                   # external service clients
│   ├── jigsawstack/               # JigsawStack API client (VOCR, NLP, etc.)
│   ├── ragloader/                 # document parsing + chunking for RAG ingestion (docx/xlsx/pptx via office_oxide, PDF via pdf_oxide)
│   └── youtube-transcript/        # YouTube InnerTube transcript extraction
├── generated-tools/               # auto-generated per-category AgentTool crates (crates-gen)
├── office-tools/                  # handwritten office/PDF AgentTool crates
├── vendor/                        # vendored dependencies (binance-sdk, ta)
└── xtask/                         # build utilities (crates-gen)

src-tauri/src/webview_engine.rs  # tauri-side webread::WebViewFetch: hidden WebviewWindow + eval_with_callback extractor (webread feature; registered in lib.rs, never in kawai-web)
src-tauri/examples/              # headless dev tools: local_llm_smoke (on-device streaming), remote_smoke (cloud tier), draft_smoke (draft_document e2e), binance_smoke (keyless market data + TA; geo-blocked hosts skip), analytics_smoke (data_schema/data_query/data_ta + xlsx bridge; offline), sql_remote_check (LIVE remote SQL — --deep seeds fixture tables), web_read_check (desktop webview chain e2e), turn_log_report (hybrid calibration), agent_eval (H1 gate — office ≥19/20 + analytics ≥16/18)
src-tauri/src/logging.rs         # stderr tee → platform log dir (macOS ~/Library/Logs/, Linux $XDG_STATE_HOME)
src-tauri/src/auth.rs            # shim → kawai-auth (pure auth; Clerk JWKS verify + Session)
src-tauri/src/commands.rs        # #[tauri::command] wrappers + Channel + cancel registry
src-tauri/src/web.rs             # Axum routes (feature-gated "web") + auth_middleware
src-tauri/src/bin/web.rs         # standalone web server entry
src-tauri/src/lib.rs             # Tauri builder; .manage(...); generate_handler!
src-tauri/Cargo.toml             # axum/tower-http behind "web"; cognee-litert-lm + kawai-* crates behind litert/office/analytics/graph/webread
src-tauri/build.rs               # tauri_build + embeds @executable_path/../Frameworks rpath (litert+macOS)
cognee-litert-lm/                # Rust bindings for the LiteRT-LM C API (+ standalone .tflite text-embedding runner) (path dep)
cognee-litert-lm/vendor/LiteRT-LM         # submodule = upstream google-ai-edge main + macOS patches
cognee-litert-lm/native/         # gitignored: prepared LiteRT-LM dylibs (bundle-litert-dylibs.sh fills this)
office_oxide/                    # submodule (path dep, office feature): pure-Rust docx/xlsx/pptx CREATE + read + EDIT + info (markdown → IR; raw-part surgery for in-place edits)

models/                          # .litertlm model files (gitignored, GB-scale)
.env                             # KAWAI_AUTH_* + KAWAI_DB_* (gitignored; dotenvy at startup)
scripts/bundle-litert-dylibs.sh  # prep all LiteRT dylibs into native/ for bundling into the .app
app.log                          # symlink → platform log dir (macOS ~/Library/Logs/kawai/)
```

## Adding a new operation (checklist)

1. Write the pure fn (+ any event enum) in `logic.rs`. Events: `#[serde(tag = "type")]`.
2. Add the `#[tauri::command]` in `commands.rs`:
   - RPC: return `Result<T, String>`.
   - Streaming: take `stream_id: String` + `on_event: Channel<E>` + `State<StreamRegistry>`; loop with `tokio::select!` racing `token.cancelled()` vs `stream.next()`; register/remove token by `stream_id`.
   - If it requires auth: take `State<Session>`, read claims, pass `claims.sub` to the `logic.rs` fn as `user_id`. The frontend never passes `user_id`.
3. Add the Axum route in `web.rs`: RPC → `Json<T>`; streaming → `Sse<impl Stream<Item = Result<Event, _>>>`. Register it in `router()`.
   - If it requires auth: mount it on the `protected` router (behind `auth_middleware`) and take `Extension<auth::Claims>`; pass `claims.sub` to the same `logic.rs` fn. Public ops stay on `public`.
4. Register the command in `lib.rs` `generate_handler!`.
5. Call from React: `call('<name>', args)` from `@/lib/api`, or `streamOperation('<name>', args, handlers)` from `@/lib/stream` — mirror any new event variant in the matching union type (e.g. `LocalChatEvent` in `hooks/use-local-chat.ts`).
6. Verify: `bun run build`, `cargo check`, `cargo check --features web`.

## Authentication

- **MVP (current)**: no auth UI. On boot `use-local-chat.ts` calls `whoami`; on failure it calls `set_session(<any-token>)`, which only succeeds when the backend runs the dev bypass (`KAWAI_AUTH_DEV_USER_ID`). Identity = the bypass user until prod auth lands.
- `set_session` (`commands.rs`) verifies the token and stores the identity in Tauri `State<Session>` (in-memory, per launch).
- Backend verification: `auth::Verifier` fetches Clerk's **public** JWKS (cached by `kid`) and checks `iss`/`exp`. **No `CLERK_SECRET_KEY` is needed or used by the backend** — asymmetric verification.
- Identity → logic: wrappers extract `claims.sub` as `user_id` and pass it as the first arg to `logic.rs` fns. `whoami`/`create_chat_session`/`list_chat_sessions`/`list_chat_messages`/`append_chat_message`/`delete_chat_session`/`skill_create`/`skill_list`/`skill_get`/`skill_update`/`skill_delete`/`memory_create`/`memory_list`/`memory_update`/`memory_delete`/`memory_extract`/`local_load_model`/`local_chat`/`agent_chat` are auth-required (plus the `office`-gated `office_*`/`knowledge_*` ops — incl. `knowledge_list`/`knowledge_add_to_session` — and the `analytics`-gated `sql_profile_list/save/delete/test`); `greet`/`list_agents`/`generate_activity` are public.
- Auth operations: `set_session`, `logout`, `whoami` (one snake_case string each).
- **Prod auth (deferred, post-MVP)**: browser + deep link — open system browser → sign-in → redirect `kawai://auth?token=…` → `set_session`. The `web/` SPA's Kratos deep-link flow (`web/src/platform/tauri.ts`) is the proven pattern to copy.

## Database (local SQLite via libsql)

Desktop MVP: single-device, local SQLite file, no sync.

```
user → (dev bypass / future Clerk) → Rust backend → user_id
                                                    │
   per-user data directory ◀───────────────────────┘
   <data_root>/<user_id>/          ← one folder per user (backup unit)
   ├── kawai.db                    ← Builder::new_local(path)
   └── docs/                       ← office store (files + .meta.json)
```

- `logic::db_connection(user_id)` opens a per-op local SQLite connection; the office store defaults into the same per-user dir (`logic::db::user_data_dir`). Every `db_connection` runs `logic::db_migrations::ensure_schema` first (idempotent, transactional, guarded in-memory per data dir) so schema is always current — do NOT re-add scattered `CREATE TABLE IF NOT EXISTS` in callers.
- Adding schema: new `<NNN>_name.sql` in `src-tauri/migrations/` + a `Migration` entry in `migrations()`; cover it with a test in `db_migrations.rs`'s tests module (runs in the CI lib-test gate). Exception: the FTS5 mirror (`rag_chunks_fts` + triggers) and `rag_chunks`/embeddings tables are rag.rs-owned runtime DDL created on first index (`ensure_vector_schema`/`ensure_fts`) because `CREATE TRIGGER` needs `rag_chunks` to exist first.
- Data root resolution: `KAWAI_DATA_DIR` env → legacy `KAWAI_DB_DIR` env → injected root (`logic::db::set_data_root`; Tauri injects the app-data dir — on macOS `~/Library/Application Support/pro.kawai.app`, from the `pro.kawai.app` identifier in `src-tauri/tauri.conf.json`) → `/tmp/kawai`. `KAWAI_DOCS_DIR` still overrides the docs root to the legacy `<root>/<user_id>/` layout; unset = unified per-user dir. `[A-Za-z0-9_-]` user ids pass through as dir names, anything else hex-encodes.
- **One data directory per user — no `user_id` columns.** Isolation is structural (per-user folder), matching the future sqld-namespace model (end-state roadmap). The `office` RAG tables (`rag_chunks` + FTS5 mirror, `rag_files` index-status, `session_files`) follow the same rule; `session_files(session_id, file_id)` scopes knowledge search to everything a session has referenced.
- Post-MVP: sqld for multi-device sync, EdDSA token minting, embedded replicas.

## Configuration (.env)

Project-root `.env` (gitignored) — backend reads these via `auth::load_dotenv()` at startup:
```
KAWAI_AUTH_JWKS_URI=...        # Clerk public JWKS
KAWAI_AUTH_ISSUER=...          # Clerk frontend-API origin
# KAWAI_AUTH_DEV_USER_ID=dev   # uncomment to accept ANY token as this user (dev only)
KAWAI_DATA_DIR=/path/to/dir    # optional per-user data root; default on desktop = Tauri app-data dir (~/Library/Application Support/pro.kawai.app on macOS), else /tmp/kawai
KAWAI_MODEL_PATH=/path/to/gemma-4-E4B-it.litertlm  # optional on-device model; resolved by logic::resolve_model_path (env → ./models/ → ~/.kawai/models); auto-downloaded on first launch from litert-community/gemma-4-E4B-it-litert-lm if absent
KAWAI_EMBED_MODEL_PATH=/path/to/embeddinggemma.tflite  # optional local embedding graph (litert feature); resolved by kawai-embedding (env → ./models/ → ~/.kawai/models); auto-downloaded from ghanashyamvtatti/embeddinggemma-300m-litert if absent
KAWAI_EMBED_SPM_PATH=/path/to/sentencepiece.model  # optional tokenizer for the local embedding graph; same resolution/download flow
KAWAI_LLM_MAX_TOKENS=16384       # optional context budget (K/V state entries) for the on-device conversation; default 16384, clamped below the model's max (Gemma 4: 32003). Larger = more K/V memory; raise for longer sessions before the prefill-overflow reset.
# ── Hybrid LLM tier — cloud subagents (crates/foundation/remote-llm, PLAN-hybrid-llm-subagents.md) ──
# Provider pool with health-aware failover: every provider with a vault key
# joins the pool in fixed priority (zai → venice → opencode → openrouter →
# ollama → poolside); empero (free, always on) joins after poolside. A retryable failure (429/5xx/401/404/transport)
# moves that provider to cooldown and the next candidate serves the call.
# No vault keys ⇒ pool empty ⇒ agents behave pure-local. No kill-switch env —
# an empty vault is the off state.
KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS=8192  # per-subagent-call output cap
KAWAI_REMOTE_LLM_MATERIALS_CHARS=        # optional absolute ceiling on every provider's materials budget (fuse; can only lower)
# ── Binance agent tools (crates/toolsets/binance) ──
KAWAI_BINANCE_REST_BASE=https://data-api.binance.vision  # optional REST base override; default = api.binance.com (451 geo-blocks some hosting regions — the mirror is the market-data-only endpoint). CI smoke sets it. Also where a testnet base (https://testnet.binance.vision) would go.
BINANCE_API_KEY=  # optional READ-ONLY spot keys; set BOTH to register the binance_balances/binance_open_orders account tools (never compiled in, no trade permission)
BINANCE_API_SECRET=
# ── Web read tiering — Cloudflare fallback budgets (crates/toolsets/webread) ──
# Per-user and global daily caps on Cloudflare Browser Rendering calls (the
# on-device webview tier is free and unbudgeted). Exhaustion returns a
# guidance-carrying tool result, not an error.
KAWAI_CF_PER_USER_DAILY=25    # default 25
KAWAI_CF_GLOBAL_DAILY=300     # default 300 (dev-wallet fuse)
# ── CodeGraph — sidecar binary override (crates/toolsets/codegraph) ──
# Override the `codegraph` binary path for sidecar mode (default: `codegraph` on PATH).
# Useful for dev or custom installs: CODEGRAPH_BIN=/opt/codegraph/bin/codegraph
# CODEGRAPH_BIN=/path/to/codegraph
```
`.env.local` (gitignored) — Clerk publishable key reference: `VITE_CLERK_PUBLISHABLE_KEY` (unused by the React frontend; kept for the future prod-auth flow).

## Roadmap

Priority order: **shipped → post-MVP/pre-release → end state**. Items after "Shipped" are deferred — do not start them without the user asking. `local_llm_reset` / `local_llm_set_thinking` / `local_llm_unload` are already wired (commands + web routes).

### Shipped — current architecture (details: `ARCHITECTURE.md`, `PLAN-*.md`)

- **Chat history**: `sessions(agent_id, title, …)` + `messages(session_id, role, content, …)` in the per-user SQLite DB; ops `create_chat_session`/`list_chat_sessions`/`list_chat_messages`/`append_chat_message`/`delete_chat_session` (both wrappers). Sessions are lazy (created on first message), first user message seeds the title, engine context stays in-memory (restart shows history, model context starts fresh).
- **Agent tier (the product's core)**: agent = an `AgentDefinition` (persona, curated tool builder, capability resolvers) registered in the application composition root (`src-tauri/src/agent_registry.rs`). Domain definitions live in `crates/engines/office/src/agent.rs`, `crates/toolsets/binance/src/agent.rs`, and `crates/toolsets/analytics-tools/src/agent.rs`; the registry is injected into the reusable `kawai-agent` runtime. Local Gemma 4 is the permanent orchestrator doing prompt-based tool calling (the LiteRT-LM Conversation API has no native function calling). Catalog served by `list_agents`: `builtin.office` (default), `builtin.binance` (`binance` feature), `builtin.analytics` (`analytics` feature). Three-pane UI (agents rail / chat+canvas / per-agent sessions) on the React frontend.
- **Skills**: reusable SKILL.md instruction sets — `skills` table (unique name, version counter bumped per update) behind ungated `skill_create/list/get/update/delete` ops (both wrappers). Managed from the Skills asset page (rail → Assets → Skills: list ↔ markdown detail + create/edit dialog). `skills::prompt_block()` injects the user's skills into the agent persona at opener build (4k/skill, 12k total caps; a skill saved mid-session applies from the next session — the opener is per-session).
- **L1 memories**: atomic long-term memory items (`memories` table; kinds preference/rule/event/fact/goal) behind ungated `memory_create/list/update/delete` + `memory_extract` (session transcript → cloud one-shot → JSON candidates → case-insensitive title dedup → stored with `source_session_id`). Extraction needs the hybrid vault; manual CRUD works offline. `memory::prompt_block()` injects L1 memories into the agent persona at opener build (800 char/entry · 4k total · 24 items max; a memory saved mid-session applies from the next session — the opener is per-session). Managed from the Memory asset page's L1 tab (global list + extract-from-block). L2 scenes / L3 persona are not built.
- **Knowledge/RAG (office)**: the Knowledge panel is the only intake — file import, pasted images (ragloader DescriberChain), YouTube transcript import (`knowledge_import_youtube`). `office_index_file` chunks (1500/200) and embeds via the local LiteRT EmbeddingGemma 300M embedder (768d, desktop) or remote providers (mobile) into libSQL vector tables; FTS5/BM25 mirror fused via RRF. `knowledge_search(query, mode)` is a query-only agent tool — `hybrid` (default) / `semantic` / `keyword`; `user_id`+`session_id` bind server-side at toolset build (the model can never supply them). Index status tracked in `rag_files`.
- **Hybrid cloud subagents**: with a remote LLM configured, the `deep_write`/`draft_document` agent tools delegate long-form synthesis to a cloud provider pool while local stays orchestrator (dispatch selects a typed `SubagentHandler` from the call's capability — `agent_chat` resets engine context on takeover so a former `local_chat` session can't overflow the K/V budget). The persistent process log (TurnMemory, backed by the per-session `session_artifacts` SQLite table) records every completed process and survives turns + restarts; oversized results (>4k chars) page back via `artifact_recall(handle, offset)`; subagent `materials` render relevance-ranked from the log under per-provider budgets (with an explicit omissions note + one staging round when slices were dropped); when the vault is configured and the log is big enough, feedback prompts direct the model to close via `deep_write`. Pool/failover details: Configuration below.
- **Web read/search (`crates/toolsets/webread`)**: engine chain — tier 0 on-device hidden webview (`src-tauri/src/webview_engine.rs`) → tier 1 Cloudflare Browser Rendering (per-user/global daily budgets, shared concurrency gate) → MediaWiki full-text search as final fallback (`web_search` only). Challenge detection, 15-min LRU cache, 12k-char cap; every search hit's page auto-fetches through the read chain so the model never needs a follow-up read. Tools register under `any_engine()` (desktop webview + CF; kawai-web degrades to CF-only, no engine ⇒ unregistered).
- **Office + PDF + decks**: office_oxide (docx/xlsx/pptx read/edit/create) and the pdf_oxide git dep (extract/search/replace/merge/split/info — all in-process) behind the `office` feature. Presentation decks default to `office_create_deck`: self-contained reveal.js `.html` (runtime vendored, model HTML sanitized to a script-free vocabulary, `<img data-file>` embeds stored charts) previewable/presentable in-app; `office_export_deck` converts a deck to `.pptx` deterministically (parse → PptxWriter — no LLM); decks read back as markdown (`office_read_document`, RAG-indexable).
- **Analytics**: polars-backed `data_schema`/`data_query` (AST with dtype-aware coercion + self-correcting errors)/`data_ta` (indicator folds, final values only)/`data_chart` (charton SVG render of a query result: bar/line/point/area/histogram/pie — stacked/normalized/grouped bar/area, auto-sorted single-series bar and pie slices, temporal x / log y, saved into the office store as session-associated svg; 500 default / 2000 max, pie ≤20) over office-store tabular files; xlsx/xlsm convert once to typed parquet sidecars via office_oxide; named SQL sources (`sql_profiles`, `analytics-sql` feature) snapshot via `data_tables`/`data_import`.
- **CodeGraph**: surgical code context — `crates/toolsets/codegraph` (`codegraph_explore`/`codegraph_status` AgentTools, 15m LRU + single-flight + 12/min budget) via `codegraph` sidecar (`codegraph explore --json`, `CODEGRAPH_BIN` override); wired into every agent via `agent_registry.rs` when `litert` + `codegraph` are on. Frontend `CodeAssetPage` (status + Register-repo init + explore input + result view); Tauri `codegraph_explore/status/is_available/init` + Axum `/api/codegraph_*` (both wrappers, auth at edge). Zero cost when feature off.
- **Schema migrations**: hand-rolled runner in `logic/db_migrations.rs` applied by every `db_connection` — see Database below for how to add one.
- **CI gates (`.github/workflows/ci.yml`)**: macos/linux/windows smoke jobs (each bazel-builds the LiteRT-LM C engine natively, then runs `local_llm_smoke` LFM2.5 fixture + `remote_smoke` + `draft_smoke` + `binance_smoke` + `analytics_smoke` + `agent_eval` office ≥19/20 and analytics ≥16/18 on E4B), a web job (bun lint/test/build + `cargo check --features web` + `cargo check --features codegraph`), and linux-check (full feature battery + LIVE `sql_remote_check` vs postgres/mysql service containers + analytics/webread + codegraph unit tests).
- **Distributable macOS build + releases**: `scripts/bundle-litert-dylibs.sh` → `.github/tauri-litert.json` (Contents/Frameworks) + the build.rs rpath — release .app needs no dev env; `.github/workflows/release.yml` bot-bumps the patch version on push to main and builds macOS/Linux/Windows bundles + kawai-web into a DRAFT GitHub release.
- **(standing) Upstream maintenance**: sentencepiece macOS fix — PR [#3262](https://github.com/google-ai-edge/LiteRT-LM/pull/3262), assume ignored. The submodule stays on our fork branch (`yudaprama/LiteRT-LM@fix/macos-sentencepiece-hdrs-check`); `cognee-litert-lm/tools/update-litert-lm.sh` rebases onto new upstream main. If merged, drop the commit and repoint at google-ai-edge main.

### Open — post-MVP, pre-release

1. **Production auth = browser + deep link.** Open system browser → sign-in (Clerk or Kratos) → redirect `kawai://auth?token=<jwt>` → `set_session`. Needs the tauri deep-link plugin + a hosted redirect page (or a kawai-web route). The `web/` SPA's Kratos flow (`web/src/platform/tauri.ts`) is the proven pattern; reusing Kratos would unify identity with the main platform.
2. **Desktop/mobile session persistence.** `State<Session>` is in-memory; lost on restart (the dev bypass re-establishes it automatically — fine for MVP). Persist the token in the OS keychain (`keyring` / tauri-plugin-stronghold) and reload on launch.
3. **DB token broker for sqld sync.** `logic::mint_db_token` reads the Ed25519 private key locally — fine for dev, but the private key MUST NOT ship. Add a `db_token` op: kawai-web verifies the identity → mints a short EdDSA token → the device fetches it and feeds `Builder::new_remote_replica`. The private key stays server-side. Requires sqld setup.
4. **Production hardening.** `Secure` session cookie (HTTPS only), CORS only if cross-origin, rate limiting, token refresh rotation. Encrypt `kawai.db` at rest: libsql `encryption` feature (`Cipher::Aes256Cbc` via `Builder::encryption_config`) applied in `db_connection`; DB key lives in the OS keychain (same mechanism as item 2 — macOS/Windows/iOS/Android native, Linux Secret Service with 0600-file fallback). Protects chat history + knowledge chunks at rest; NOT a place for API keys — secrets go straight to the keychain.
5. **Connection pooling + token refresh.** DB connections open per-op (correct, not optimal); pool them for production load.
6. **Tests beyond the smoke gate.** Unit tests still missing for `auth.rs` (JWKS verify) and `logic.rs` (token mint + db round-trip); add toolset-assembly + catalog-integrity tests for the agent tier.

### End state (design work, later)

- **Mobile LLM builds.** Mobile Rust compiles are verified (android arm64 + iOS device/sim); the LiteRT-LM C lib itself isn't built for mobile yet — needs `bazel build //c:litert-lm --config=android_arm64` + a static-link trial (`cognee-litert-lm/build.rs` has the NDK path ready). Mobile UI work rides on this (React frontend grows the mobile platform adapter then).
- **Windows/Linux desktop hardening.** CI jobs exist (`build-linux`/`build-windows` in release.yml, litert bundled via tauri-action). Windows is highest-risk: MSVC bazel flags unexercised; output names differ (`litert-lm.dll`, import lib emitted as `litert-lm.if.lib` — copy to `native/litert-lm.lib` for rustc `-llitert-lm`); companion libraries load from `vendor/LiteRT-LM/prebuilt/<platform>/`, they are NOT outputs of `//c:litert-lm`. The sentencepiece patch may need Linux/Windows siblings if `hdrs_check` fails there.
- **Web platform support.** React-on-web + `@litert-lm/core` WASM inference vs Rust backend as inference proxy vs hybrid — needs a design doc before implementation (flutter_gemma proves the WASM path works in-browser with WebGPU; model download UX and browser memory limits are the open questions).
- **sqld multi-device sync.** Embedded replicas + EdDSA token minting (item 3 above); `--enable-namespaces` for hard per-user DB isolation (token `sub` → namespace) instead of shared namespace.
- **Gemma 4 GPU (Metal) — blocked upstream.** `-gpu.litertlm` variants need backend `GPU_ARTISAN`, whose engine types upstream deleted; the plain `.litertlm` is CPU-locked by its section backend-constraint. Revisit when upstream ships a GPU path for the compiled-model engine.
- **LoRA support.** The C API supports it (`set_lora_path`/`set_lora_rank`) but kawai uses the Conversation API, which manages sessions internally — no SessionConfig injection. Options: Session-API refactor, wait for ConversationConfig support, or hybrid. Decide when a concrete personalization use case justifies it.
