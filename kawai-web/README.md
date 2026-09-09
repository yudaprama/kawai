# kawai-web — standalone web server

Independent Axum deploy without Tauri/WebView. `kawai` desktop links `wry`/`tao`/`webkit` (~15 MB + WebView runtime); this crate links **zero** Tauri crates.

## Build

```sh
# check — must show no wry/tao/tauri runtime
cargo tree --manifest-path kawai-web/Cargo.toml | grep -E "wry|tao|tauri "
# -> empty (only tauri-build as build-dep, not linked)

cargo check --manifest-path kawai-web/Cargo.toml
cargo build --manifest-path kawai-web/Cargo.toml --release
# output: kawai-web/target/release/kawai-web

# via src-tauri bin (same binary, same gating)
cargo build -p kawai --no-default-features --features web --bin kawai-web --release
```

## Run

```sh
# frontend first
bun run build  # -> dist/

# env
KAWAI_WEB_ADDR=0.0.0.0:3000 cargo run -p kawai-web
# or
KAWAI_WEB_ADDR=0.0.0.0:3000 ./kawai-web/target/release/kawai-web

# data root defaults to <temp>/kawai (headless); override in code via
# kawai_paths::set_data_root before any db access.
```

## Deploy (Docker)

```sh
docker build -f kawai-web/Dockerfile -t kawai-web .
docker run -p 3000:3000 -v kawai-data:/data -e KAWAI_WORKER_URL=https://... kawai-web
```

## Gating

- `src-tauri/Cargo.toml:22` `tauri`/`tauri-plugin-*`/`keyring` are `optional = true` behind `desktop` feature.
- `src-tauri/src/lib.rs:1` `run()` and `commands`/`webview_engine` are `#[cfg(feature="desktop")]`.
- `kawai-web/Cargo.toml` depends on `kawai = { path="../src-tauri", default-features=false, features=["web"] }`.
- Heavy features (`litert`, `analytics-sql`, `monad`, `tts`, `codegraph`) remain opt-in; default web is minimal (no `polars`/`ort` unless full).

## Variants

- `kawai` desktop (default): `cargo check -p kawai` == `cargo check -p kawai --features desktop`
- `kawai-web` minimal: `cargo check --manifest-path kawai-web/Cargo.toml`
- `kawai-web` full: add `features = ["web","litert","analytics-sql"]` in `kawai-web/Cargo.toml` if supervisor/planner needed server-side.
