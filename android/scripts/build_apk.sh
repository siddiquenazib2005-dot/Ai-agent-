#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bash "$ROOT/android/scripts/check-toolchain.sh"
cd "$ROOT/android"
gradle --no-daemon :app:assembleDebug :app:lintDebug
APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
test -s "$APK"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT}}"
"$SDK/build-tools/35.0.0/apksigner" verify "$APK"
echo "APK BUILD AND SIGNATURE VERIFIED: $APK"
echo 'Device install/launch and live-provider execution still require testing.'
