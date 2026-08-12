# Kawai Architecture

Multi-target app (web, desktop, mobile) with React frontend and Rust backend.
Each platform uses its **native transport**: Tauri IPC (desktop/mobile) and HTTP/SSE (web).

## Goals

- Web, desktop, mobile are equally important targets.
- Frontend: React + TypeScript (Vite), one build for all targets.
- Backend: Rust, single core logic.
- App logic is 100% shared; only transport and launcher differ per target.
- LLM orchestration: `rig` (in `logic.rs`).
- Persistence: `libsql` — per-user embedded replica syncing to Turso (multitenant), in `logic.rs`.

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
│  capabilities : native features    (plugin | Web API)     │
├───────────────────────┬───────────────────────────────────┤
│  Desktop / Mobile     │  Web                              │
│  Tauri Channel+invoke │  HTTP fetch + SSE                 │
├───────────────────────┴───────────────────────────────────┤
│  BACKEND WRAPPERS (Rust, thin, no business logic)         │
│  commands.rs #[tauri::command]  │  web.rs Axum routes     │
├───────────────────────────────────────────────────────────┤
│  CORE LOGIC (Rust, pure, platform-agnostic)               │
│  logic.rs : fn() -> T  |  fn() -> Stream<Event>           │
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
│   │   └── capabilities.ts   # native features (future)
│   └── types/
│       └── events.ts
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs           # desktop binary entry
        ├── lib.rs            # Tauri builder + module decls
        ├── logic.rs          # PURE LOGIC (no Tauri/Axum deps)
        ├── commands.rs       # #[tauri::command] wrappers
        ├── web.rs            # Axum router + static serving
        └── bin/
            └── web.rs        # standalone web server entry
```

## Layers

1. **`logic.rs`** — the only place for business logic. Pure async fns, no Tauri/Axum imports. Returns `T` (RPC) or `impl Stream<Item = Event>` (streaming). Events tagged `#[serde(tag = "type")]`. Home of `rig` (LLM) and `libsql` (per-user synced DB) usage.
2. **`commands.rs`** — thin wrappers. Each core fn → one `#[tauri::command]`. Streaming commands take a `Channel<E>` plus the business args as individual fields.
3. **`web.rs`** — thin wrappers. Each core fn → one Axum route. Static assets served via `ServeDir("../dist")`.
4. **Launcher**:
   - Desktop/Mobile (`main.rs` → `lib.rs::run()`): Tauri builder, registers commands. **Does NOT run Axum.**
   - Web (`bin/web.rs`): binds `0.0.0.0:PORT`, serves `dist/` + API router. Not a Tauri app.
5. **Frontend abstraction** — components only call `call()` / `streamOperation()`, never branch on platform. Detection happens once in `transport.ts`.

## Conventions

| Concern | Convention |
|---------|------------|
| Naming | command `foo_bar` ↔ route `POST /api/foo_bar` ↔ frontend `call('foo_bar')` (Tauri uses the snake_case fn name verbatim; one string used for both invoke and URL path) |
| Errors | Rust `Result<T, String>` ↔ web HTTP 4xx/5xx + `{error}` ↔ frontend `throw Error` |
| Event tagging | `#[serde(tag = "type")]`; `finished`/`error` variants are terminal |
| Completion | encoded in event type, not in transport |
| Cancellation | Web: `AbortController` (connection drop → Axum response future dropped → stream dropped → pending `sleep` auto-cancelled). Desktop/Mobile: `cancel_stream` command signals a `CancellationToken` looked up by `streamId` in a shared registry, breaking the `select!` loop |
| Static assets | Tauri: `frontendDist = ../dist`; Web: Axum `ServeDir("../dist")` |

## Core dependencies (in `logic.rs`)

- **`rig`** — LLM orchestration (providers, agents, streaming). Use for any LLM call; token streams map onto the streaming event pattern.
- **`libsql`** — per-user embedded replica syncing to Turso (multitenant). Desktop/mobile: local replica file per user; web: remote connection per user (a shared server keeps no per-user local file). Builder selection lives in `logic.rs`.
- Both compile clean across desktop, android arm64, and ios arm64 (verified). They pull two rustls versions (0.22 + 0.23) — expected.

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
