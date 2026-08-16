# AGENTS.md — agent guide for kawai

Read this before touching the code. Full design lives in `ARCHITECTURE.md`.
This file is the operational rulebook.

## What this project is

Desktop/mobile app (Tauri), with a standalone web server binary.

- **Frontend**: Vanilla JS. No bundler, no framework. Served directly by Tauri (`frontendDist: "../src"`).
- **Auth**: Clerk via CDN + vanilla JS SDK (`window.Clerk`); backend verifies session JWTs against Clerk's **public JWKS** (`auth.rs`) — no Clerk secret in the backend.
- **Backend**: Rust. Single core logic, two thin transport wrappers.
- **Transport**: Tauri `Channel`+`invoke` (desktop/mobile); HTTP `fetch`+SSE (web — backend only, no web frontend).
- **LLM (on-device)**: LiteRT-LM via `cognee-litert-lm` (path dep, vendored at `cognee-litert-lm/vendor/LiteRT-LM` = upstream `google-ai-edge` main). Behind the `litert` cargo feature. Gemma 4 / Qwen `.litertlm` verified streaming on macOS arm64 CPU.
- **LLM (remote)**: `rig` (in `logic.rs`) — declared, not yet wired.
- **DB**: self-hosted `libsql-server` (sqld). Backend mints short **EdDSA** tokens that sqld validates; embedded replica (desktop/mobile) or remote client (web backend).

## Non-negotiable invariants

1. **`logic.rs` is pure.** Never import `tauri`, `axum`, or any transport type there. It owns business logic and returns `T` or `impl Stream<Item = Event>`.
2. **Two thin wrappers per operation.** One `#[tauri::command]` in `commands.rs`, one Axum route in `web.rs`. Both call the same `logic.rs` fn. No business logic in wrappers.
3. **One operation = one snake_case string**, used identically for: the Rust fn name, the invoke name, and the URL path (`POST /api/<name>`). Tauri uses the fn name **verbatim** (no kebab/camel conversion). Arguments are camelCase on the JS side, mapping to snake_case Rust params.
4. **Frontend uses `window.__TAURI__` directly** (`withGlobalTauri: true`). Platform is always Tauri — no platform branching needed.
5. **Web deps stay gated.** `axum`/`tower-http` are `optional`, behind the `web` Cargo feature. The `web` module is `#[cfg(feature = "web")]`. The `kawai-web` binary has `required-features = ["web"]`. Never make axum a non-optional dep — it must stay out of desktop/mobile binaries.
6. **Events.** `#[serde(tag = "type")]` in `logic.rs`; frontend reads `event.type` at runtime (no TS types file). Terminal variants are `finished` / `error`.
7. **Identity is resolved at the transport edge, not in `logic.rs`.** Wrappers verify the token and pass `user_id` (`claims.sub`) into `logic.rs` fns as the first param. The frontend NEVER sends `user_id`. `auth.rs` is pure (no tauri/axum): it does JWKS verification (Clerk) and EdDSA minting (sqld).
8. **sqld is EdDSA-only.** `libsql-server` validates client JWTs with Ed25519 (EdDSA) — NOT JWKS, NOT RS256. So Clerk's RS256 session JWTs CANNOT go to sqld. The backend verifies Clerk (JWKS) and MINTS the EdDSA token (`logic::mint_db_token`) sqld accepts. Never wire sqld to Clerk directly.
9. **DB builder selection is `cfg`-gated in `logic.rs`, not branched on a transport type.** `#[cfg(feature = "web")]` → remote client; `#[cfg(not(feature = "web"))]` → embedded replica. Keeps `logic.rs` pure.

## Commands

Package manager is **bun** (not npm/yarn).

```sh
# Desktop (Tauri) — no dev server, Tauri serves src/ directly
bun tauri dev
bun tauri build

# Desktop WITH on-device LLM (needs the Bazel-built dylib; see Landmines):
cd src-tauri && env \
  RUSTFLAGS="-C link-arg=-Wl,-rpath,<ABS>/cognee-litert-lm/native" \
  LITERT_LM_LIB_DIR=<ABS>/cognee-litert-lm/native \
  LLVM_PROFILE_FILE=/dev/null \
  KAWAI_AUTH_DEV_USER_ID=demo \
  ../node_modules/.bin/tauri dev -- --features litert

# Build the LiteRT-LM C library (first build ~15-30 min; cached afterwards)
cd cognee-litert-lm/vendor/LiteRT-LM && bazel build //c:litert-lm --config=macos_arm64 --jobs=6
# then copy + fix the dylib (see Landmines: rpath recipe)

# Web standalone server (Axum serves /api/*; no frontend)
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
cargo check                    # desktop — axum must NOT compile here
cargo check --features web     # web module + kawai-web bin
cargo check --features litert  # local LLM (bindgen only; no C lib needed)
```

For mobile changes, also: `cargo ndk -t arm64-v8a -P 24 check` and/or `cargo check --target aarch64-apple-ios` (NDK r29 at `/opt/homebrew/share/android-ndk`; sim target needs `rustup target add aarch64-apple-ios-sim`). All verified green 2026-08-15.

## Landmines (things that already bit us)

- **`async_stream` streams are not `Unpin`.** `Box::pin(...)` before calling `.next()` in a loop.
- **`Channel::send` takes the value by value**, not `&event` (Tauri 2: `send(data: T)`).
- **`-p` in cargo-ndk collides with cargo `--package`.** Use `-P` / `--platform`. cargo-ndk's panic handler **dumps all env vars to stdout** — never let it panic, and keep secrets out of shell env.
- **Two rustls versions coexist** (libsql 0.22 + rig 0.23). Expected, not a bug; binary is slightly larger.
- **`libsql-sys` / `aws-lc-sys` are C.** Mobile needs NDK clang (Android) or Xcode clang (iOS) plus libclang for bindgen. Verified working on android arm64 + ios arm64.
- **Cancellation is asymmetric by design.** Web: `AbortController` (connection drop auto-cancels the backend future). Desktop/mobile: frontend `cancel()` calls `invoke('cancel_stream', {streamId})` → `CancellationToken` in the shared registry breaks the `select!` loop. Streaming commands must accept a `stream_id` param and register/clean up a token.
- **Axum 0.8 `from_fn` hardcodes state to `()`.** A middleware that needs shared state can't use `from_fn` + `State<S>`; use `Extension` (our `auth_middleware` reads `Extension<Verifier>`) or `from_fn_with_state`. Don't fight the type inference by annotating `Router<S>` — switch to `Extension`.
- **`libsql` positional tuple params start at arity 2.** `(&str,)` is NOT `IntoParams`; use `vec![x]` (or an array) for a single param. Tuples `(A,B)` and up are fine. Params blanket-impl `T: TryInto<Value>` (so `&str`, `String`, `i64`, … all work).
- **Clerk JWTs are RS256; sqld accepts only EdDSA.** Never pass a Clerk session JWT to sqld — mint an EdDSA token in the backend first (invariant 8).
- **`dotenvy` does not override existing env vars.** Shell-exported vars win over `.env`. To force dev-bypass auth, `KAWAI_AUTH_DEV_USER_ID=demo cargo run ...`.
- **Two `jsonwebtoken` versions coexist** (9.x is our direct dep in `auth.rs`/`logic.rs`; 10.x is transitive). Expected.
- **Clerk CDN script is loaded in `index.html`.** `window.Clerk` must be available before `main.js` runs — the `<script>` tag order is: Clerk (defer) → main.js (module) → Alpine (defer, LAST — main.js registers the Alpine store on `alpine:init` which fires while Alpine executes; loading Alpine first = a page full of `$store.app undefined` TypeErrors).
- **clerk-js v5 has no constructor.** `window.Clerk` is already an instance; the publishable key goes in the `data-clerk-publishable-key` attribute on the script tag. `new window.Clerk(pk)` throws.
- **Clerk dev-mode does NOT work in the Tauri webview.** Dev instances need the `dev_browser` third-party cookie; WKWebView (macOS) blocks third-party cookies → `clerk.load()` always rejects. Wrap it in try/catch (see `initClerk` in `main.js`) and fall back to `setSession(<any-token>)`, which only succeeds when the backend runs the dev bypass. Production (`pk_live` + own domain) is expected to work; if not, the deep-link browser flow is the fallback (see Next dev).
- **Bazel-built dylibs emit `default.profraw` into the CWD.** If that CWD is `src-tauri/`, the `tauri dev` watcher sees the file change after every run and rebuild-loops the app forever (window opens/closes infinitely). Always set `LLVM_PROFILE_FILE=/dev/null` when running instrumented dylibs from `tauri dev`.
- **The LiteRT-LM dylib's install name is a bazel-relative path.** `dyld` can't find it from `target/debug/kawai` unless you: (1) copy it out of bazel-bin, (2) `install_name_tool -id @rpath/liblitert-lm.dylib` + re-codesign, (3) embed an rpath in the consuming binary via `RUSTFLAGS="-C link-arg=-Wl,-rpath,<dir>"` (a dependency's `cargo:rustc-link-arg` does NOT propagate to the final binary), and (4) symlink `cognee-litert-lm/_solib_darwin_arm64` → `vendor/LiteRT-LM/bazel-bin/_solib_darwin_arm64` for the sibling dylib deps. `DYLD_LIBRARY_PATH` does NOT survive through the tauri CLI.
- **LiteRT-LM streaming C calls are fire-and-forget async.** `litert_lm_conversation_send_message_stream` returns before generation starts; tokens arrive on an engine thread. Dropping the engine/conversation mid-generation segfaults. The blocking task must block until the final callback (`recv_timeout` on a channel fed from the callback) — see `logic::local_llm::local_chat`.
- **sentencepiece needs the patched recipe on macOS.** Upstream's v0.2.2 layout fails strict `hdrs_check`; our vendored WORKSPACE carries the fix (strip-to-src + `PATCH.sentencepiece_darts` + absl/protobuf seds + full absl deps in `BUILD.sentencepiece`). If you change the sentencepiece stanza, `bazel sync --only=sentencepiece` does NOT refetch — delete the repo dir under `/private/var/tmp/_bazel_*/external/sentencepiece` + its marker, then rebuild.
- **Tauri invoke rejects with a bare string, not an `Error`.** Read it via a helper (`errText` in `main.js`) — `err.message` is `undefined` otherwise.
- **No build step — frontend files are served as-is.** `src/` is the Tauri `frontendDist`. File paths in HTML/JS must be relative and valid for the filesystem (no bundler resolves them).
- **Logs go to `~/Library/Logs/kawai/app.log`.** `logging.rs` tees process stderr (Rust panics, `eprintln!`, LiteRT C++ absl logs) and `src/lib/log.js` pipes JS errors/rejections/`console.error` via the `frontend_log` command. Deliberately outside `src-tauri/` (watcher) — don't move it inside. A symlink lives at `kawai/app.log`.

## Where things live

```
src/index.html              # Entry point — Clerk CDN + main.js + Alpine (order matters)
src/main.js                 # App logic: Clerk auth, greet, stream, notes, local LLM
src/lib/log.js              # Global JS error capture → frontend_log command (import FIRST)
src/config.js               # Clerk publishable key (legacy; key now on the script tag)
src/lib/api.js              # RPC: window.__TAURI__.core.invoke
src/lib/stream.js           # Streaming: Channel + cancel_stream
src/lib/auth.js             # setSession/logout/whoami wrappers over call()
src-tauri/src/logic.rs      # PURE logic; rig + libsql + local_llm (litert) + db token minting
src-tauri/src/logging.rs    # stderr tee + frontend_log sink → ~/Library/Logs/kawai/app.log
src-tauri/src/auth.rs       # PURE auth; Clerk JWKS verify + EdDSA mint + Session
src-tauri/src/commands.rs   # #[tauri::command] wrappers + Channel + cancel registry
src-tauri/src/web.rs        # Axum routes (feature-gated "web") + auth_middleware
src-tauri/src/bin/web.rs    # standalone web server entry
src-tauri/src/lib.rs        # Tauri builder; .manage(...); generate_handler!
src-tauri/examples/local_llm_smoke.rs   # headless local-LLM smoke test (features litert)
src-tauri/Cargo.toml        # axum/tower-http behind "web"; cognee-litert-lm behind "litert"
cognee-litert-lm/           # Rust bindings for the LiteRT-LM C API (path dep)
cognee-litert-lm/vendor/LiteRT-LM        # submodule = upstream google-ai-edge main + macOS patches
models/                     # .litertlm model files (gitignored, GB-scale)
.env                        # KAWAI_AUTH_* + KAWAI_DB_* (gitignored; dotenvy at startup)
.env.local                  # VITE_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY (gitignored)
scripts/dev-sqld.sh         # dev launcher for self-hosted sqld
app.log                     # symlink → ~/Library/Logs/kawai/app.log
```

## Adding a new operation (checklist)

1. Write the pure fn (+ any event enum) in `logic.rs`. Events: `#[serde(tag = "type")]`.
2. No TS event file to mirror — frontend reads `event.type` at runtime.
3. Add the `#[tauri::command]` in `commands.rs`:
   - RPC: return `Result<T, String>`.
   - Streaming: take `stream_id: String` + `on_event: Channel<E>` + `State<StreamRegistry>`; loop with `tokio::select!` racing `token.cancelled()` vs `stream.next()`; register/remove token by `stream_id`.
   - If it requires auth: take `State<Session>`, read claims, pass `claims.sub` to the `logic.rs` fn as `user_id`. The frontend never passes `user_id`.
4. Add the Axum route in `web.rs`: RPC → `Json<T>`; streaming → `Sse<impl Stream<Item = Result<Event, _>>>`. Register it in `router()`.
   - If it requires auth: mount it on the `protected` router (behind `auth_middleware`) and take `Extension<auth::Claims>`; pass `claims.sub` to the same `logic.rs` fn. Public ops stay on `public`.
5. Register the command in `lib.rs` `generate_handler!`.
6. Call from vanilla JS: `call('<name>', args)` or `streamOperation('<name>', args, handlers)` in `src/main.js` (or a new module in `src/lib/`).
7. Verify: `cargo check`, `cargo check --features web`.

## Authentication

- Frontend: Clerk loaded from CDN in `index.html`. clerk-js v5 exposes `window.Clerk` as an already-constructed instance (key on the script tag's `data-clerk-publishable-key`). `main.js` calls `clerk.load()` (wrapped in try/catch — it rejects in the webview) and pushes the Clerk session JWT into the backend on sign-in and every ~50s (tokens expire in ~60s).
- `set_session` (`src/lib/auth.js`) hands the JWT to the backend once:
  - Desktop/mobile: backend stores the verified identity in Tauri `State<Session>` (in-memory).
  - Web backend (no web frontend): backend sets an HttpOnly `kawai_session` cookie.
- Backend verification: `auth::Verifier` fetches Clerk's **public** JWKS (cached by `kid`) and checks `iss`/`exp`. **No `CLERK_SECRET_KEY` is needed or used by the backend** — asymmetric verification.
- Identity → logic: wrappers extract `claims.sub` as `user_id` and pass it as the first arg to `logic.rs` fns. `whoami`/`create_note`/`list_notes`/`stream_notes`/`local_load_model`/`local_chat` are auth-required; `greet`/`generate_activity` are public.
- Auth operations: `set_session`, `logout`, `whoami` (one snake_case string each).

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
`.env.local` (gitignored) — Clerk publishable key reference: `VITE_CLERK_PUBLISHABLE_KEY`. The actual key is embedded in `src/config.js` (publishable keys are public by design).

## Next dev / follow-ups

1. **Desktop/mobile session persistence.** `State<Session>` is in-memory; lost on restart. Persist the token in the OS keychain (`tauri-plugin-stronghold` / keyring) and reload on launch.
2. **Desktop/mobile DB token broker.** `logic::mint_db_token` reads the Ed25519 private key locally — fine for dev, but the private key MUST NOT ship in a production app. Add a `db_token` op: kawai-web verifies Clerk → mints a short EdDSA token → the device fetches it and feeds `Builder::new_remote_replica`. The private key stays server-side.
3. **Connection pooling + token refresh.** DB connections are opened per-op (correct, not optimal). Pool them and refresh tokens before expiry for production load.
4. **`--enable-namespaces` on sqld** for hard per-user DB isolation (token `sub` → namespace) instead of shared-namespace + `WHERE user_id`.
5. **Mobile compile verification.** ✅ Done 2026-08-15: android arm64 (NDK r29 via brew) + iOS device + iOS sim all check clean, default/web/litert feature combos. NOT yet done: building the LiteRT-LM C lib itself for android/iOS (`cognee-litert-lm/build.rs` has the NDK path ready; needs `bazel build //c:litert-lm --config=android_arm64` + static-link trial).
6. **Production hardening.** Add `Secure` to the session cookie (HTTPS only), CORS only if cross-origin, rate limiting, Clerk refresh-token rotation.
7. **`rig` (remote LLM) is unused.** Declared in Cargo.toml but no LLM features yet — wire the first remote op (OpenAI-compatible endpoint / Ollama at localhost) onto the same streaming event pattern as `local_chat`, so backend choice becomes configuration.
8. **Local-LLM ops backlog** (feature `litert`):
   - `local_llm_reset` (fresh conversation), model unload, expose `ThinkingConfig` / constrained decoding (JSON schema) — all already wrapped in cognee-litert-lm.
   - Concurrency: one generation at a time today (session take/restore); a session pool would allow parallel chats.
   - Bundle dylibs for `tauri build` (framework-embedding recipe like flutter_gemma's, see its DESKTOP_SUPPORT.md).
9. **Gemma 4 GPU (Metal) — blocked upstream.** The `-gpu.litertlm` variants need backend `GPU_ARTISAN`, which maps to engine types (`kAdvancedLegacyTfLite`/`kLegacyTfLite`) that upstream deleted; only `kAdvancedLiteRTCompiledModel` registers now → `No available engine for GPU_ARTISAN`. The plain `.litertlm` is CPU-locked by its section backend-constraint (`engine_settings.cc:78` rejects mismatches). Revisit when upstream ships a GPU path for the compiled-model engine.
10. **Upstream PR: sentencepiece macOS fix — PR [#3262](https://github.com/google-ai-edge/LiteRT-LM/pull/3262), assume ignored.** Upstream is "not yet accepting external OSS contributions", so we operate as upstream-main + 1 local commit: the submodule points at our fork branch (`yudaprama/LiteRT-LM@fix/macos-sentencepiece-hdrs-check`), and `cognee-litert-lm/tools/update-litert-lm.sh` rebases the fix onto new upstream main mechanically. If the PR is ever merged, drop the commit and repoint the submodule at `google-ai-edge` main.
11. **Production auth = browser + deep link.** Clerk dev-mode is broken in the webview (see Landmines); even prod may need it. Flow: open system browser → Clerk sign-in → redirect `kawai://auth?token=<jwt>` → `set_session`. Needs the tauri deep-link plugin + a Clerk-hosted page (or kawai-web route) to mint the redirect.
12. **Tests.** No test suite yet; add unit tests for `auth.rs` (JWKS verify), `logic.rs` (token mint + db round-trip), and a `local_llm_smoke` CI job (needs a small `.litertlm` fixture — e.g. Gemma 3 270M or SmolLM 135M).
