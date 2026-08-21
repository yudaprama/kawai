#!/usr/bin/env bash
# Fetch the office CLI engines into src-tauri/ for dev builds:
#   - ooxcli  (github.com/yudaprama/gooxml releases)      → src-tauri/office-bin/
#
# Document CREATION needs no engine (pure Rust via office_oxide).
# PDF operations need no engine either (pure Rust via pdf_oxide, in-process).
#
# The backend resolves the binaries via (1) KAWAI_OFFICE_BIN_DIR env,
# (2) the injected Tauri resource dir (release bundles), (3) exe-dir sibling.
# For `tauri dev` / `cargo run` the exe lives in src-tauri/target/debug/, so we
# ALSO sync into target/debug/office-bin when it exists.
set -euo pipefail

cd "$(dirname "$0")/.."

OOXCLI_TAG="${OOXCLI_TAG:-v0.1.5}"

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64|arm64e) SLUG=darwin-arm64 ;;
      x86_64)       SLUG=darwin-amd64 ;;
    esac ;;
  Linux)
    case "$ARCH" in
      x86_64)  SLUG=linux-amd64 ;;
      aarch64) SLUG=linux-arm64 ;;
    esac ;;
  # GitHub windows runners run steps in Git Bash (MINGW64); uname -m is x86_64.
  MINGW*|MSYS*|CYGWIN*)
    case "$ARCH" in
      x86_64|amd64) SLUG=windows-amd64 ;;
      arm64|aarch64) SLUG=windows-arm64 ;;
    esac ;;
esac
if [ -z "${SLUG:-}" ]; then
  echo "unsupported host: $OS/$ARCH" >&2; exit 1
fi
echo "host slug: $SLUG"

BIN_DIR="src-tauri/office-bin"
mkdir -p "$BIN_DIR"

fetch() { # fetch <url> <dest-file>
  local url="$1" dest="$2"
  echo "→ $(basename "$dest")"
  curl -fL --retry 3 -o "$dest" "$url"
}

# ── ooxcli ───────────────────────────────────────────────────────────────────
BIN_EXT=""
if [ -z "${SLUG##windows-*}" ]; then BIN_EXT=".exe"; fi

fetch "https://github.com/yudaprama/gooxml/releases/download/${OOXCLI_TAG}/ooxcli-${SLUG}${BIN_EXT}" \
      "$BIN_DIR/ooxcli${BIN_EXT}"
chmod +x "$BIN_DIR"/* 2>/dev/null || true
# Strip quarantine xattrs so the binaries run on the dev host (macOS only).
xattr -cr "$BIN_DIR" 2>/dev/null || true

# ── sync to target/debug for the exe-dir fallback in dev ────────────────────
DBG="src-tauri/target/debug"
if [ -d "$DBG" ]; then
  rm -rf "$DBG/office-bin"
  cp -R "$BIN_DIR" "$DBG/office-bin"
  echo "synced → $DBG/office-bin"
fi

echo
echo "Done. Verify from the app via the office_capabilities op."
echo "Dev override (optional), in .env:"
echo "  KAWAI_OFFICE_BIN_DIR=$(pwd)/$BIN_DIR"
