#!/usr/bin/env bash
# tauri CLI wrapper (invoked via `bun tauri ...`).
# `dev` launches the on-device LLM stack: LiteRT dylibs rpath, litert feature,
# dev-bypass auth, profraw disabled. Everything else passes through unchanged.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI="$PROJECT_ROOT/node_modules/.bin/tauri"
CMD="${1:-}"

if [ "$CMD" = "dev" ]; then
  LITERT_NATIVE="$PROJECT_ROOT/cognee-litert-lm/native"
  if [ ! -d "$LITERT_NATIVE" ]; then
    echo "ERROR: $LITERT_NATIVE not found. Prepare the dylibs first:"
    echo "  bun run bundle:litert"
    exit 1
  fi
  cd "$PROJECT_ROOT/src-tauri"
  exec env \
    RUSTFLAGS="-C link-arg=-Wl,-rpath,$LITERT_NATIVE" \
    LITERT_LM_LIB_DIR="$LITERT_NATIVE" \
    LLVM_PROFILE_FILE=/dev/null \
    KAWAI_AUTH_DEV_USER_ID=demo \
    "$TAURI" dev -- --features litert
fi

exec "$TAURI" "$@"