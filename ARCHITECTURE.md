# Kawai Architecture

Multi-target app (web, desktop, mobile) with React frontend and Rust backend.
Each platform uses its **native transport**: Tauri IPC (desktop/mobile) and HTTP/SSE (web).

## Goals

- Web, desktop, mobile are equally important targets.
- Frontend: React + TypeScript (Vite), one build for all targets.
- Backend: Rust, single core logic.
- App logic is 100% shared; only transport and launcher differ per target.
- Auth: Clerk on the frontend; the backend verifies session JWTs via Clerk's **public JWKS** (no secret in the backend).
- LLM orchestration: `rig` (in `logic.rs`) — declared, not yet wired.
- Persistence: self-hosted `libsql-server` (sqld); per-user embedded replica (desktop/mobile) or remote client (web), driven from `logic.rs`.

## Layer diagram

```
┌───────────────────────────────────────────────────────────┐
│  REACT UI LAYER  —  1 build, runs on all 3 targets        │
│  components → api.call() / streamOperation()              │
├───────────────────────────────────────────────────────────┤
│  FRONTEND ABSTRACTION                                     │
│  transport.ts : detect window.__TAURI_INTERNALS__         │
│  api.ts       : request-response   (invoke | fetch)       │
│  stream.ts    : streaming          (Channel | SSE)        │
│  auth.ts      : Clerk session → backend (set_session)     │
├───────────────────────┬───────────────────────────────────┤
│  Desktop / Mobile     │  Web                              │
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
├── package.json              # Vite + React + TS + @tauri-apps/api
├── vite.config.ts
├── tsconfig.json
├── index.html                # Vite entry (root)
├── src/                      # Frontend (React)
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css             # @import "tailwindcss"; @plugin "daisyui";
│   ├── lib/
│   │   ├── transport.ts      # platform detection
│   │   ├── api.ts            # request-response
│   │   ├── stream.ts         # streaming abstraction
│   │   ├── auth.ts           # Clerk session → backend (set_session/logout/whoami)
│   │   └── capabilities.ts   # native features (future)
│   └── types/
│       └── events.ts
├── scripts/
│   └── dev-sqld.sh           # dev launcher for self-hosted sqld
├── .env                      # KAWAI_AUTH_* + KAWAI_DB_* (gitignored)
├── .env.local                # VITE_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY (gitignored)
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
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
4. **`web.rs`** — thin wrappers. Each core fn → one Axum route. `auth_middleware` reads the `kawai_session` cookie, verifies it, and injects `Extension<Claims>`. Static assets via `ServeDir("../dist")`.
5. **Launcher**:
   - Desktop/Mobile (`main.rs` → `lib.rs::run()`): Tauri builder, registers commands + `.manage(Verifier)` + `.manage(Session)`. **Does NOT run Axum.**
   - Web (`bin/web.rs`): binds `0.0.0.0:PORT`, serves `dist/` + API router. Not a Tauri app.
6. **Frontend abstraction** — components only call `call()` / `streamOperation()`, never branch on platform. Detection happens once in `transport.ts`; auth is pushed in by `auth.ts` + the sync effect in `App.tsx`.

## Conventions

| Concern | Convention |
|---------|------------|
| Naming | command `foo_bar` ↔ route `POST /api/foo_bar` ↔ frontend `call('foo_bar')` (Tauri uses the snake_case fn name verbatim; one string used for both invoke and URL path) |
| Errors | Rust `Result<T, String>` ↔ web HTTP 4xx/5xx + `{error}` ↔ frontend `throw Error` |
| Event tagging | `#[serde(tag = "type")]`; `finished`/`error` variants are terminal |
| Completion | encoded in event type, not in transport |
| Cancellation | Web: `AbortController` (connection drop → Axum response future dropped → stream dropped → pending `sleep` auto-cancelled). Desktop/Mobile: `cancel_stream` command signals a `CancellationToken` looked up by `streamId` in a shared registry, breaking the `select!` loop |
| Static assets | Tauri: `frontendDist = ../dist`; Web: Axum `ServeDir("../dist")` |

## Core dependencies (in `logic.rs` / `auth.rs`)

- **`rig`** — LLM orchestration (providers, agents, streaming). Use for any LLM call; token streams map onto the streaming event pattern. (Declared, not yet wired.)
- **`libsql`** — per-user DB against self-hosted sqld. Desktop/mobile: local embedded replica per user; web: remote connection (no per-user local file). Builder selection lives in `logic.rs` behind `cfg(feature = "web")`. Connections are per-op (fresh EdDSA token each call).
- **`jsonwebtoken`** — RS256 (Clerk JWKS verify in `auth.rs`) and EdDSA (sqld token mint in `logic.rs`). Two versions coexist (9.x direct + 10.x transitive) — expected.
- All compile clean across desktop, android arm64, and ios arm64 (libsql/rustls verified; jsonwebtoken/reqwest pending a mobile check — see Next dev). Two rustls versions (0.22 + 0.23) coexist — expected.

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
| Web | `cargo run --bin kawai-web --features web` | `bun run build` + run binary | server binary |
| Desktop | `bun tauri dev` | `bun tauri build` | .app/.exe/.deb |
| Android | `cargo ndk -t arm64-v8a -P 24 check` | `bun tauri android build` | APK/AAB |
| iOS | `cargo check --target aarch64-apple-ios` | `bun tauri ios build` | IPA |

## Data flow

**RPC:** `React → api.call('greet', {name})` → desktop: `invoke` → `commands::greet` → `logic::greet` | web: `POST /api/greet` → `web::greet_handler` → `logic::greet`

**Streaming:** `React → streamOperation('generate_activity', {events, intervalMs}, handlers)` → desktop: `Channel` → `commands::generate_activity` → `logic::generate_activity()` stream | web: `fetch` → `Sse` → `web::generate_activity_handler` → `logic::generate_activity()` stream

## Authentication

Identity is established by Clerk and verified by the backend; it never lives in `logic.rs` — it arrives as a `user_id` parameter.

```
React (@clerk/react)  ──getSession JWT──▶  set_session  ──▶  auth::Verifier (public JWKS) ──▶ user_id
   │                                                                                  │
   └─ pushed every ~50s (tokens expire ~60s)                                          ▼
                                                              wrappers pass user_id as first arg to logic.rs
Web: HttpOnly `kawai_session` cookie (browser auto-attaches, incl. SSE).
Desktop/mobile: Tauri `State<Session>` (in-memory).
```

- **Frontend**: `<ClerkProvider>` (main.tsx); `useAuth()` drives UI; `App.tsx` syncs the JWT into the backend.
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
       web: Builder::new_remote(url, token) ───────────────────────┼──▶ sqld (--auth-jwt-key-file <pub>)
       desktop/mobile: Builder::new_remote_replica(path, url, token) ─▶ local file syncs to sqld
```

- sqld holds the Ed25519 **public** key; the backend holds the **private** key (mismatched halves = auth fails). Start: `./scripts/dev-sqld.sh`.
- Builder selection is `cfg`-gated in `logic.rs`, not branched on a transport type → stays pure.
- Multi-tenancy today: single (default) namespace + `WHERE user_id = ?`. Production option: `--enable-namespaces` (token `sub` → isolated per-user DB).
- Connections are per-op (fresh token each call) — simple and correct; pool/refresh before production.

## Next dev / follow-ups

1. **Desktop/mobile session persistence** — `State<Session>` is in-memory; persist the token to the OS keychain (`tauri-plugin-stronghold` / keyring) and reload on launch.
2. **Desktop/mobile DB token broker** — `mint_db_token` reads the Ed25519 private key locally. In production the private key must NOT ship in the app: add a `db_token` op (kawai-web verifies Clerk → mints a short EdDSA token → device fetches it → feeds `open_with_remote_replica`).
3. **Connection pooling + token refresh** — per-op connections are correct but not optimal; pool and refresh before expiry.
4. **`--enable-namespaces` on sqld** — hard per-user DB isolation instead of shared-namespace + `WHERE user_id`.
5. **Mobile compile verification** — `jsonwebtoken` (ring) + `reqwest` (rustls) + `libsql` not yet checked on android arm64 / ios arm64 this session.
6. **Production hardening** — `Secure` cookie flag (HTTPS), CORS if cross-origin, rate limiting, Clerk refresh-token rotation.
7. **`rig` (LLM) wiring** — declared but unused; wire the first LLM op.
8. **Tests** — no suite yet; add unit tests for `auth.rs` (JWKS verify) and `logic.rs` (token mint + db round-trip).
