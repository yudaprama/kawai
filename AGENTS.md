# AGENTS.md — agent guide for kawai

Read this before touching the code. Full design lives in `ARCHITECTURE.md`.
This file is the operational rulebook.

## What this project is

Multi-target app: **web, desktop, mobile** — all equally important.

- **Frontend**: React + TypeScript (Vite). Single build for all targets.
- **Backend**: Rust. Single core logic, two thin transport wrappers.
- **Transport**: native per platform — Tauri `Channel`+`invoke` (desktop/mobile), HTTP `fetch`+SSE (web).
- **LLM**: `rig` (in `logic.rs`).
- **DB**: `libsql` (in `logic.rs`) — per-user embedded replica that syncs to Turso (multitenant).

## Non-negotiable invariants

1. **`logic.rs` is pure.** Never import `tauri`, `axum`, or any transport type there. It owns business logic and returns `T` or `impl Stream<Item = Event>`.
2. **Two thin wrappers per operation.** One `#[tauri::command]` in `commands.rs`, one Axum route in `web.rs`. Both call the same `logic.rs` fn. No business logic in wrappers.
3. **One operation = one snake_case string**, used identically for: the Rust fn name, the invoke name, and the URL path (`POST /api/<name>`). Tauri uses the fn name **verbatim** (no kebab/camel conversion). Arguments are camelCase on the JS side, mapping to snake_case Rust params.
4. **Frontend never branches on platform** inside components. Use `src/lib/api.ts` (`call`) and `src/lib/stream.ts` (`streamOperation`). Platform detection lives only in `src/lib/transport.ts` and uses `window.__TAURI_INTERNALS__` — **not** `window.__TAURI__` (we run with `withGlobalTauri: false`).
5. **Web deps stay gated.** `axum`/`tower-http` are `optional`, behind the `web` Cargo feature. The `web` module is `#[cfg(feature = "web")]`. The `kawai-web` binary has `required-features = ["web"]`. Never make axum a non-optional dep — it must stay out of desktop/mobile binaries.
6. **Events.** `#[serde(tag = "type")]` in `logic.rs`; keep `src/types/events.ts` in sync. Terminal variants are `finished` / `error`.

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

## Where things live

```
src/lib/transport.ts            # platform detection (window.__TAURI_INTERNALS__)
src/lib/api.ts                  # request-response (invoke | fetch)
src/lib/stream.ts               # streaming (Channel | SSE), generates streamId, cancel()
src/types/events.ts             # TS mirror of logic.rs event enums — keep in sync
src/App.tsx                     # demo: greet (RPC) + generate_activity (streaming)
src-tauri/src/logic.rs          # PURE logic; rig + libsql usage lives here
src-tauri/src/commands.rs       # #[tauri::command] wrappers + Channel + cancellation registry
src-tauri/src/web.rs            # Axum routes (feature-gated "web")
src-tauri/src/bin/web.rs        # standalone web server entry
src-tauri/src/lib.rs            # Tauri builder; .manage(registry); generate_handler!
src-tauri/Cargo.toml            # axum/tower-http optional behind feature "web"
```

## Adding a new operation (checklist)

1. Write the pure fn (+ any event enum) in `logic.rs`. Events: `#[serde(tag = "type")]`.
2. Mirror any new event types in `src/types/events.ts`.
3. Add the `#[tauri::command]` in `commands.rs`:
   - RPC: return `Result<T, String>`.
   - Streaming: take `stream_id: String` + `on_event: Channel<E>` + `State<StreamRegistry>`; loop with `tokio::select!` racing `token.cancelled()` vs `stream.next()`; register/remove token by `stream_id`.
4. Add the Axum route in `web.rs`: RPC → `Json<T>`; streaming → `Sse<impl Stream<Item = Result<Event, _>>>`. Register it in `router()`.
5. Register the command in `lib.rs` `generate_handler!`.
6. Call from React: `call('<name>', args)` or `streamOperation('<name>', args, handlers)`.
7. Verify: `bun run build`, `cargo check`, `cargo check --features web`.
