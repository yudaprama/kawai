# AGENTS.md — agent guide for kawai

Read this before touching the code. Full design lives in `ARCHITECTURE.md`.
This file is the operational rulebook.

## What this project is

**Product: an AI agents app.** Users pick from a catalog of specialized agents (finance, knowledge, weather, …); each agent is an LLM persona with a curated toolset assembled from `rig-components/` (per-category crates of generated rig tools — `registry::toolset_for(names)`). UI: three-pane layout (left sidebar = agent list, center = active agent's chat/content, right sidebar = sessions of the selected agent), dark theme.

Desktop/mobile app (Tauri), with a standalone web server binary.
**End state: desktop + mobile + web from one core. Current phase: MVP, desktop-first — see "Current phase" below.**

- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 (`frontend/`, alias `@/` → `frontend/src`). UI components vendored from the `web/` SPA (`ai-elements/`, `ui/`, `lib/streamdown/`). NO ai-sdk — `lib/ai-types.ts` is a type-only local shim of the `UIMessage`/parts shapes; streaming is raw Tauri `Channel` mapped by `hooks/use-local-chat.ts`.
- **Auth**: dev-bypass via `set_session` for MVP (`KAWAI_AUTH_DEV_USER_ID=demo`). Clerk backend verification (`auth.rs`, public JWKS) remains for the future prod auth flow (Roadmap 6 — browser + deep link). **No Clerk UI is wired in the React frontend.**
- **Backend**: Rust. Single core logic, two thin transport wrappers.
- **Transport**: Tauri `Channel`+`invoke` (desktop/mobile); HTTP `fetch`+SSE (web — backend only, no web frontend).
- **LLM (on-device)**: LiteRT-LM via `cognee-litert-lm` (path dep, vendored at `cognee-litert-lm/vendor/LiteRT-LM` = upstream `google-ai-edge` main). Behind the `litert` cargo feature. Gemma 4 / Qwen `.litertlm` verified streaming on macOS arm64 CPU.
- **LLM (remote)**: `rig` — on crates.io `0.42` (published 2026-08-17); every consumer (`src-tauri`, `rig-components/*`, `rig-libsql`, `kawai-embedding`, `local-llm`) uses that same semver source so the rig-core types unify. **Decision (2026-08-16): local Gemma 4 via LiteRT-LM is the orchestrator** — no *replacement* remote provider planned. **Updated 2026-08-20: the hybrid cloud-subagent tier is now wired** — `agent_chat` keeps local Gemma 4 as the permanent orchestrator and delegates heavy synthesis to cloud subagent *tools* (`deep_write`, `draft_document`) via prompt-based tool calling whenever a remote LLM is configured (default `zai`, key from kawai-vault; `logic/remote.rs` + config block below). `rig-components` toolsets are usable standalone (definitions + dispatch) without a rig provider; the agent tier runs on local Gemma 4 with prompt-based tool calling (the LiteRT-LM Conversation API has no native function calling). Remote providers via `rig` are optional configuration (see Roadmap 5 ✅), not a requirement.
- **DB**: local SQLite via `libsql` crate (desktop MVP). Post-MVP: sqld for multi-device sync.

## Current phase: MVP (desktop-first)

Short-term focus is a **macOS desktop MVP**. The end state is unchanged — desktop + mobile + web from one core — so this phase defers *work*, never *architecture*. The invariants below are exactly what keeps mobile/web cheap later; they all stay law during MVP.

**MVP scope (work only these):**
- macOS desktop app (Tauri, feature `litert`): on-device LLM chat (LiteRT-M), chat history in local SQLite, dev-bypass auth (`KAWAI_AUTH_DEV_USER_ID=demo`).
- Chat UI (React): session sidebar with period grouping, streaming conversation, tool call cards, thinking toggle.
- Remaining MVP gaps, in order (details in Roadmap):
  1. Chat history persistence — ✅ Done 2026-08-16 (sessions + messages in SQLite).
  2. Distributable build — ✅ Done 2026-08-17 (litert dylibs bundled into .app).
   3. `local_llm_smoke` streaming regression gate — ✅ Done 2026-08-20 (fixture swapped 2026-08-23: gemma-3-270m went gated=auto on HF, now litert-community/LFM2.5-1.2B-Instruct int8, 1.25 GB, verified streaming+turn-2 locally): `.github/workflows/ci.yml` runs `local_llm_smoke` (LFM fixture, cached) + `remote_smoke` + `draft_smoke` + `agent_eval` on a macos runner that first bazel-builds the LiteRT dylib.

**Deferred — do NOT start without the user asking (tracked in Roadmap):**
- Mobile LLM bazel builds + mobile UI; web frontend; LoRA; GPU/Metal; production hardening. (The agent tier — `rig` wiring, `rig-components` toolset integration, the three-pane catalog UI, and the hybrid cloud-subagent delegation — shipped 2026-08-20; see Roadmap 5 ✅.)
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

# CI release (.github/workflows/release.yml): on push to main a bot bumps the
# patch version in src-tauri/tauri.conf.json, commits + tags vX.Y.Z, then builds
# the macOS .app (tauri-action, features litert, bazel-cached) and the
# kawai-web binary into a DRAFT GitHub release. Needs RELEASE_TOKEN (PAT with
# contents:write) as a repo secret so the bump push doesn't trigger recursive
# runs (GITHUB_TOKEN pushes create no push event — intentional). The same PAT
# authenticates ALL github.com git traffic in the build jobs (insteadOf rewrite)
# — private submodules (cognee-litert-lm, rig-libsql, nested LiteRT-LM fork)
# and private cargo git deps work without workflow changes. The frontend builds
# inside tauri-action via beforeBuildCommand ("bun run build"); setup-bun +
# bun install are already workflow steps.

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
- **Two `jsonwebtoken` versions coexist** (9.x is our direct dep in `auth.rs`/`logic.rs`; 10.x is transitive). Expected.
- **Two `reqwest` versions coexist** (0.12 direct + jigsawstack; 0.13 via `youtube_transcript`, office-gated). Expected — rig-core 0.42 already forces 0.13 into the graph. Note: `cargo check --target aarch64-apple-ios --features office` fails in `ort-sys` (fastembed/ONNX has no iOS prebuilts) — pre-existing since RAG Tier 2, unrelated to reqwest.
- **Clerk dev-mode does NOT work in the Tauri webview.** Dev instances need the `dev_browser` third-party cookie; WKWebView (macOS) blocks third-party cookies → `clerk.load()` always rejects. That's why the React frontend doesn't wire Clerk at all for MVP — it calls `set_session(<any-token>)` which only succeeds when the backend runs the dev bypass (see `use-local-chat.ts` bootstrap). Production auth = browser + deep link (Roadmap 6); consider reusing the Kratos OIDC deep-link pattern from the main `web/` SPA (`web/src/platform/tauri.ts`) when that lands.
- **Bazel-built dylibs emit `default.profraw` into the CWD.** If that CWD is `src-tauri/`, the `tauri dev` watcher sees the file change after every run and rebuild-loops the app forever (window opens/closes infinitely). Always set `LLVM_PROFILE_FILE=/dev/null` when running instrumented dylibs from `tauri dev`.
- **The LiteRT-LM dylib's install name is a bazel-relative path.** `dyld` can't find it from `target/debug/kawai` unless you: (1) copy it out of bazel-bin, (2) `install_name_tool -id @rpath/liblitert-lm.dylib` + re-codesign, (3) embed an rpath in the consuming binary via `RUSTFLAGS="-C link-arg=-Wl,-rpath,<dir>"` (a dependency's `cargo:rustc-link-arg` does NOT propagate to the final binary; the app crate's own `build.rs` DOES — it now embeds `@executable_path/../Frameworks` for litert+macOS), and (4) `scripts/bundle-litert-dylibs.sh` copies all companions into `native/`, strips the baked-in `_solib` rpaths, and adds `@loader_path/../Frameworks` so the bundle (`.github/tauri-litert.json` → `Contents/Frameworks/`) and dev both resolve. `DYLD_LIBRARY_PATH` does NOT survive through the tauri CLI.
- **LiteRT-LM streaming C calls are fire-and-forget async.** `litert_lm_conversation_send_message_stream` returns before generation starts; tokens arrive on an engine thread. Dropping the engine/conversation mid-generation segfaults. The blocking task must block until the final callback (`recv_timeout` on a channel fed from the callback) — see `logic::local_llm::local_chat`.
- **sentencepiece needs the patched recipe on macOS.** Upstream's v0.2.2 layout fails strict `hdrs_check`; our vendored WORKSPACE carries the fix (strip-to-src + `PATCH.sentencepiece_darts` + absl/protobuf seds + full absl deps in `BUILD.sentencepiece`). If you change the sentencepiece stanza, `bazel sync --only=sentencepiece` does NOT refetch — delete the repo dir under `/private/var/tmp/_bazel_*/external/sentencepiece` + its marker, then rebuild.
- **Tauri invoke rejects with a bare string, not an `Error`.** Read it via a helper (`errText` in `frontend/src/lib/api.ts`).
- **Web request structs need `#[serde(rename_all = "camelCase")]`.** Tauri maps camelCase invoke args → snake_case params automatically; Axum `Json<T>` does NOT — without the rename, camelCase bodies 422 (bit us 2026-08-16 with the chat ops). Every web request struct with a multi-word field carries the rename.
- **Tool call events in `LocalChatEvent`.** The `local_chat` stream emits `ToolCall` and `ToolResult` variants (not just `Token`). The frontend (`use-local-chat.ts`) AND `agent.rs` both match on the union — add arms for new variants in all matchers or events are silently dropped.
- **One rig-core source for the whole graph.** `src-tauri`, `rig-components/*`, `rig-libsql`, `kawai-embedding`, and `local-llm` all pin crates.io `rig`/`rig-core` `0.42` (published 2026-08-17). One semver source across the graph so the rig-core types unify at the agent-tier seam. The generator template in `rig-components/gen/src/main.rs` also uses `0.42`. If a newer rig releases, bump ALL of them together.
- **pdf_oxide is a git dep (crates.io-free), not a submodule.** `src-tauri` pulls it from `https://github.com/yfedoseev/pdf_oxide` behind the `office` feature; `rig-components/ragloader` and `rig-components/tools/pdf` resolve it through the workspace (same version source as src-tauri's lockfile). MSRV 1.88, default features only (`icc` + `legacy-crypto`; no `rendering`/`ocr`/`fips` — keeps it C-dep-free). Cold compile of the office feature grows by a few minutes (pure Rust, cached afterwards).
- **PDF text replace is DOM-based, not content-stream regex.** `pdf_replace_text` composes `find_text` (regex predicate per element) + `set_text` — a match that spans fragmented sibling text elements in the content stream is NOT found, and replaced text keeps the original element bbox (no reflow). Fine for token substitutions (dates, names, codes); heavy rewrites should regenerate the source document (the `pdf_replace_text` tool description says exactly this).

## Where things live

```
frontend/                        # React 19 + Vite + Tailwind v4 SPA (vite root)
├── index.html                   # entry, dark class on <html>
├── src/
│   ├── main.tsx                 # React root
│   ├── App.tsx                  # chat UI: session sidebar, Conversation, PromptInput, tool cards
│   ├── lib/
│   │   ├── ai-types.ts          # LOCAL UIMessage/part type shim (NO ai-sdk runtime)
│   │   ├── api.ts               # call() RPC + errText + backend payload types
│   │   ├── stream.ts            # streamOperation(): Channel + cancel_stream
│   │   ├── clipboard.ts         # copy/paste helpers (browser APIs)
│   │   ├── download.ts          # triggerDownload helper
│   │   ├── file-types.ts        # extension → FileKind classification
│   │   ├── utils.ts             # cn() + misc
│   │   └── streamdown/          # vendored markdown/streaming renderer (from web/)
│   ├── hooks/
│   │   ├── use-local-chat.ts    # chat state: LocalChatEvent → UIMessage parts, sessions, model mgmt
│   │   ├── use-streamdown.ts    # streamdown plugins/config (i18n stripped → English)
│   │   ├── use-copy-button.ts   # copy button state
│   │   └── use-copy-to-clipboard.ts
│   ├── components/
│   │   ├── ai-elements/         # vendored chat components (from web/; trimmed)
│   │   │   └── tool-renderers/  # per-domain tool result cards
│   │   ├── ui/                  # shadcn primitives (from web/)
│   │   └── file-icon.tsx        # CDN file-type icons
│   ├── platform/                # slim local adapter (types, index, shared-media) — browser APIs only
│   └── assets/                  # icon-map.json + utils (file icon naming)
src-tauri/src/logic.rs           # PURE logic; rig + libsql + local_llm (litert) + db token minting
src-tauri/src/logic/analytics.rs # data analysis agent tools (feature "analytics"): data_schema/data_query over office-store tabular files (csv/tsv/parquet/xlsx/xlsm); file-id resolution via office store + spawn_blocking dispatch
src-tauri/src/logic/rag.rs       # office-gated RAG: chunk/embed/index (status tracked in rag_files) + session-scoped knowledge_search + knowledge_list/add_to_session/import_youtube/delete_file + image description (ragloader)
src-tauri/src/logic/office/      # office domain (feature "office"): mod.rs + store.rs + ooxml.rs + pdf.rs + tools.rs
src-tauri/src/logic/agent.rs     # prompt-based tool-calling loop (features litert) — personas (office, binance) + agent_chat + cloud subagent interception (deep_write / draft_document)
rig-components/webread/          # web read + search tiering (feature "webread", implied by "office"; reusable by any agent): web_read + web_search PortableTools — on-device webview engine (injected trait) → Cloudflare /markdown fallback; web_search = Bing SERP over the same chain (DOM extractor on tier 0, markdown-link parse on tier 1); challenge detection, daily budgets, LRU cache
src-tauri/src/webview_engine.rs  # tauri-side webread::WebViewFetch: hidden WebviewWindow + eval_with_callback extractor (webread feature; registered in lib.rs, never in kawai-web)
src-tauri/src/logic/remote.rs    # hybrid-tier cloud client (RemoteLlm): one stateless streaming completion per subagent call; zai default (kawai-vault key), OpenAI-compatible endpoints
src-tauri/examples/              # headless dev tools: local_llm_smoke (on-device streaming), remote_smoke (cloud tier), draft_smoke (draft_document e2e), binance_smoke (keyless market data + TA; geo-blocked hosts skip), analytics_smoke (data_schema/data_query + xlsx bridge; offline), web_read_check (desktop tier-0 webview chain e2e — real hidden window + markdown render), turn_log_report (hybrid calibration), agent_eval (H1 orchestration-quality gate — 20 office scenarios, E4B baseline 20/20)
src-tauri/src/logging.rs         # stderr tee → platform log dir (macOS ~/Library/Logs/, Linux $XDG_STATE_HOME)
src-tauri/src/auth.rs            # PURE auth; Clerk JWKS verify + EdDSA mint + Session
src-tauri/src/commands.rs        # #[tauri::command] wrappers + Channel + cancel registry
src-tauri/src/web.rs             # Axum routes (feature-gated "web") + auth_middleware
src-tauri/src/bin/web.rs         # standalone web server entry
src-tauri/src/lib.rs             # Tauri builder; .manage(...); generate_handler!
src-tauri/examples/local_llm_smoke.rs  # headless local-LLM smoke test (features litert)
src-tauri/Cargo.toml             # axum/tower-http behind "web"; cognee-litert-lm behind "litert"
src-tauri/build.rs               # tauri_build + embeds @executable_path/../Frameworks rpath (litert+macOS)
cognee-litert-lm/                # Rust bindings for the LiteRT-LM C API (path dep)
cognee-litert-lm/vendor/LiteRT-LM         # submodule = upstream google-ai-edge main + macOS patches
cognee-litert-lm/native/         # gitignored: prepared LiteRT-LM dylibs (bundle-litert-dylibs.sh fills this)
office_oxide/                    # submodule (path dep, office feature): pure-Rust docx/xlsx/pptx CREATE + read + EDIT + info (markdown → IR; raw-part surgery for in-place edits)
rig-components/                  # per-category rig tool crates (generated; each has registry::toolset_for)
rig-components/binance/          # Binance agent tools (hand-written, feature "binance"): keyless public spot market data via crates.io binance-sdk (rustls-tls + spot only) + in-process TA over ta (binance_price / binance_depth / binance_klines / binance_ta_analyze); signed read-only account tools (binance_balances / binance_open_orders) register only when BINANCE_API_KEY/SECRET are set; vendored binance-connector-rust/ is reference-only
rig-components/analytics/        # polars-backed tabular query engine (feature "analytics"): data_schema discovery + data_query AST (filters/group_by/aggregations/sort/limit, dtype-aware coercion, self-correcting errors); xlsx/xlsm → typed parquet sidecar bridge via office_oxide (date-styled serials → Date/Datetime, sidecar cache fingerprinted on mtime+size)
rig-components/nautilus_trader/  # submodule fork of nautechsystems/nautilus_trader — REFERENCE-ONLY (see PLAN-nautilus-integration.md): formula/pattern/fixture source for the Binance agent tiers; NOT a workspace member, never a path dep, never built by kawai CI
models/                          # .litertlm model files (gitignored, GB-scale)
design-demos/                    # UI mock HTML files (standalone)
.env                             # KAWAI_AUTH_* + KAWAI_DB_* (gitignored; dotenvy at startup)
.env.local                       # VITE_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY (gitignored)
scripts/dev-sqld.sh              # dev launcher for self-hosted sqld
scripts/bundle-litert-dylibs.sh  # prep all LiteRT dylibs into native/ for bundling into the .app
.github/tauri-litert.json        # merges LiteRT dylibs into `bundle.macOS.files` (Contents/Frameworks)
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
- Identity → logic: wrappers extract `claims.sub` as `user_id` and pass it as the first arg to `logic.rs` fns. `whoami`/`create_chat_session`/`list_chat_sessions`/`list_chat_messages`/`append_chat_message`/`delete_chat_session`/`local_load_model`/`local_chat`/`agent_chat` are auth-required (plus the `office`-gated `office_*`/`knowledge_*` ops — incl. `knowledge_list`/`knowledge_add_to_session` — and the `analytics`-gated `sql_profile_list/save/delete`); `greet`/`list_agents`/`generate_activity` are public.
- Auth operations: `set_session`, `logout`, `whoami` (one snake_case string each).
- **Prod auth (Roadmap 6, deferred)**: browser + deep link — open system browser → sign-in → redirect `kawai://auth?token=…` → `set_session`. The `web/` SPA's Kratos deep-link flow (`web/src/platform/tauri.ts`) is the proven pattern to copy.

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
- Data root resolution: `KAWAI_DATA_DIR` env → legacy `KAWAI_DB_DIR` env → injected root (`logic::db::set_data_root`; Tauri injects the app-data dir — on macOS `~/Library/Application Support/pro.kawai.app`, from the `pro.kawai.app` identifier in `src-tauri/tauri.conf.json`) → `/tmp/kawai`. `KAWAI_DOCS_DIR` still overrides the docs root to the legacy `<root>/<user_id>/` layout; unset = unified per-user dir. `[A-Za-z0-9_-]` user ids pass through as dir names, anything else hex-encodes.
- **One data directory per user — no `user_id` columns.** Isolation is structural (per-user folder), matching the future sqld-namespace model (Roadmap 16). The `office` RAG tables (`rag_chunks` + FTS5 mirror, `rag_files` index-status, `session_files`) follow the same rule; `session_files(session_id, file_id)` scopes knowledge search to everything a session has referenced.
- Post-MVP: sqld for multi-device sync, EdDSA token minting, embedded replicas.

## Configuration (.env)

Project-root `.env` (gitignored) — backend reads these via `auth::load_dotenv()` at startup:
```
KAWAI_AUTH_JWKS_URI=...        # Clerk public JWKS
KAWAI_AUTH_ISSUER=...          # Clerk frontend-API origin
# KAWAI_AUTH_DEV_USER_ID=dev   # uncomment to accept ANY token as this user (dev only)
KAWAI_DATA_DIR=/path/to/dir    # optional per-user data root; default on desktop = Tauri app-data dir (~/Library/Application Support/pro.kawai.app on macOS), else /tmp/kawai
KAWAI_MODEL_PATH=/path/to/gemma-4-E4B-it.litertlm  # optional on-device model; resolved by logic::resolve_model_path (env → ./models/ → ~/.kawai/models)
KAWAI_LLM_MAX_TOKENS=16384       # optional context budget (K/V state entries) for the on-device conversation; default 16384, clamped below the model's max (Gemma 4: 32003). Larger = more K/V memory; raise for longer sessions before the prefill-overflow reset.
# ── Hybrid LLM tier — cloud subagents (logic/remote.rs, PLAN-hybrid-llm-subagents.md) ──
# Provider pool with health-aware failover: every provider with a vault key
# joins the pool in fixed priority (zai → venice → opencode →
# openrouter → ollama); a retryable failure (429/5xx/401/404/transport) moves that
# provider to cooldown and the next candidate serves the call. No vault keys
# ⇒ pool empty ⇒ agents behave pure-local. No kill-switch env — an empty
# vault is the off state.
KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS=8192  # per-subagent-call output cap
# ── Binance agent tools (rig-components/binance) ──
KAWAI_BINANCE_REST_BASE=https://data-api.binance.vision  # optional REST base override; default = api.binance.com (451 geo-blocks some hosting regions — the mirror is the market-data-only endpoint). CI smoke sets it. Also where a testnet base (https://testnet.binance.vision) would go.
BINANCE_API_KEY=  # optional READ-ONLY spot keys; set BOTH to register the binance_balances/binance_open_orders account tools (never compiled in, no trade permission)
BINANCE_API_SECRET=
# ── Web read tiering — Cloudflare fallback budgets (rig-components/webread) ──
# Per-user and global daily caps on Cloudflare Browser Rendering calls (the
# on-device webview tier is free and unbudgeted). Exhaustion returns a
# guidance-carrying tool result, not an error.
KAWAI_CF_PER_USER_DAILY=25    # default 25
KAWAI_CF_GLOBAL_DAILY=300     # default 300 (dev-wallet fuse)
```
`.env.local` (gitignored) — Clerk publishable key reference: `VITE_CLERK_PUBLISHABLE_KEY` (unused by the React frontend; kept for the future prod-auth flow).

## Roadmap

Priority order: **MVP track → post-MVP/pre-release → end state**. Items in the later tracks are deferred — do not start them without the user asking. Where things live in the codebase today: `local_llm_reset` / `local_llm_set_thinking` / `local_llm_unload` are already wired (commands + web routes).

### MVP track (now — desktop, on-device LLM, dev-bypass auth)

1. **Chat history persistence.** ✅ Done 2026-08-16: `sessions(agent_id, title, …)` + `messages(session_id, role, content, …)` tables in SQLite (per-user DB — no user columns); ops `create_chat_session`/`list_chat_sessions`/`list_chat_messages`/`append_chat_message` (both wrappers). The default agent is `builtin.office` (the single catalog entry served by `list_agents`); sessions are created lazily on first message, first user message seeds the title, engine context stays in-memory (restart shows history, model context starts fresh).
2. **Distributable desktop build.** ✅ Done 2026-08-17: `scripts/bundle-litert-dylibs.sh` preps all LiteRT dylibs (main C API + 7 companions) into `cognee-litert-lm/native/`; `.github/tauri-litert.json` copies them into `Contents/Frameworks/` via `bundle.macOS.files`; `src-tauri/build.rs` embeds the `@executable_path/../Frameworks` rpath (litert+macOS) so the release .app needs no dev rpath/env. Local: `bun run tauri:build:litert(-office)`.    CI builds via `tauri-action --config .github/tauri-litert.json`.
3. **`local_llm_smoke` streaming regression gate.** ✅ Done 2026-08-20: `.github/workflows/ci.yml` runs `macos-smoke`, `linux-smoke`, and `windows-smoke` jobs (each bazel-builds the LiteRT-LM C engine natively, then runs `cargo test --features litert,office --lib` → `local_llm_smoke` (LFM2.5-1.2B int8 fixture, cached) / `remote_smoke` / `draft_smoke` / `binance_smoke` / `analytics_smoke` / `web_read_check` (tier 0, macOS only) / `agent_eval`), plus a `web` job (ubuntu: `bun install` + `bun run build` + `cargo check --features web`) and a `linux-check` job (`cargo check --features litert,office,binance,webread,analytics` + `cargo test -p analytics` + `cargo test -p webread` + the webview EXTRACTOR JS parse guard). `agent_smoke` stays skipped (interactive cloud state).
4. **(standing) Upstream maintenance.** sentencepiece macOS fix — PR [#3262](https://github.com/google-ai-edge/LiteRT-LM/pull/3262), assume ignored. Submodule stays on our fork branch (`yudaprama/LiteRT-LM@fix/macos-sentencepiece-hdrs-check`); `cognee-litert-lm/tools/update-litert-lm.sh` rebases the fix onto new upstream main. If merged, drop the commit and repoint at `google-ai-edge` main.

### Post-MVP, pre-release (first milestones after MVP ships)

5. **Agent tier foundation — the product's core.** Agent = persona (system prompt) + curated toolset from `rig-components/` (`registry::toolset_for(names)`, used standalone — no rig provider needed). Runs on **local Gemma 4** (decision 2026-08-16): prompt-based tool calling — tool definitions embedded in the system prompt, model replies with JSON tool calls, backend loop in `logic.rs` parses → dispatches via ToolSet → feeds results back. Ship a built-in agent catalog (specialist personas per category), the three-pane UI (left: agent list; right: sessions of the selected agent; center: agent content) — rebuild on the React frontend, and session persistence keyed by `agent_id` (schema from MVP 1). Remote models via `rig` stay pluggable-optional, wired only if/when local quality proves insufficient.
   - ✅ Tool call events in `LocalChatEvent` (2026-08-18): `ToolCall` + `ToolResult` variants; the React frontend renders tool cards in conversation (`App.tsx` + `components/ai-elements/tool`).
   - ✅ React frontend (2026-08-18): React 19 + Vite + Tailwind v4 (`frontend/`), components vendored from the `web/` SPA — chat, sessions sidebar, thinking toggle, tool cards.
   - ✅ Knowledge injection Tier 2 (2026-08-19): idle-time RAG in `logic/rag.rs` — `office_index_file` (extract → chunk 1500/overlap 200 → `kawai-embedding` local fastembed → `rig-libsql` vector store `rag_chunks`), hybrid retrieval (vector + FTS5/BM25 mirror fused via RRF), `knowledge_forget` (disassociate + orphan chunk purge).
    - ✅ Knowledge injection Tier 3 (2026-08-19): `knowledge_search` as an AGENT TOOL, query-only. Upload happens exclusively in the files panel (session-scoped: `office_index_file` indexes + associates the file with the active session). The office agent calls `knowledge_search(query, mode?)` itself; `user_id`+`session_id` are bound server-side when the toolset is built (the model can never supply them). Retrieval mode (optional, defaults to `hybrid`): `hybrid` = vector+BM25 fused via RRF; `semantic` = vector only (paraphrased/conceptual questions); `keyword` = BM25 only, skips the embedder (exact codes/numbers/names — fastest). Unknown values are rejected server-side. Composer is text + image (+ file @-mention chips since 2026-08-22 — the @ button attaches file IDS to the next `agent_chat` call; the backend binds them to the session and lists them in the prompt. Referencing only: file CONTENT never enters the composer or the submit payload — the agent still reads it through tools). No submit-time content injection. The `knowledge_context` op (office feature) remains as a plain extraction helper (per-file 12k / total 36k char caps).
   - ✅ Agent catalog UI three-pane + per-agent session routing (2026-08-19): pane 1 = agent list (collapsible rail; catalog served by the `list_agents` op — backend `logic/agent.rs` is the single source of truth for ids, frontend `AGENT_META` in `panels/agents-rail.tsx` only adds presentation), pane 2 = active agent chat + canvas, pane 3 = sessions of the selected agent (period-grouped, ⌘1/⌘2/⌘3 pane shortcuts). Sessions carry `agent_id`; switching agents resets model context.
   - ✅ Session delete (2026-08-19): op `delete_chat_session` (both wrappers) — deletes `session_files` rows, messages, and the session; indexed chunks stay (files own them). UI: per-session trash button (hover) in the sessions sidebar; deleting the active session starts a fresh chat (`deleteSession` in `use-local-chat.ts`).
   - ✅ Session file tracking UI (2026-08-19): `list_session_files` op (both wrappers) + Files tab split into "In this session" (green checkmark) and "All documents" sections. `useKnowledgeFiles` hook tracks session changes and fetches session-scoped file list. Importing files refreshes both lists.
   - ✅ Knowledge base panel revamp (2026-08-19): Files tab → **Knowledge** tab (sections "In this session" / "Library"). Index status is now visible: `rag_files(file_id, status, chunks, error)` tracks `indexing → ready/failed` in `office_index_file` (stale `indexing` rows read as failed). One list op `knowledge_list` (both wrappers) returns metadata + index state + `inSession` (replaces the panel's two-call fetch; `office_list_files`/`list_session_files` remain). Scope is explicit: `knowledge_add_to_session` associates + auto-indexes chunkless files, `knowledge_forget` (existing) removes from session, `office_delete_file` deletes everywhere (store + chunks + vectors + associations). Rows show badges (Indexing… / N chunks / Index failed + retry) and hover actions; import indexing is tracked instead of fire-and-forget.
    - ✅ Single-source knowledge ingestion (2026-08-19): the knowledge panel is the ONLY intake — composer attachments/screenshot/drag-drop stripped (pasted images are routed into the knowledge import pipeline, not the model). Images import through the office store (ext allowlist + `png/jpg/jpeg/gif/webp`) and index via `ragloader`'s `DescriberChain` (local stub → JigsawStack VOCR; local-only images surface as `failed` until LiteRT-LM multimodal lands). YouTube links ingest via `knowledge_import_youtube` (both wrappers): `youtube_transcript` fetch (en→id→first available fallback) → `yt-<id> <title>.md` in the store → associate + index, deduped by name prefix. Fixed `ragloader` to compile in-tree (`#[async_trait]` on `ImageDescriber`, `text_splitter::Characters`, `jigsawstack::visual::VisionRequest` path) + made `jigsawstack::Querier` Send+Sync.
    - ✅ Hybrid cloud-subagent tier (2026-08-20): `agent_chat` is now the chat transport for every agent; the local model stays the orchestrator and delegates long-form synthesis to cloud subagent *tools* `deep_write` (long text) and `draft_document` (files) via prompt-based tool calling. `toolset_for` adds `deep_write` only when a remote LLM is configured (`remote.is_some()`); `draft_document` is gated behind the `office` feature. `RemoteLlm::from_env` (`logic/remote.rs`) builds a **provider pool** from the kawai-vault **compiled-in** keys (zero-config cloud): fixed priority zai (glm-5.3) → venice → opencode → openrouter → ollama, with health-aware failover (retryable failure ⇒ cooldown from `Retry-After`, capped 300s; cooled candidates stay last so a turn never hard-fails). The failover boundary is the first text token handed to the consumer — a provider that streams zero text (empty completion) fails over too. `agent_chat` **resets the engine conversation on takeover** so a session previously driven by `local_chat` doesn't overflow the K/V budget (8192) and silently fail generation. Headless `chat_route_check` + `agent_smoke`/`remote_smoke`/`draft_smoke` examples exercise the loop; `turn_log_report` calibrates. No vault keys ⇒ agents behave pure-local.
   - ✅ Web read tiering (2026-08-23, `PLAN-web-read-tiering.md`; extracted to the reusable `rig-components/webread` crate 2026-08-24): `web_read(url)` agent tool backed by an engine chain — **tier 0** on-device hidden webview (`src-tauri/src/webview_engine.rs`: `WebviewUrl::External` + `eval_with_callback` extractor; the extractor ships main-content HTML alongside plain text, and webread renders it to Markdown Rust-side via `html-to-markdown-rs` with a text fallback; implements the crate's pure `WebViewFetch` trait, registered in `lib.rs`, never in kawai-web) → **tier 1** Cloudflare Browser Rendering `/markdown` (the generated `browser` crate tool; vault key pool built in). Tier-0 misses are decided by anti-bot marker detection (`looks_like_challenge`) + min-content check; cloud spend is bounded per-user (`KAWAI_CF_PER_USER_DAILY`, default 25/day) and globally (`KAWAI_CF_GLOBAL_DAILY`, default 300/day), budget exhaustion returns a guidance-carrying result (not an error); 15-min cross-engine LRU cache (64/user) keyed by normalized URL; content capped at 12k chars. `kawai-web` degrades to Cloudflare-only; no engine ⇒ tool unregistered. External pages have NO Tauri IPC — the only data-return channel from a scraped page is `eval_with_callback`. `WebViewFetch.eval_page(url, js)` runs caller-supplied extractor JS in the same hidden-window pipeline. Ready-state polls that land during provisional navigation are dropped by WKWebView without the callback firing — `extract()` retries every failed/incomplete poll until the deadline instead of hard-failing (a first-poll failure used to kill the whole fetch). Any agent reuses the tools: office registers them under `any_engine()` in its toolset; binance does the same behind the standalone `webread` cargo feature (`office` implies `webread`). Tier 0 is gated end-to-end on the macOS smoke runner by `web_read_check` (`KAWAI_WEB_READ_REQUIRE_TIER0=1`).
   - ✅ Web search (2026-08-24): `web_search(query, maxResults?)` agent tool — Bing SERP over the same engine chain. Tier 0: hidden webview + a custom DOM extractor (`li.b_algo` → title/url/snippet, internal bing/microsoft hosts dropped); tier 1: Cloudflare `/markdown` on the SERP with markdown-link parsing — Bing `/ck/a` tracking redirects are resolved by base64-decoding the `u` param (breadcrumb lines lose to real page titles; no snippets on this tier), and a relevance gate rejects Bing's trending-content junk-serves (datacenter IPs get the query in `<title>` but swapped-out organic slots — at least TWO distinct query tokens must echo across the hit titles/URLs or the tier falls through, never cached). Tier 2: MediaWiki full-text search via the `wikipedia-search` crate (direct JSON API — free, no rendering, no bot gates; encyclopedic scope only) catches junk-serves and CF outages/budget exhaustion. Default 5 results, hard cap 10 per call. Shares challenge detection, CF budgets, and the LRU cache (keys prefixed `search:`). Registered under the same `any_engine()` gate as `web_read`. Headless check: `cargo run --example web_search_check --features office [-- "<query>"]` (`KAWAI_SEARCH_DEBUG=1` dumps the raw CF markdown; on datacenter paths Bing junk-serves routinely, so expect `engine=wikipedia` there — desktop tier 0 gets real Bing results).
   - ✅ PDF engine: pdf_oxide, in-process (2026-08-21): pdf_oxide is a **git dep** (`https://github.com/yfedoseev/pdf_oxide`, behind the `office` feature, default features only); ALL PDF ops run in-process via `spawn_blocking`. `logic/office/pdf.rs` exposes six pub fns: `pdf_extract_text` (emits `--- page N ---` prefixes via per-page `to_markdown`), `pdf_search_text` (`{page, matches}` groups via `TextSearcher`), `pdf_replace_text` (regex, capture-group aware, via DOM composition `find_text` + `set_text`), `pdf_merge`, `pdf_split`, `pdf_info` (`DocumentEditor`). `capabilities().pdfcli` is constant `true` (field name kept for API compat); the PDF agent tools register unconditionally under office — all office + PDF ops are in-process, no subprocess engine remains. Downstream: `rig-components` ragloader extracts per-page via `PdfDocument::extract_text`, and `tools/pdf` runs in-process (9 tool names/schemas, `engine.rs`); both resolve pdf_oxide through the workspace. Notes: extraction output comes from pdf_oxide's markdown converter (good with columns); already-indexed chunks stay valid, re-ingest to reindex with the new extractor. DOM-replace limitation: regex matches spanning fragmented sibling text elements are not found (see Landmines).
    - ✅ Binance agent (2026-08-24): second catalog entry `builtin.binance` behind the `binance` cargo feature — read-only public Binance spot market data + technical analysis, zero credentials (no vault keys needed; empty pool still yields a fully working agent). Hand-written tool crate `rig-components/binance` (the vendored `binance-connector-rust/` dir is reference-only; the dependency is crates.io `binance-sdk` 68 with `default-features = false` + `rustls-tls` + `spot`): `binance_price` (24h stats), `binance_depth` (order book + derived spread/mid), `binance_klines` (OHLCV rows), and the composite workhorse `binance_ta_analyze` — fetches klines server-side and runs indicator suites in-process via the local `ta` crate (default ema9/21, sma20, rsi14, macd(12,26,9), bb(20,2), atr14; selectable subset of 16 incl. mfi/obv/stoch/cci/kc/ppo/er/roc/sd/wma; indicators needing more history are skipped with reasons instead of erroring) so the small on-device orchestrator never shuttles raw candle arrays between calls. Wired like office: catalog entry + persona + `toolset_for` arms (pure-local works; `deep_write` rides along when remote is configured); interval strings are case-sensitive (`1m` minute vs `1M` month, validated server-side). Regression gate: `binance_smoke` example (keyless; runs in all three CI smoke jobs against `data-api.binance.vision` via `KAWAI_BINANCE_REST_BASE`, geo-blocked hosts skip instead of failing) + `cargo check --features binance` in the `linux-check` job + 6 unit tests on the TA engine. Phase 2 (read-only account tools, 2026-08-24): `binance_balances` / `binance_open_orders` — signed via user-supplied `BINANCE_API_KEY`/`BINANCE_API_SECRET` from `.env` (never compiled in, read-only keys only); tools register ONLY when both are set (capability probe), the Android target excludes the whole dep (binance-sdk's own reqwest carries default-tls → openssl-sys has no NDK prebuilds; macOS/iOS resolve natively). Phase 3 (order placement with human confirmation) deferred.
   - ✅ Data analysis agent (2026-08-24): third catalog entry `builtin.analytics` behind the `analytics` cargo feature (implies `office` — data files live in the office store; allowlist += `csv/tsv/parquet`, and tabular exts incl. xlsx/xlsm are never prose-indexed by RAG and get no rag_files badge). Four tools from `rig-components/analytics` (polars 0.55, minimal features): `data_schema` (columns/dtypes/samples/row count; xlsx echoes sheet names) + `data_query` (AST: AND-combined filters → group_by → sum/avg/min/max/count/count_distinct → sort → limit ≤100, or plain row selection; groupBy without aggregations = implicit row_count; dtype-aware literal coercion; errors echo the valid names so one repair round fixes them; output JSON capped at 30k chars via limit-halving re-collect). xlsx/xlsm convert once to a hidden typed-parquet sidecar beside the source (fingerprinted on mtime+size) through office_oxide — date-styled serials become Date/Datetime columns, all-integral numbers Int64, mixed degrade to text; every later scan is lazy-parquet. Named SQLite sources (`sql_profiles` table, migration `0006`; managed via the auth-required `sql_profile_list/save/delete` ops + the Knowledge-panel SQL section) feed the snapshot tools: `data_tables(profile)` lists tables, `data_import(profile, table)` snapshots up to 200k rows into the office store as csv and returns a fileId — the model states profile/table and waits for confirmation before importing. The model keeps its 2-hop flow (`data_schema` → `data_query`) over `doc1` handles; a `sheet` arg picks Excel worksheets (default first with data). Gate: `analytics_smoke` (offline csv+xlsx e2e) in all three CI smoke jobs + `cargo test -p analytics` (33 tests) in linux-check; orchestration quality gated by the `agent_eval` analytics suite (`EVAL_SUITE=analytics`, 8 scenarios, E4B, 7/8) in macos-smoke.
   - ✅ Turn-scoped tool memory + cloud close (2026-08-24, `PLAN-turn-scoped-tool-memory.md`): every completed process in a user turn (plain tool result, recall page) appends to `TurnMemory` — a turn-local process log in `logic/agent.rs` (plain local var in the `agent_chat` stream, dropped at stream end, never persisted; dedup on `(tool, resolved-args)`, per-entry 32k cap, `memN` handles). Oversized results (>4k chars) feed back as `[stored as memN — N chars total]` + a 2400-char excerpt + a recall pointer instead of the old lossy truncation; the full body pages back via the `artifact_recall(handle, offset)` tool (3600-char slices, loop-intercepted like the subagents — registered as a manifest stub in `toolset_for` for office+binance, counts toward and is bounded by `MAX_TOOL_CALLS`, errors teach valid handles). Cloud-subagent `materials` render from the log on demand (`memory.materials()`, same 32k cap — replaced the old `turn_tool_results` string, which is deleted). Cloud close: when the vault is configured, the per-turn subagent budget is untouched, and the log carries ≥6k chars (`CLOUD_CLOSE_MIN_CHARS`), the tool-result and budget-exhausted feedback prompts direct the model to deliver the final answer via `deep_write` — the cloud synthesizes from the full log while local only ever saw excerpts; prompt-forced (never post-hoc) because local answers stream live and there is no replace semantics; budget-exhausted variants append `chain_digest()` so a paged-out model still closes with the evidence list. Gates: `agent_eval` 20/20 on E4B, TurnMemory/recall/close-condition unit tests in `agent.rs`.
6. **Production auth = browser + deep link.** Flow: open system browser → sign-in (Clerk page or Kratos) → redirect `kawai://auth?token=<jwt>` → `set_session`. Needs the tauri deep-link plugin + a hosted page (or kawai-web route) to mint the redirect. The main `web/` SPA's Kratos `kawai://oidc-callback` flow is the proven reference (`web/src/platform/tauri.ts`); reusing Kratos would unify identity with the main platform.
7. **Desktop/mobile session persistence.** `State<Session>` is in-memory; lost on restart (with the dev bypass the frontend re-establishes it automatically — fine for MVP). Persist the token in the OS keychain (`tauri-plugin-stronghold` / keyring) and reload on launch.
8. **Desktop/mobile DB token broker.** For sqld sync: `logic::mint_db_token` reads the Ed25519 private key locally — fine for dev, but the private key MUST NOT ship in a production app. Add a `db_token` op: kawai-web verifies the identity → mints a short EdDSA token → the device fetches it and feeds `Builder::new_remote_replica`. The private key stays server-side. **(Post-MVP — requires sqld setup)**
9. **Production hardening.** Add `Secure` to the session cookie (HTTPS only), CORS only if cross-origin, rate limiting, token refresh rotation. Encrypt `kawai.db` at rest: `libsql` feature `encryption` (SQLCipher lineage, `Cipher::Aes256Cbc` via `Builder::encryption_config`) applied in `logic::db_connection`; DB key lives in the OS keychain (same `keyring` mechanism as item 7 — macOS/Windows/iOS/Android native, Linux Secret Service with 0600-file/read-only fallback ladder). Protects chat history + knowledge-base chunks at rest (theft without FileVault, leaked backups, misdirected cloud sync); NOT a place to store API keys — secrets stay in the keychain directly (see PLAN-nautilus-integration.md Stage 1 residuals).
10. **Connection pooling + token refresh.** DB connections are opened per-op (correct, not optimal). Pool them for production load.
11. **SQLite schema migrations.** ✅ Done 2026-08-21: hand-rolled `schema_migrations` table + versioned, transactional migration runner in `src-tauri/src/logic/db_migrations.rs` applied on every `db_connection` (with an in-memory `OnceLock<HashSet<PathBuf>>` guard keyed by per-user data dir so per-op connections skip the check). Migrations are `include_str!`-loaded `.sql` files in `src-tauri/migrations/`: `0001_baseline` (sessions/messages+index/turn_log), `0002_backfill_untitled_sessions` (the legacy empty-title backfill), `0003_office_tables` (session_files + rag_files, `#[cfg(feature="office")]`), `0004_session_archive` (archived + archived_at columns on sessions), `0005_remap_chat_agent` (builtin.chat → builtin.office), and `0006_sql_profiles` (named SQL data sources for the analytics agent). NOT refinery/rusqlite_migration (they assume rusqlite, we use the libsql API). The FTS5 mirror (`rag_chunks_fts` + triggers) stays created at runtime in `rag.rs::ensure_fts` because `CREATE TRIGGER` requires `rag_chunks` to already exist (rig-libsql creates it on first index); `rag_chunks`/embeddings tables are rig-libsql-owned and intentionally excluded. Add new schema via a new `<NNN>_name.sql` + a `Migration` entry in `migrations()`; cover it with a test in `db_migrations.rs`'s `tests` module (runs in the CI `cargo test --features litert,office --lib` gate).
12. **Tests beyond the smoke gate.** Unit tests for `auth.rs` (JWKS verify), `logic.rs` (token mint + db round-trip), agent tier (toolset assembly, agent catalog integrity).

### End state (desktop + mobile + web — design work, later)

13. **Mobile LLM builds.** Mobile Rust compiles are verified (android arm64 + iOS device/sim, 2026-08-15) but the LiteRT-LM C lib itself is not built for mobile yet (`cognee-litert-lm/build.rs` has the NDK path ready; needs `bazel build //c:litert-lm --config=android_arm64` + static-link trial). Mobile UI work rides on this (React frontend must grow the mobile platform adapter then).
14. **Windows/Linux desktop builds.** macOS-only for MVP; the other desktop targets are end state. No cross-compile from macOS — build each platform on its native GitHub Actions runner (`macos-14+` arm64 / `windows-latest` MSVC / `ubuntu-22.04` for glibc ≥ 2.35) with bazel caching (`actions/cache`, GB-scale) + `tauri-action` for bundling. Upstream bazel carries `linux` (clang) and partial Windows (MSVC) flags — never exercised by us; our sentencepiece patch is macOS-specific (may need sibling patches per OS). flutter_gemma proves the C lib works on Windows x86_64 (DX12/Dawn GPU) and Linux x86_64+arm64 (Vulkan/Dawn; glibc ≥ 2.34) via prebuilt binaries — consider prebuilts vs building from source per platform. Bundling differs per OS: macOS `@rpath`+codesign (current recipe), Windows DLL-exe-adjacent + vcredist (+ `dxil`/`dxcompiler` for GPU), Linux `.so` + `$ORIGIN` rpath. Windows is the highest-risk target (MSVC flags unexercised). **CI jobs added** (`build-linux`, `build-windows` in `.github/workflows/release.yml`) — both ship `--features litert` bundled via `tauri-action`. Linux uses `--config=linux_x86_64` (clang), Windows uses `--config=windows` (MSVC). Sentencepiece patch may need Linux/Windows siblings if `hdrs_check` fails on those platforms. Known: Windows `bazel-bin/c/litert-lm.dll` output name (not `liblitert-lm.dll`); the MSVC import library is emitted as `litert-lm.if.lib` (bazel's interface-library naming — copy it to `native/litert-lm.lib`, the name rustc `-llitert-lm` searches for), no `install_name_tool` equivalent, no `codesign`. The engine's companion libraries (`libGemmaModelConstraintProvider`, `libLiteRt`, WebGPU/dawn, …) are NOT outputs of `//c:litert-lm` — they load at runtime (dlopen/import chain) and come from `vendor/LiteRT-LM/prebuilt/<platform>/`; every CI job stages them into `native/` beside the main library and `.github/tauri-litert.json` bundles them.
15. **Web platform support.** Investigate running kawai from a browser. Three approaches: (A) the React frontend built for web + `@litert-lm/core` WASM for client-side inference, (B) Rust backend as inference proxy (server-side), (C) hybrid. flutter_gemma already proves `@litert-lm/core` works in-browser with WebGPU. Open questions: WebGPU availability, model download UX (GB-scale), browser memory limits, whether to duplicate effort or share with flutter_gemma. Needs design doc before implementation.
16. **`--enable-namespaces` on sqld** for hard per-user DB isolation (token `sub` → namespace) instead of shared-namespace + `WHERE user_id`.
17. **Gemma 4 GPU (Metal) — blocked upstream.** The `-gpu.litertlm` variants need backend `GPU_ARTISAN`, which maps to engine types (`kAdvancedLegacyTfLite`/`kLegacyTfLite`) that upstream deleted; only `kAdvancedLiteRTCompiledModel` registers now → `No available engine for GPU_ARTISAN`. The plain `.litertlm` is CPU-locked by its section backend-constraint (`engine_settings.cc:78` rejects mismatches). Revisit when upstream ships a GPU path for the compiled-model engine.
18. **LoRA support.** LoRA adapters enable on-device personalization (custom writing style, domain expertise, local language/slang). C API supports `set_lora_path` on SessionConfig and `set_lora_rank` on EngineSettings, but kawai uses the Conversation API which manages sessions internally — cannot inject SessionConfig. Options: (A) switch from Conversation API to Session API (big refactor, lose chat history/prompt templating), (B) wait for upstream to add LoRA to ConversationConfig, (C) hybrid approach. Fine-tuning on-device not yet supported by LiteRT-LM. Open questions: which use cases justify the refactor? How big is the Session API migration?
