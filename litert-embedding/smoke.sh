#!/usr/bin/env bash
# Run the smoke example against a prepared LiteRT-LM native/ dir, wiring the
# link-time env vars cargo needs (LITERT_LM_LIB_DIR) and the runtime rpath.
# Usage: ./smoke.sh <model.litertlm> [--backend cpu|gpu]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$here")"
lib_dir="$repo_root/cognee-litert-lm/native"

if [ ! -f "$lib_dir/liblitert-lm.dylib" ] && [ ! -f "$lib_dir/litert-lm.dll" ]; then
  echo "error: LiteRT-LM dylibs not found in $lib_dir" >&2
  echo "run 'bun run bundle:litert' at the repo root first" >&2
  exit 1
fi

export LITERT_LM_LIB_DIR="$lib_dir"
rpath_arg="-C link-arg=-Wl,-rpath,$lib_dir"
if [ -n "${RUSTFLAGS:-}" ]; then
  case "$RUSTFLAGS" in
    *-Wl,-rpath,*"$lib_dir"*) ;;
    *) export RUSTFLAGS="$RUSTFLAGS $rpath_arg" ;;
  esac
else
  export RUSTFLAGS="$rpath_arg"
fi

cd "$here"
exec cargo run --example smoke -- "$@"
