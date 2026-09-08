#!/usr/bin/env bash
# build_apk.sh — builds a debug APK when a full Android toolchain exists.
# NEVER fakes success: verifies the toolchain first, then verifies the APK
# file exists at the end. Exits 1 with the exact blocker otherwise.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/android-app"
OUT_DIR="/tmp/my-agent-apk"

if ! bash "$SCRIPT_DIR/check-toolchain.sh" >/dev/null 2>&1; then
  echo "BLOCKER: Android toolchain missing — run scripts/check-toolchain.sh for details."
  echo "No APK was built (honest). The app itself is build-ready in $APP_DIR"
  echo "including a cordova build recipe in $(dirname "$SCRIPT_DIR")/README.md"
  exit 1
fi

echo "Build directory: $OUT_DIR"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR"
if [ ! -d my-agent-console ]; then
  npx cordova create my-agent-console --template cordova-app-template
fi
cd my-agent-console
npx cordova platform add android || true
rm -rf www
cp -r "$APP_DIR" www

echo "Building debug APK…"
npx cordova build android >/tmp/apk-build.log 2>&1 || { tail -40 /tmp/apk-build.log; echo "BUILD FAILED"; exit 1; }

APK="$(find platforms/android/build/outputs/apk -name '*.apk' 2>/dev/null | head -1)"
if [ -z "$APK" ] || [ ! -f "$APK" ]; then
  echo "BUILD REPORTED SUCCESS BUT NO APK FILE EXISTS — not claiming one."
  exit 1
fi
echo "APK OK: $APK ($(du -h "$APK" | cut -f1))"