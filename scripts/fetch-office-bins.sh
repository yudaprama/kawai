#!/usr/bin/env bash
# Fetch the office CLI engines into src-tauri/ for dev builds:
#   - ooxcli  (github.com/yudaprama/gooxml releases)      → src-tauri/office-bin/
#   - pdfcli  (github.com/yudaprama/pdf releases)         → src-tauri/office-bin/
#   - office-runtime (github.com/yudaprama/Docker-DocumentServer)
#     docbuilder + x2t + frameworks + sdkjs               → src-tauri/office-runtime/
#
# The backend resolves them via (1) KAWAI_OFFICE_BIN_DIR / KAWAI_OFFICE_RUNTIME_DIR
# env, (2) injected Tauri resource dirs (release bundles), (3) exe-dir siblings.
# For `tauri dev` / `cargo run` the exe lives in src-tauri/target/debug/, so we
# ALSO sync into target/debug/{office-bin,office-runtime} when it exists.
#
# Bundling into release .app/.msi (tauri.conf.json resources) is a follow-up:
# run this script first once that lands, since bundling requires the dirs.
set -euo pipefail

cd "$(dirname "$0")/.."

OOXCLI_TAG="${OOXCLI_TAG:-v0.1.4}"
PDFCLI_TAG="${PDFCLI_TAG:-v0.1.5}"
RUNTIME_TAG="${RUNTIME_TAG:-runtime-v8}"

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
RUNTIME_DIR="src-tauri/office-runtime"
mkdir -p "$BIN_DIR" "$RUNTIME_DIR"

fetch() { # fetch <url> <dest-file>
  local url="$1" dest="$2"
  echo "→ $(basename "$dest")"
  curl -fL --retry 3 -o "$dest" "$url"
}

# ── ooxcli + pdfcli ──────────────────────────────────────────────────────────
BIN_EXT=""
if [ -z "${SLUG##windows-*}" ]; then BIN_EXT=".exe"; fi

fetch "https://github.com/yudaprama/gooxml/releases/download/${OOXCLI_TAG}/ooxcli-${SLUG}${BIN_EXT}" \
      "$BIN_DIR/ooxcli${BIN_EXT}"
fetch "https://github.com/yudaprama/pdf/releases/download/${PDFCLI_TAG}/pdfcli-${SLUG}${BIN_EXT}" \
      "$BIN_DIR/pdfcli${BIN_EXT}"
chmod +x "$BIN_DIR"/* 2>/dev/null || true

# ── office-runtime (docbuilder + x2t + sdkjs) ───────────────────────────────
RT_TARBALL="office-runtime-${SLUG}.tar.gz"
fetch "https://github.com/yudaprama/Docker-DocumentServer/releases/download/${RUNTIME_TAG}/${RT_TARBALL}" "/tmp/${RT_TARBALL}"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"
tar -xzf "/tmp/${RT_TARBALL}" -C "$RUNTIME_DIR"
rm -f "/tmp/${RT_TARBALL}"
chmod +x "$RUNTIME_DIR/bin/"* 2>/dev/null || true
# Strip quarantine xattrs so extracted binaries run on the dev host (macOS only;
# xattr is absent on linux/windows runners — fine, there is nothing to strip).
xattr -cr "$RUNTIME_DIR" 2>/dev/null || true

# ── sanity: docbuilder invocation is picky — verify it exists + is exec ─────
if [ ! -f "$RUNTIME_DIR/bin/docbuilder${BIN_EXT}" ]; then
  echo "⚠️  docbuilder missing from office-runtime (create will be unavailable)" >&2
fi

# ── sync to target/debug for the exe-dir fallback in dev ────────────────────
DBG="src-tauri/target/debug"
if [ -d "$DBG" ]; then
  rm -rf "$DBG/office-bin" "$DBG/office-runtime"
  cp -R "$BIN_DIR" "$DBG/office-bin"
  cp -R "$RUNTIME_DIR" "$DBG/office-runtime"
  echo "synced → $DBG/{office-bin,office-runtime}"
fi

echo
echo "Done. Verify from the app via the office_capabilities op."
echo "Dev override (optional), in .env:"
echo "  KAWAI_OFFICE_BIN_DIR=$(pwd)/$BIN_DIR"
echo "  KAWAI_OFFICE_RUNTIME_DIR=$(pwd)/$RUNTIME_DIR"
