# AGENTS.md — agent guide for kawai

Read this before touching the code. Full design lives in `ARCHITECTURE.md`.
This file is the operational rulebook.

## What this project is

Multi-target app: **web, desktop, mobile** — all equally important.

- **Frontend**: React + TypeScript (Vite). Single build for all targets.
- **Auth**: Clerk (`@clerk/react`) on the frontend; backend verifies session JWTs against Clerk's **public JWKS** (`auth.rs`) — no Clerk secret in the backend.
- **Backend**: Rust. Single core logic, two thin transport wrappers.
- **Transport**: native per platform — Tauri `Channel`+`invoke` (desktop/mobile), HTTP `fetch`+SSE (web).
- **LLM**: `rig` (in `logic.rs`) — declared, not yet wired.
- **DB**: self-hosted `libsql-server` (sqld). Backend mints short **EdDSA** tokens that sqld validates; web = remote client, desktop/mobile = embedded replica.

## Non-negotiable invariants

1. **`logic.rs` is pure.** Never import `tauri`, `axum`, or any transport type there. It owns business logic and returns `T` or `impl Stream<Item = Event>`.
2. **Two thin wrappers per operation.** One `#[tauri::command]` in `commands.rs`, one Axum route in `web.rs`. Both call the same `logic.rs` fn. No business logic in wrappers.
3. **One operation = one snake_case string**, used identically for: the Rust fn name, the invoke name, and the URL path (`POST /api/<name>`). Tauri uses the fn name **verbatim** (no kebab/camel conversion). Arguments are camelCase on the JS side, mapping to snake_case Rust params.
4. **Frontend never branches on platform** inside components. Use `src/lib/api.ts` (`call`) and `src/lib/stream.ts` (`streamOperation`). Platform detection lives only in `src/lib/transport.ts` and uses `window.__TAURI_INTERNALS__` — **not** `window.__TAURI__` (we run with `withGlobalTauri: false`).
5. **Web deps stay gated.** `axum`/`tower-http` are `optional`, behind the `web` Cargo feature. The `web` module is `#[cfg(feature = "web")]`. The `kawai-web` binary has `required-features = ["web"]`. Never make axum a non-optional dep — it must stay out of desktop/mobile binaries.
6. **Events.** `#[serde(tag = "type")]` in `logic.rs`; keep `src/types/events.ts` in sync. Terminal variants are `finished` / `error`.
7. **Identity is resolved at the transport edge, not in `logic.rs`.** Wrappers verify the token and pass `user_id` (`claims.sub`) into `logic.rs` fns as the first param. The frontend NEVER sends `user_id`. `auth.rs` is pure (no tauri/axum): it does JWKS verification (Clerk) and EdDSA minting (sqld).
8. **sqld is EdDSA-only.** `libsql-server` validates client JWTs with Ed25519 (EdDSA) — NOT JWKS, NOT RS256. So Clerk's RS256 session JWTs CANNOT go to sqld. The backend verifies Clerk (JWKS) and MINTS the EdDSA token (`logic::mint_db_token`) sqld accepts. Never wire sqld to Clerk directly.
9. **DB builder selection is `cfg`-gated in `logic.rs`, not branched on a transport type.** `#[cfg(feature = "web")]` → remote client; `#[cfg(not(feature = "web"))]` → embedded replica. Keeps `logic.rs` pure.

## Commands

Package manager is **bun** (not npm/yarn).

```sh
# Frontend
bun run dev            # vite dev server on port 1420
bun run build          # tsc typecheck + vite build → dist/

# Desktop (Tauri)
bun tauri dev
bun tauri build

# Web standalone server (Axum serves dist/ + /api/*)
cargo run --bin kawai-web --features web

# Self-hosted libsql-server (sqld) — the DB sync target
./scripts/dev-sqld.sh                       # sqld on 127.0.0.1:8080, Ed25519 JWT auth (auto-generates keys)
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
bun run build                  # frontend: tsc + vite
cargo check                    # desktop — axum must NOT compile here
cargo check --features web     # web module + kawai-web bin
```

For mobile changes, also: `cargo ndk -t arm64-v8a -P 24 check` and/or `cargo check --target aarch64-apple-ios`.

## Landmines (things that already bit us)

- **`async_stream` streams are not `Unpin`.** `Box::pin(...)` before calling `.next()` in a loop.
- **`Channel::send` takes the value by value**, not `&event` (Tauri 2: `send(data: T)`).
- **`-p` in cargo-ndk collides with cargo `--package`.** Use `-P` / `--platform`. cargo-ndk's panic handler **dumps all env vars to stdout** — never let it panic, and keep secrets out of shell env.
- **Two rustls versions coexist** (libsql 0.22 + rig 0.23). Expected, not a bug; binary is slightly larger.
- **`libsql-sys` / `aws-lc-sys` are C.** Mobile needs NDK clang (Android) or Xcode clang (iOS) plus libclang for bindgen. Verified working on android arm64 + ios arm64.
- **Don't re-add Tailwind/DaisyUI from CDN.** Wired via the Vite plugin (`@tailwindcss/vite` + `@plugin "daisyui"` in `src/index.css`).
- **Cancellation is asymmetric by design.** Web: `AbortController` (connection drop auto-cancels the backend future). Desktop/mobile: frontend `cancel()` calls `invoke('cancel_stream', {streamId})` → `CancellationToken` in the shared registry breaks the `select!` loop. Streaming commands must accept a `stream_id` param and register/clean up a token.
- **Axum 0.8 `from_fn` hardcodes state to `()`.** A middleware that needs shared state can't use `from_fn` + `State<S>`; use `Extension` (our `auth_middleware` reads `Extension<Verifier>`) or `from_fn_with_state`. Don't fight the type inference by annotating `Router<S>` — switch to `Extension`.
- **`libsql` positional tuple params start at arity 2.** `(&str,)` is NOT `IntoParams`; use `vec![x]` (or an array) for a single param. Tuples `(A,B)` and up are fine. Params blanket-impl `T: TryInto<Value>` (so `&str`, `String`, `i64`, … all work).
- **Clerk JWTs are RS256; sqld accepts only EdDSA.** Never pass a Clerk session JWT to sqld — mint an EdDSA token in the backend first (invariant 8).
- **`dotenvy` does not override existing env vars.** Shell-exported vars win over `.env`. To force dev-bypass auth, `KAWAI_AUTH_DEV_USER_ID=demo cargo run ...`.
- **Two `jsonwebtoken` versions coexist** (9.x is our direct dep in `auth.rs`/`logic.rs`; 10.x is transitive). Expected.

## Where things live

```
src/lib/transport.ts            # platform detection (window.__TAURI_INTERNALS__)
src/lib/api.ts                  # request-response (invoke | fetch)
src/lib/stream.ts               # streaming (Channel | SSE), generates streamId, cancel()
src/lib/auth.ts                 # setSession/logout/whoami thin wrappers over call()
src/types/events.ts             # TS mirror of logic.rs event enums — keep in sync
src/App.tsx                     # demo: greet + generate_activity + notes (auth-scoped)
src-tauri/src/logic.rs          # PURE logic; rig + libsql + db token minting
src-tauri/src/auth.rs           # PURE auth; Clerk JWKS verify + EdDSA mint + Session
src-tauri/src/commands.rs       # #[tauri::command] wrappers + Channel + cancel registry
src-tauri/src/web.rs            # Axum routes (feature-gated "web") + auth_middleware
src-tauri/src/bin/web.rs        # standalone web server entry
src-tauri/src/lib.rs            # Tauri builder; .manage(...); generate_handler!
src-tauri/Cargo.toml            # axum/tower-http optional behind feature "web"
.env                            # KAWAI_AUTH_* + KAWAI_DB_* (gitignored; dotenvy at startup)
.env.local                      # VITE_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY (gitignored)
scripts/dev-sqld.sh             # dev launcher for self-hosted sqld
```

## Adding a new operation (checklist)

1. Write the pure fn (+ any event enum) in `logic.rs`. Events: `#[serde(tag = "type")]`.
2. Mirror any new event types in `src/types/events.ts`.
3. Add the `#[tauri::command]` in `commands.rs`:
   - RPC: return `Result<T, String>`.
   - Streaming: take `stream_id: String` + `on_event: Channel<E>` + `State<StreamRegistry>`; loop with `tokio::select!` racing `token.cancelled()` vs `stream.next()`; register/remove token by `stream_id`.
   - If it requires auth: take `State<Session>`, read claims, pass `claims.sub` to the `logic.rs` fn as `user_id`. The frontend never passes `user_id`.
4. Add the Axum route in `web.rs`: RPC → `Json<T>`; streaming → `Sse<impl Stream<Item = Result<Event, _>>>`. Register it in `router()`.
   - If it requires auth: mount it on the `protected` router (behind `auth_middleware`) and take `Extension<auth::Claims>`; pass `claims.sub` to the same `logic.rs` fn. Public ops stay on `public`.
5. Register the command in `lib.rs` `generate_handler!`.
6. Call from React: `call('<name>', args)` or `streamOperation('<name>', args, handlers)`.
7. Verify: `bun run build`, `cargo check`, `cargo check --features web`.

## Authentication

- Frontend: `@clerk/react` `<ClerkProvider>` wraps the app (`main.tsx`). `useAuth()` is the source of truth for UI auth state; `App.tsx` pushes the Clerk session JWT into the backend every ~50s (tokens expire in ~60s).
- `set_session` (`src/lib/auth.ts`) hands the JWT to the backend once:
  - Web: backend sets an HttpOnly `kawai_session` cookie; the browser auto-attaches it to every `/api/*` incl. SSE. No token in JS.
  - Desktop/mobile: backend stores the verified identity in Tauri `State<Session>` (in-memory).
- Backend verification: `auth::Verifier` fetches Clerk's **public** JWKS (cached by `kid`) and checks `iss`/`exp`. **No `CLERK_SECRET_KEY` is needed or used by the backend** — asymmetric verification.
- Identity → logic: wrappers extract `claims.sub` as `user_id` and pass it as the first arg to `logic.rs` fns. `whoami`/`create_note`/`list_notes`/`stream_notes` are auth-required; `greet`/`generate_activity` are public.
- Auth operations: `set_session`, `logout`, `whoami` (one snake_case string each, same on both transports).

## Database (self-hosted libsql-server / sqld)

Topology — **do NOT couple sqld to Clerk** (invariant 8):

```
user → (Clerk) → Rust backend → logic::mint_db_token(user_id)   [EdDSA, backend's key]
                                       │
   desktop/mobile replica ◀───────────┴── sqld validates EdDSA against its Ed25519 PUB key
   web remote client ──────┘             (sqld NEVER sees the Clerk JWT)
```

- Start sqld with `./scripts/dev-sqld.sh` (runs `sqld --auth-jwt-key-file <ed25519_pub.pem>`).
- `logic::db_connection(user_id)` opens a per-op connection: mints a fresh EdDSA token, then:
  - web (`cfg(feature="web")`): `Builder::new_remote(url, token)`.
  - desktop/mobile: `Builder::new_remote_replica(path, url, token)` (local file syncs to sqld).
- Backend holds the Ed25519 **private** key; sqld holds the **public** key (mismatched halves = auth fails).
- Multi-tenancy today: single (default) namespace, rows scoped by `WHERE user_id = ?`. Flip to `--enable-namespaces` for hard per-user DB isolation (token `sub` → namespace) — see Next dev.

## Configuration (.env)

Project-root `.env` (gitignored) — backend reads these via `auth::load_dotenv()` at startup:
```
KAWAI_AUTH_JWKS_URI=...        # Clerk public JWKS
KAWAI_AUTH_ISSUER=...          # Clerk frontend-API origin
# KAWAI_AUTH_DEV_USER_ID=dev   # uncomment to accept ANY token as this user (dev only)
KAWAI_DB_URL=http://127.0.0.1:8080
KAWAI_DB_JWT_PRIVATE_KEY_FILE=.../sqld_jwt_ed25519.pem
```
`.env.local` (gitignored) — Vite/Clerk only: `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`. The backend never uses the secret.

## Next dev / follow-ups

1. **Desktop/mobile session persistence.** `State<Session>` is in-memory; lost on restart. Persist the token in the OS keychain (`tauri-plugin-stronghold` / keyring) and reload on launch.
2. **Desktop/mobile DB token broker.** `logic::mint_db_token` reads the Ed25519 private key locally — fine for dev, but the private key MUST NOT ship in a production app. Add a `db_token` op: kawai-web verifies Clerk → mints a short EdDSA token → the device fetches it and feeds `Builder::new_remote_replica`. The private key stays server-side.
3. **Connection pooling + token refresh.** DB connections are opened per-op (correct, not optimal). Pool them and refresh tokens before expiry for production load.
4. **`--enable-namespaces` on sqld** for hard per-user DB isolation (token `sub` → namespace) instead of shared-namespace + `WHERE user_id`.
5. **Mobile compile verification.** `jsonwebtoken` (ring) + `reqwest` (rustls) + `libsql` were added but NOT yet checked on android arm64 / ios arm64 — run `cargo ndk -t arm64-v8a -P 24 check` and `cargo check --target aarch64-apple-ios`.
6. **Production hardening.** Add `Secure` to the session cookie (HTTPS only), CORS only if cross-origin, rate limiting, Clerk refresh-token rotation.
7. **`rig` (LLM) is unused.** Declared in Cargo.toml but no LLM features yet — wire the first LLM op (map its token stream onto the streaming event pattern) when ready.
8. **Tests.** No test suite yet; add unit tests for `auth.rs` (JWKS verify) and `logic.rs` (token mint + db round-trip).
