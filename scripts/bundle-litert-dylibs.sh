#!/usr/bin/env bash
set -euo pipefail

# bundle-litert-dylibs.sh — Prepare LiteRT-LM dylibs for bundling into the .app.
#
# Copies companion dylibs from the LiteRT-LM prebuilt directory into
# cognee-litert-lm/native/, fixes install names and rpaths, and re-codesigns.
# Designed for both CI (after bazel build) and local dev (before tauri build).
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

for lib in \
  libGemmaModelConstraintProvider.dylib \
  libLiteRt.dylib \
  libLiteRtMetalAccelerator.dylib \
  libLiteRtTopKMetalSampler.dylib; do
  src="$PREBUILT_DIR/$lib"
  if [ ! -f "$src" ]; then
    echo "  WARNING: $lib not found in prebuilt — skipping"
    continue
  fi
  echo "  $lib"
  cp "$src" "$NATIVE_DIR/$lib"
done

echo "→ Removing baked-in bazel _solib rpaths from liblitert-lm.dylib..."
# The _solib rpaths point into Bazel's output tree which doesn't exist in the
# shipped bundle. The @rpath/libGemmaModelConstraintProvider.dylib reference
# will resolve through the binary's LC_RPATH instead.
for rpath in \
  '@loader_path/../_solib_darwin_arm64/_U_S_Sruntime_Scomponents_Sconstrained_Udecoding_Cgemma_Umodel_Uconstraint_Uprovider_Ushared_Ulib___Uprebuilt_Smacos_Uarm64' \
  '@loader_path/liblitert-lm.dylib.runfiles/litert_lm/_solib_darwin_arm64/_U_S_Sruntime_Scomponents_Sconstrained_Udecoding_Cgemma_Umodel_Uconstraint_Uprovider_Ushared_Ulib___Uprebuilt_Smacos_Uarm64' \
  '@loader_path/../_solib_darwin_arm64/_U_S_Sruntime_Scomponents_Slogits_Uprocessor_Sconstrained_Udecoding_Cgemma_Umodel_Uconstraint_Uprovider_Ushared_Ulib___Uprebuilt_Smacos_Uarm64' \
  '@loader_path/liblitert-lm.dylib.runfiles/litert_lm/_solib_darwin_arm64/_U_S_Sruntime_Scomponents_Slogits_Uprocessor_Sconstrained_Udecoding_Cgemma_Umodel_Uconstraint_Uprovider_Ushared_Ulib___Uprebuilt_Smacos_Uarm64'; do
  install_name_tool -delete_rpath "$rpath" "$NATIVE_DIR/liblitert-lm.dylib" 2>/dev/null || true
done

echo "→ Adding @loader_path/../Frameworks rpath to dylibs..."
for lib in "$NATIVE_DIR"/*.dylib; do
  install_name_tool -add_rpath '@loader_path/../Frameworks' "$lib" 2>/dev/null || true
done

echo "→ Re-codesigning (ad-hoc)..."
codesign -f -s - "$NATIVE_DIR"/*.dylib

echo "✅ Done. $(ls -1 "$NATIVE_DIR"/*.dylib | wc -l | tr -d ' ') dylibs in $NATIVE_DIR"
