# kawai-web — independent Axum deploy (no Tauri/WebView)
# Multi-stage with cargo-chef for cached Rust layers.
# Build frontend (bun) + Rust web binary, serve dist/ at /app/dist.

# --- Stage 0: frontend ---
FROM oven/bun:1 AS frontend
WORKDIR /app
COPY package.json bun.lock ./
COPY frontend ./frontend
COPY vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json components.json ./
RUN bun install --frozen-lockfile
COPY frontend ./frontend
# dist/ goes to /app/dist (vite root = frontend/)
RUN bun run build

# --- Stage 1: chef planner ---
FROM rust:1.82-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app
COPY crates ./crates
COPY src-tauri ./src-tauri
COPY kawai-tools ./kawai-tools
COPY kawai-embedding ./kawai-embedding
COPY kawai-vault ./kawai-vault
COPY kawai-web ./kawai-web
COPY local-llm ./local-llm
COPY cognee-litert-lm ./cognee-litert-lm
COPY office_oxide ./office_oxide
COPY Cargo.toml Cargo.lock* ./
# dummy recipe to leverage cache (only web profile, no desktop)
RUN cargo chef prepare --recipe-path recipe.json

# --- Stage 2: cook dependencies ---
FROM chef AS cacher
RUN cargo chef cook --release --recipe-path recipe.json --manifest-path kawai-web/Cargo.toml

# --- Stage 3: build web binary ---
FROM chef AS builder
COPY --from=cacher /app/target /app/target
COPY --from=cacher /usr/local/cargo /usr/local/cargo
COPY . .
# Build only web (no Tauri) — verifies `cargo tree` has zero wry/tao/tauri runtime
RUN cargo build --release --manifest-path kawai-web/Cargo.toml

# --- Stage 4: runtime (distroless) ---
FROM gcr.io/distroless/cc-debian12 AS runtime
WORKDIR /app
COPY --from=builder /app/kawai-web/target/release/kawai-web /app/kawai-web
COPY --from=frontend /app/dist /app/dist
# Data dir per-user SQLite (one kawai.db per email) — mount as volume in prod
ENV KAWAI_DATA_DIR=/data
ENV KAWAI_WEB_ADDR=0.0.0.0:3000
EXPOSE 3000
VOLUME ["/data"]
CMD ["/app/kawai-web"]
