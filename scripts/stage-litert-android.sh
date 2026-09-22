#!/usr/bin/env bash
set -euo pipefail

# stage-litert-android.sh — Pack the LiteRT-LM Android libs into the Tauri
# Android project's jniLibs so Android's linker resolves them at load time
# (DT_NEEDED + RUNPATH $ORIGIN — everything must sit in the app's
# nativeLibraryDir, which is what jniLibs becomes in the APK).
#
# Prerequisites:
#   cognee-litert-lm/native/aarch64-linux-android/liblitert-lm.so
#     (bazel build //c:litert-lm --config=android_arm64 — run inside
#      cognee-litert-lm/vendor/LiteRT-LM, then copy into native/<triple>/)
#   src-tauri/gen/android/  (`bun tauri android init`)
#
# liblitert-lm.so hard-requires libGemmaModelConstraintProvider.so. The
# GPU/OpenCL/WebGPU companions are dlopen'd opportunistically — without them
# the engine falls back to CPU; pass STAGE_ALL=1 to pack them too.
#
# Usage:
#   bash scripts/stage-litert-android.sh            # required libs only
#   STAGE_ALL=1 bash scripts/stage-litert-android.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$PROJECT_DIR/cognee-litert-lm/native/aarch64-linux-android"
COMPANIONS="$PROJECT_DIR/cognee-litert-lm/vendor/LiteRT-LM/prebuilt/android_arm64"
JNI_LIBS="$PROJECT_DIR/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"

if [ ! -f "$LIB_DIR/liblitert-lm.so" ]; then
  echo "ERROR: $LIB_DIR/liblitert-lm.so not found."
  echo "Build it first:"
  echo "  cd cognee-litert-lm/vendor/LiteRT-LM"
  echo "  LLVM_PROFILE_FILE=/dev/null ANDROID_NDK_HOME=/opt/homebrew/share/android-ndk \\"
  echo "    bazel build //c:litert-lm --config=android_arm64 --jobs=6"
  echo "  mkdir -p ../../native/aarch64-linux-android"
  echo "  cp bazel-bin/c/liblitert-lm.so ../../native/aarch64-linux-android/"
  exit 1
fi

if [ ! -d "$PROJECT_DIR/src-tauri/gen/android" ]; then
  echo "ERROR: src-tauri/gen/android not found — run 'bun tauri android init' first."
  exit 1
fi

mkdir -p "$JNI_LIBS"

echo "→ Staging required libs into jniLibs/..."
cp "$LIB_DIR/liblitert-lm.so" "$JNI_LIBS/"
cp "$COMPANIONS/libGemmaModelConstraintProvider.so" "$JNI_LIBS/"

if [ "${STAGE_ALL:-0}" = "1" ]; then
  echo "→ Staging optional GPU companions (STAGE_ALL=1)..."
  for lib in libLiteRtGpuAccelerator.so libLiteRtOpenClAccelerator.so \
             libLiteRtTopKOpenClSampler.so libLiteRtTopKWebGpuSampler.so \
             libLiteRtWebGpuAccelerator.so libwebgpu_dawn.so; do
    if [ -f "$COMPANIONS/$lib" ]; then
      cp "$COMPANIONS/$lib" "$JNI_LIBS/"
      echo "  $lib"
    else
      echo "  WARNING: $lib not found in prebuilt — skipping"
    fi
  done
fi

echo "✓ Staged into $JNI_LIBS:"
ls -la "$JNI_LIBS"
