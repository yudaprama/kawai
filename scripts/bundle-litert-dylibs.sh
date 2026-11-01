#!/usr/bin/env bash
set -euo pipefail

# bundle-litert-dylibs.sh — Prepare LiteRT-LM dylibs for bundling into the .app.
#
# Copies the companion dylibs from the LiteRT-LM prebuilt directory into
# cognee-litert-lm/native/, strips the bazel _solib rpaths, adds the bundle
# rpath, and re-codesigns. Designed for both CI (after bazel build) and local
# dev (before tauri build).
#
# The prebuilt directory is the source of truth for the companion set: the
# engine hard-links some of them (libGemmaModelConstraintProvider,
# libwebgpu_dawn) and dlopens the rest (GPU accelerators, TopK samplers), so
# EVERY *.dylib found there is staged — a companion added or dropped upstream
# needs no edit here.
#
# Prerequisites:
#   cognee-litert-lm/native/liblitert-lm.dylib  (the main C API library)
#
# Usage:
#   bash scripts/bundle-litert-dylibs.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE_DIR="$PROJECT_DIR/cognee-litert-lm/native"
PREBUILT_DIR="$PROJECT_DIR/cognee-litert-lm/vendor/LiteRT-LM/prebuilt/macos_arm64"

if [ ! -f "$NATIVE_DIR/liblitert-lm.dylib" ]; then
  echo "ERROR: $NATIVE_DIR/liblitert-lm.dylib not found."
  echo "Build it first:"
  echo "  cd cognee-litert-lm/vendor/LiteRT-LM"
  echo "  bazel build //c:litert-lm --config=macos_arm64 --jobs=6"
  echo "  cp bazel-bin/c/liblitert-lm.dylib $NATIVE_DIR/"
  echo "  install_name_tool -id @rpath/liblitert-lm.dylib $NATIVE_DIR/liblitert-lm.dylib"
  exit 1
fi

if [ ! -d "$PREBUILT_DIR" ]; then
  echo "ERROR: Prebuilt directory $PREBUILT_DIR not found."
  echo "Is the LiteRT-LM submodule initialized?"
  echo "  git submodule update --init --recursive cognee-litert-lm"
  exit 1
fi

echo "→ Copying companion dylibs from prebuilt/ into native/..."
shopt -s nullglob
companions=("$PREBUILT_DIR"/*.dylib)
shopt -u nullglob
if [ ${#companions[@]} -eq 0 ]; then
  echo "ERROR: no .dylib companions in $PREBUILT_DIR"
  exit 1
fi
for src in "${companions[@]}"; do
  echo "  $(basename "$src")"
  cp "$src" "$NATIVE_DIR/"
done

echo "→ Removing baked-in bazel _solib rpaths from liblitert-lm.dylib..."
# The _solib rpaths point into Bazel's output tree, which does not exist in
# a shipped bundle (or in a plain cargo build). Every companion resolves
# through @loader_path — the main library's own rpath list — instead. Deleted
# generically (not from a fixed list) so a new dependency's rpath can't leak
# through: each upstream bump rewrites this set.
while IFS= read -r rpath; do
  [ -n "$rpath" ] || continue
  install_name_tool -delete_rpath "$rpath" "$NATIVE_DIR/liblitert-lm.dylib" 2>/dev/null || true
done < <(otool -l "$NATIVE_DIR/liblitert-lm.dylib" \
  | sed -n 's/^ *path \(.*\) (offset [0-9]*)$/\1/p' \
  | grep '_solib' || true)

echo "→ Adding @loader_path/../Frameworks rpath to dylibs..."
for lib in "$NATIVE_DIR"/*.dylib; do
  install_name_tool -add_rpath '@loader_path/../Frameworks' "$lib" 2>/dev/null || true
done

echo "→ Verifying every @rpath dependency resolves beside the library..."
missing=0
while IFS= read -r dep; do
  case "$dep" in
    @rpath/*)
      name="${dep#@rpath/}"
      if [ -f "$NATIVE_DIR/$name" ]; then
        echo "  $name"
      else
        echo "  ERROR: $dep has no file in $NATIVE_DIR"
        missing=1
      fi
      ;;
  esac
done < <(otool -L "$NATIVE_DIR/liblitert-lm.dylib" | tail -n +2 | awk '{print $1}')
if [ "$missing" -ne 0 ]; then
  echo "ERROR: unresolved @rpath dependencies — is prebuilt/macos_arm64/ in sync?"
  exit 1
fi

echo "→ Re-codesigning (ad-hoc)..."
codesign -f -s - "$NATIVE_DIR"/*.dylib

echo "✅ Done. $(ls -1 "$NATIVE_DIR"/*.dylib | wc -l | tr -d ' ') dylibs in $NATIVE_DIR"
