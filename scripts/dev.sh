#!/usr/bin/env bash
# Dev launcher for kawai desktop with on-device LLM (LiteRT-LM).
# Usage: ./scripts/dev.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LITERT_NATIVE="$PROJECT_ROOT/cognee-litert-lm/native"

if [ ! -d "$LITERT_NATIVE" ]; then
  echo "ERROR: $LITERT_NATIVE not found. Run bundle-litert-dylibs.sh first."
  exit 1
fi

cd "$PROJECT_ROOT/src-tauri"

exec env \
  RUSTFLAGS="-C link-arg=-Wl,-rpath,$LITERT_NATIVE" \
  LITERT_LM_LIB_DIR="$LITERT_NATIVE" \
  LLVM_PROFILE_FILE=/dev/null \
  KAWAI_AUTH_DEV_USER_ID=demo \
  "$PROJECT_ROOT/node_modules/.bin/tauri" dev -- --features litert
