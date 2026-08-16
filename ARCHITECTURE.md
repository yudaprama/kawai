# Kawai Architecture

Desktop/mobile app (Tauri) with vanilla frontend and Rust backend.
The backend also ships as a standalone web server binary (Axum, feature-gated).

## Goals

- Product: **an AI agents app** — a catalog of specialized agents (finance, knowledge, weather, …); each agent = LLM persona + curated toolset from `rig-tools/` (per-category crates of generated rig tools, `registry::toolset_for(names)`). UI: three-pane — left = agent list, center = active agent content, right = sessions of the selected agent.
- End state: **desktop + mobile + web from one core**; app logic is 100% shared, only transport and launcher differ per target.
- Current phase: **MVP, desktop-first** (macOS, on-device LLM, dev-bypass auth). Scope and priorities live in `AGENTS.md` → "Current phase" + "Roadmap"; the phase defers work, never architecture — the invariants in AGENTS.md are what keeps mobile/web cheap later.
- Frontend: Vanilla JS. No bundler, no framework. Served directly by Tauri (`frontendDist: "../src"`).
- Backend: Rust, single core logic.
- App logic is 100% shared; only transport and launcher differ per target.
- Auth: Clerk via CDN + vanilla JS SDK; the backend verifies session JWTs via Clerk's **public JWKS** (no secret in the backend).
- LLM: **on-device Gemma 4 via LiteRT-LM is THE model** (decision 2026-08-16). `rig` 0.41 stays declared but unwired — remote providers become optional configuration later. Agent tier will use prompt-based tool calling on the local model; `rig-tools/` (14 category crates of generated rig tools, `registry::toolset_for(names)`) provides the toolsets, usable standalone without a rig provider.
- Persistence: self-hosted `libsql-server` (sqld); per-user embedded replica (desktop/mobile) or remote client (web backend), driven from `logic.rs`.

## Layer diagram

```
┌───────────────────────────────────────────────────────────┐
│  VANILLA JS  —  no build, served as-is by Tauri           │
│  main.js → lib/api.call() / lib/stream.streamOperation()  │
├───────────────────────────────────────────────────────────┤
│  FRONTEND ABSTRACTION (Tauri-only, no platform branching) │
│  window.__TAURI__.core.invoke  (RPC)                       │
│  window.__TAURI__.core.Channel (streaming)                 │
│  auth.js      : Clerk session → backend (set_session)      │
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
│  auth.rs  : Clerk JWKS verify  +  EdDSA token mint        │
├───────────────────────────────────────────────────────────┤
│  self-hosted sqld (EdDSA JWT auth; backend mints tokens)  │
└───────────────────────────────────────────────────────────┘
```

## Directory layout

```
kawai/
├── package.json              # @tauri-apps/cli only (no bundler)
├── src/                      # Frontend (vanilla JS, served as-is)
│   ├── index.html            # Entry point — Clerk CDN + main.js
│   ├── main.js               # App logic (auth, greet, stream, notes)
│   ├── styles.css            # Vanilla CSS
│   ├── config.js             # Clerk publishable key
│   └── lib/
│       ├── api.js            # RPC: window.__TAURI__.core.invoke
│       ├── stream.js         # Streaming: Channel + cancel_stream
│       └── auth.js           # Clerk session → backend (set_session/logout/whoami)
├── rig-tools/                # per-category rig tool crates (agent-tier tool library)
├── scripts/
│   └── dev-sqld.sh           # dev launcher for self-hosted sqld
├── .env                      # KAWAI_AUTH_* + KAWAI_DB_* (gitignored)
├── .env.local                # VITE_CLERK_PUBLISHABLE_KEY (gitignored; reference only)
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json       # withGlobalTauri: true, frontendDist: ../src
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
6. **Frontend** — vanilla JS, loaded from `src/` directly by Tauri (no build step). Uses `window.__TAURI__` for all backend calls. Clerk loaded via CDN script in `index.html`.

## Conventions

| Concern | Convention |
|---------|------------|
| Naming | command `foo_bar` ↔ route `POST /api/foo_bar` ↔ frontend `call('foo_bar')` (Tauri uses the snake_case fn name verbatim; one string used for both invoke and URL path) |
| Errors | Rust `Result<T, String>` ↔ web HTTP 4xx/5xx + `{error}` ↔ frontend `throw Error` |
| Event tagging | `#[serde(tag = "type")]`; `finished`/`error` variants are terminal |
| Completion | encoded in event type, not in transport |
| Cancellation | Desktop/Mobile: `cancel_stream` command signals a `CancellationToken` looked up by `streamId` in a shared registry, breaking the `select!` loop. Web backend: client `AbortController` drops the connection → Axum response future dropped → stream dropped. |
| Static assets | Tauri: `frontendDist = "../src"` (served as-is, no build); Web backend: no frontend serving |
| Frontend IPC | `window.__TAURI__.core.invoke` / `window.__TAURI__.core.Channel` (`withGlobalTauri: true`) |

## Core dependencies (in `logic.rs` / `auth.rs`)

- **`rig`** — declared, unwired, pinned to git rev `4232abdb` (same source as `rig-libsql` and `rig-tools`; crates.io 0.41.0 predates the `Vec<Embedding>` change). Local Gemma 4 via LiteRT-LM is the model (decision 2026-08-16); remote providers via rig become optional configuration later, not a requirement.
- **`libsql`** — per-user DB against self-hosted sqld. Desktop/mobile: local embedded replica per user; web: remote connection (no per-user local file). Builder selection lives in `logic.rs` behind `cfg(feature = "web")`. Connections are per-op (fresh EdDSA token each call).
- **`jsonwebtoken`** — RS256 (Clerk JWKS verify in `auth.rs`) and EdDSA (sqld token mint in `logic.rs`). Two versions coexist (9.x direct + 10.x transitive) — expected.
- All compile clean across desktop, android arm64, and ios arm64 (verified 2026-08-15; default/web/litert feature combos). Two rustls versions (0.22 + 0.23) coexist — expected.

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
| Desktop | `bun tauri dev` | `bun tauri build` | .app/.exe/.deb |
| Android | `cargo ndk -t arm64-v8a -P 24 check` | `bun tauri android build` | APK/AAB |
| iOS | `cargo check --target aarch64-apple-ios` | `bun tauri ios build` | IPA |
| Web server | `cargo run --bin kawai-web --features web` | (same) | server binary |

Note: No web frontend build step — Tauri serves `src/` directly without a bundler.

## Data flow

**RPC:** `main.js → call('greet', {name})` → `invoke` → `commands::greet` → `logic::greet`

**Streaming:** `main.js → streamOperation('generate_activity', {events, intervalMs}, handlers)` → `Channel` → `commands::generate_activity` → `logic::generate_activity()` stream

## Authentication

Identity is established by Clerk and verified by the backend; it never lives in `logic.rs` — it arrives as a `user_id` parameter.

```
Vanilla JS (Clerk CDN)  ──getSession JWT──▶  set_session  ──▶  auth::Verifier (public JWKS) ──▶ user_id
    │                                                                                    │
    └─ pushed every ~50s (tokens expire ~60s)                                            ▼
                                                                 wrappers pass user_id as first arg to logic.rs
Desktop/mobile: Tauri `State<Session>` (in-memory).
Web backend (no web frontend): HttpOnly `kawai_session` cookie.
```

- **Frontend**: Clerk loaded via script tag in `index.html`; `main.js` creates `new Clerk(pk)` and manages auth lifecycle.
- **Backend verify**: `auth::Verifier` fetches Clerk's public JWKS, caches by `kid`, checks `iss`/`exp`. **No `CLERK_SECRET_KEY` is used by the backend.**
- **Edge resolution**: `commands.rs` reads `State<Session>`; `web.rs` reads `Extension<Claims>` (injected by `auth_middleware`). Both extract `claims.sub` → `user_id`.
- **Auth ops**: `set_session`, `logout`, `whoami`. `greet`/`generate_activity` are public; everything else requires auth.
- **Dev bypass**: `KAWAI_AUTH_DEV_USER_ID` makes `Verifier::verify` return that user for any token (offline/dev only).

## Persistence (self-hosted sqld)

sqld validates client JWTs with **EdDSA against an Ed25519 public key** — it does NOT support JWKS or RS256. So Clerk's RS256 session JWTs cannot be presented to sqld directly; the backend verifies Clerk and **mints** the EdDSA token sqld accepts.

```
user → (Clerk) → Rust backend ──verify JWKS──▶ user_id
                              └──mint_db_token(user_id)──▶ EdDSA JWT (backend's Ed25519 key)
                                                                   │
       web: Builder::new_remote(url, token) ──────────────────────┼──▶ sqld (--auth-jwt-key-file <pub>)
       desktop/mobile: Builder::new_remote_replica(path, url, token) ─▶ local file syncs to sqld
```

- sqld holds the Ed25519 **public** key; the backend holds the **private** key (mismatched halves = auth fails). Start: `./scripts/dev-sqld.sh`.
- Builder selection is `cfg`-gated in `logic.rs`, not branched on a transport type → stays pure.
- Multi-tenancy today: single (default) namespace + `WHERE user_id = ?`. Production option: `--enable-namespaces` (token `sub` → isolated per-user DB).
- Connections are per-op (fresh token each call) — simple and correct; pool/refresh before production.
