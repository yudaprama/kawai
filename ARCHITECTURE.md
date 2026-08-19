# Kawai Architecture

Desktop/mobile app (Tauri) with a React frontend and Rust backend.
The backend also ships as a standalone web server binary (Axum, feature-gated).

## Goals

- Product: **an AI agents app** — a catalog of specialized agents (finance, knowledge, weather, …); each agent = LLM persona + curated toolset from `rig-components/` (per-category crates of generated rig tools, `registry::toolset_for(names)`). UI: three-pane — left = agent list, center = active agent content, right = sessions of the selected agent (MVP ships the center pane + session sidebar; the full three-pane arrives with the agent tier).
- End state: **desktop + mobile + web from one core**; app logic is 100% shared, only transport and launcher differ per target.
- Current phase: **MVP, desktop-first** (macOS, on-device LLM, dev-bypass auth). Scope and priorities live in `AGENTS.md` → "Current phase" + "Roadmap"; the phase defers work, never architecture — the invariants in AGENTS.md are what keeps mobile/web cheap later.
- Frontend: React 19 + TypeScript + Vite + Tailwind v4, in `frontend/` (built to `dist/`, Tauri `frontendDist: "../dist"`). Chat components vendored from the main `web/` SPA. **No AI SDK** — stream events are mapped to UIMessage-part shapes by hand (`hooks/use-local-chat.ts` + `lib/ai-types.ts`).
- Backend: Rust, single core logic.
- Auth: MVP = dev-bypass (`set_session` with any token, backend-gated by `KAWAI_AUTH_DEV_USER_ID`). Backend retains Clerk JWKS verification (`auth.rs`, public keys only) for the future prod flow (browser + deep link, Roadmap 6).
- LLM: **on-device Gemma 4 via LiteRT-LM is THE model** (decision 2026-08-16). `rig` is on crates.io `0.42` (declared + used for the cloudflare title provider and the vector-store seam) but remote providers are optional configuration later. Agent tier will use prompt-based tool calling on the local model; `rig-components/` (14 category crates of generated rig tools, `registry::toolset_for(names)`) provides the toolsets, usable standalone without a rig provider.
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
│  self-hosted sqld (EdDSA JWT auth; backend mints tokens)  │
└───────────────────────────────────────────────────────────┘
```

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
├── src/                      # RETIRED vanilla frontend (reference only — do not edit)
├── rig-components/           # per-category rig tool crates (agent-tier tool library)
├── scripts/
│   └── dev-sqld.sh           # dev launcher for self-hosted sqld
├── .env                      # KAWAI_AUTH_* + KAWAI_DB_* (gitignored)
├── .env.local                # VITE_CLERK_PUBLISHABLE_KEY (gitignored; reference only)
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json       # devUrl :1420, frontendDist ../dist, beforeBuildCommand "bun run build"
    └── src/
        ├── main.rs           # desktop binary entry
        ├── lib.rs            # Tauri builder + module decls
        ├── logic.rs          # PURE LOGIC (no Tauri/Axum deps); rig + libsql + db token
        ├── auth.rs           # PURE AUTH; Clerk JWKS verify + EdDSA mint + Session
        ├── commands.rs       # #[tauri::command] wrappers
        ├── web.rs            # Axum router + auth_middleware + static serving
        └── bin/
            └── web.rs        # standalone web server entry
```

## Layers

1. **`logic.rs`** — the only place for business logic. Pure async fns, no Tauri/Axum imports. Returns `T` (RPC) or `impl Stream<Item = Event>` (streaming). Events tagged `#[serde(tag = "type")]`. Home of `rig` (LLM), `libsql` (per-user DB), and `mint_db_token` (EdDSA token sqld accepts).
2. **`auth.rs`** — pure auth. `Verifier` validates Clerk session JWTs against the public JWKS (cached by `kid`); `Session` holds the in-process identity for desktop/mobile; `mint` helpers live in `logic.rs`. No transport imports.
3. **`commands.rs`** — thin wrappers. Each core fn → one `#[tauri::command]`. Streaming commands take a `Channel<E>` plus the business args. Auth-required commands read `State<Session>` and pass `claims.sub` as `user_id`.
4. **`web.rs`** — thin wrappers. Each core fn → one Axum route. `auth_middleware` reads the `kawai_session` cookie, verifies it, and injects `Extension<Claims>`. No frontend static serving (Tauri desktop handles frontend).
5. **Launcher**:
   - Desktop/Mobile (`main.rs` → `lib.rs::run()`): Tauri builder, registers commands + `.manage(Verifier)` + `.manage(Session)`. **Does NOT run Axum.**
   - Web (`bin/web.rs`): binds `0.0.0.0:PORT`, serves `/api/*` router. Not a Tauri app.
6. **Frontend** — React SPA (`frontend/`), bundled by Vite into `dist/` and served by Tauri. RPC via `@tauri-apps/api/core.invoke`; streaming via `Channel` + `cancel_stream`. Chat state lives in `hooks/use-local-chat.ts`, which folds backend stream events (`token`/`toolCall`/`toolResult`/terminals) into `UIMessage[]` parts; `lib/ai-types.ts` defines those shapes locally (no `ai` npm package — field names stay AI-SDK-v5-compatible so the vendored `ai-elements` components render them unmodified).

## Frontend conventions

| Concern | Convention |
|---------|------------|
| Naming | command `foo_bar` ↔ route `POST /api/foo_bar` ↔ frontend `call('foo_bar')` (Tauri uses the snake_case fn name verbatim; one string used for both invoke and URL path) |
| Errors | Rust `Result<T, String>` ↔ web HTTP 4xx/5xx + `{error}` ↔ frontend `throw Error` (invoke rejects with a bare string — use `errText()`) |
| Event tagging | `#[serde(tag = "type")]`; `finished`/`error` variants are terminal; frontend mirrors the union in `use-local-chat.ts` |
| Cancellation | Desktop/Mobile: `cancel_stream` command signals a `CancellationToken` looked up by `streamId` in a shared registry, breaking the `select!` loop. Web backend: client `AbortController` drops the connection → Axum response future dropped → stream dropped. |
| Message shape | `UIMessage`/parts from `@/lib/ai-types` (local shim) — never import `ai`/`@ai-sdk/*` |
| Styling | Tailwind v4 tokens in `frontend/src/index.css` (dark-first); `cn()` from `@/lib/utils` |
| Components | Reuse `ai-elements/` → `ui/` first; add built-ins via `bunx shadcn@latest add` only when nothing fits |
| Vendored sync | Updates from `web/` require the standing trims: `ai`→shim, strip i18n, slim `@/platform`, no Lexical/`@xyflow`/`tokenlens` |

## Core dependencies (in `logic.rs` / `auth.rs`)

- **`rig`** — on crates.io `0.42` (same semver source as `rig-libsql` and `rig-components`; the `Vec<Embedding>` `insert_documents` change rig-libsql needs is in this release). Used for the cloudflare session-title provider and the libsql vector-store seam. Local Gemma 4 via LiteRT-LM is the model (decision 2026-08-16); remote providers via rig become optional configuration later, not a requirement.
- **`libsql`** — per-user DB against self-hosted sqld. Desktop/mobile: local embedded replica per user; web: remote connection (no per-user local file). Builder selection lives in `logic.rs` behind `cfg(feature = "web")`. Connections are per-op (fresh EdDSA token each call).
- **`jsonwebtoken`** — RS256 (Clerk JWKS verify in `auth.rs`) and EdDSA (sqld token mint in `logic.rs`). Two versions coexist (9.x direct + 10.x transitive) — expected.
- All compile clean across desktop, android arm64, and ios arm64 (verified 2026-08-15; default/web/litert feature combos). Two rustls versions (0.22 + 0.23) coexist — expected.
- **Frontend**: `@types/hast` pinned to 3.0.4 via `resolutions` (3.0.5 breaks the vendored streamdown — see AGENTS.md Landmines).

## Web dependency gating (Axum excluded from desktop/mobile)

Axum/tower-http are **optional** deps behind a `web` Cargo feature. The `web` module is `#[cfg(feature = "web")]`, and the `kawai-web` binary has `required-features = ["web"]`.

| Build | Feature `web` | Axum compiled? |
|-------|:---:|:---:|
| `cargo tauri build` (desktop/mobile) | off | no |
| `cargo tauri android/ios build` | off | no |
| `cargo build --bin kawai-web --features web` | on | yes |

## Build matrix

Package manager is **bun**. Mobile needs extra toolchain: Android requires `ANDROID_NDK_HOME`/`ANDROID_NDK_ROOT` exported + `cargo-ndk` (use `-P`, not `-p`); iOS requires full Xcode + `xcode-select -s`.

| Target | Dev | Build | Output |
|--------|-----|-------|--------|
| Frontend | `bun run dev` (vite :1420) | `bun run build` | `dist/` |
| Desktop | `bun tauri dev` | `bun tauri build` | .app/.exe/.deb |
| Android | `cargo ndk -t arm64-v8a -P 24 check` | `bun tauri android build` | APK/AAB |
| iOS | `cargo check --target aarch64-apple-ios` | `bun tauri ios build` | IPA |
| Web server | `cargo run --bin kawai-web --features web` | (same) | server binary |

`bun tauri dev`/`build` auto-runs the frontend via `beforeDevCommand`/`beforeBuildCommand` ("bun run dev"/"bun run build"); `bun install` first on a fresh clone.

## Data flow

**RPC:** `App.tsx → call('list_chat_sessions')` → `invoke` → `commands::list_chat_sessions` → `logic::…`

**Streaming:** `use-local-chat.ts → streamOperation('local_chat', {prompt}, handlers)` → `Channel` → `commands::local_chat` → `logic::local_llm::local_chat` stream → events folded into the live assistant `UIMessage` parts (`token` → text part, `toolCall`/`toolResult` → tool parts with state transitions).

## Authentication

Identity is established at the edge and verified by the backend; it never lives in `logic.rs` — it arrives as a `user_id` parameter.

```
React (use-local-chat bootstrap) ──whoami?──▶ ┐ found → user_id
                                              └ missing → set_session(<any token>)
                                                  │ succeeds ONLY with the dev bypass
                                                  ▼
                                     auth::Verifier (public JWKS) → user_id
                                     (wrappers pass user_id as first arg to logic.rs)
Desktop/mobile: Tauri `State<Session>` (in-memory).
Web backend (no web frontend): HttpOnly `kawai_session` cookie.
```

- **MVP**: dev bypass (`KAWAI_AUTH_DEV_USER_ID`) — any token verifies as that user. No auth UI in the React app.
- **Backend verify**: `auth::Verifier` fetches Clerk's public JWKS, caches by `kid`, checks `iss`/`exp`. **No `CLERK_SECRET_KEY` is used by the backend.**
- **Edge resolution**: `commands.rs` reads `State<Session>`; `web.rs` reads `Extension<Claims>` (injected by `auth_middleware`). Both extract `claims.sub` → `user_id`.
- **Auth ops**: `set_session`, `logout`, `whoami`. `greet`/`generate_activity` are public; everything else requires auth.
- **Prod auth (post-MVP)**: browser + deep link (`kawai://auth?token=…` → `set_session`); the main `web/` SPA's Kratos deep-link flow is the proven pattern.

## Persistence (local SQLite)

Desktop MVP: local SQLite file, no sync. Post-MVP: sqld for multi-device sync.

```
user → (dev bypass / future prod auth) → Rust backend → user_id
                                                        │
   per-user data directory ◀───────────────────────────┘
   <data_root>/<user_id>/          ← one folder per user (backup unit)
   ├── kawai.db                    ← Builder::new_local(path)
   └── docs/                       ← office store (files + .meta.json)
```

- `logic::db_connection(user_id)` opens a per-op local SQLite connection; the office store defaults into the same per-user dir (`logic::db::user_data_dir`).
- Data root resolution: `KAWAI_DATA_DIR` env → legacy `KAWAI_DB_DIR` env → injected root (`set_data_root`; Tauri injects the app-data dir) → `/tmp/kawai`. `KAWAI_DOCS_DIR` still overrides the docs root (legacy `<root>/<user_id>/` layout).
- **One data directory per user — no `user_id` columns, no `WHERE user_id`.** Isolation is structural (per-user folder), matching the future sqld-namespace model.
- Schema: `sessions(agent_id, title)`, `messages(session_id, role, content)`, `session_files(session_id, file_id)` (which documents a session can search — scopes `knowledge_search`), `rag_chunks` + FTS5 mirror (knowledge index owned by files), `rag_files(file_id, status, chunks, error)` (index lifecycle for the knowledge panel).
