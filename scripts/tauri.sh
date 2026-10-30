#!/usr/bin/env bash
# tauri CLI wrapper (invoked via `bun tauri ...`).
# `dev` launches the on-device LLM stack: LiteRT dylibs rpath, litert feature,
# binance agent tools (crypto_price/klines/ta in the supervisor registry),
# profraw disabled. Everything else passes through unchanged.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI="$PROJECT_ROOT/node_modules/.bin/tauri"
CMD="${1:-}"

# ── Android SDK/NDK discovery (any `tauri android ...` command) ──
# Tauri's android commands shell out to gradle, which needs ANDROID_HOME,
# and cargo-ndk needs the NDK. Both are commonly installed in
# non-standard prefixes (homebrew's android-commandlinetools, not
# ~/Library/Android/sdk), so resolve them here instead of making every
# caller export them by hand. Existing env always wins — this only fills
# in what is missing.
# Values in the repo-root `.env` win over discovery (below) — that file is
# the one place machine-local config lives (see .env's Android section).
# Only the allowlisted keys are read: sourcing the whole file would push
# every secret in it into the build's environment.
android_env_from_dotenv() {
  local env_file="$PROJECT_ROOT/.env" line key value
  [ -f "$env_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ANDROID_HOME=*|ANDROID_SDK_ROOT=*|ANDROID_NDK_HOME=*|ANDROID_NDK=*|NDK_HOME=*)
        key="${line%%=*}"
        value="${line#*=}"
        # Strip surrounding quotes; an already-exported var wins.
        value="${value%\"}"; value="${value#\"}"
        value="${value%\'}"; value="${value#\'}"
        if [ -n "$value" ] && [ -z "${!key:-}" ]; then
          export "$key=$value"
        fi
        ;;
    esac
  done < "$env_file"
}

android_env() {
  android_env_from_dotenv

  local sdk="" candidate
  if [ -n "${ANDROID_HOME:-}" ] || [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    # Explicit (shell or .env) wins — never silently redirect a value the
    # caller set. Only validated, not replaced.
    sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT}}"
  else
    for candidate in \
      "$HOME/Library/Android/sdk" \
      "/opt/homebrew/share/android-commandlinetools" \
      "/usr/local/share/android-commandlinetools" \
      "$HOME/Android/Sdk" \
      "/usr/lib/android-sdk" \
      "/opt/android-sdk"; do
      # A real SDK root has at least one of these; a stale/empty dir does not.
      if [ -d "$candidate" ] &&
         { [ -d "$candidate/platforms" ] || [ -d "$candidate/build-tools" ] ||
           [ -d "$candidate/ndk" ] || [ -d "$candidate/cmdline-tools" ]; }; then
        sdk="$candidate"
        break
      fi
    done
  fi

  if [ -z "$sdk" ]; then
    echo "WARNING: no Android SDK found — set ANDROID_HOME (checked ~/Library/Android/sdk," \
      "/opt/homebrew/share/android-commandlinetools, \$HOME/Android/Sdk)." >&2
    return 0
  fi
  export ANDROID_HOME="$sdk"
  export ANDROID_SDK_ROOT="$sdk"

  if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -z "${ANDROID_NDK:-}" ] && [ -z "${NDK_HOME:-}" ]; then
    # Newest version wins — sort -V over the NDK's own r.major.minor.patch dirs.
    local ndk
    # `|| true`: no ndk/ dir at all must not trip `set -o pipefail`.
    ndk="$(find "$sdk/ndk" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$ndk" ]; then
      export NDK_HOME="$sdk/ndk/$ndk"
      # build.rs reads ANDROID_NDK_HOME first; bazel's androidndk rule does too.
      export ANDROID_NDK_HOME="$NDK_HOME"
    fi
  fi
}

if [ "$CMD" = "android" ]; then
  android_env
fi

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
    "$TAURI" dev -- --features litert,binance,accounting,mexc,security
fi

exec "$TAURI" "$@"