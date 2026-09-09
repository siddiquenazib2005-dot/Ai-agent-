#!/usr/bin/env bash
set -u
missing=0
for tool in java javac gradle; do
  if command -v "$tool" >/dev/null 2>&1; then echo "[OK] $tool"; else echo "[MISSING] $tool"; missing=1; fi
done
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk" ]]; then echo '[MISSING] ANDROID_HOME or ANDROID_SDK_ROOT'; missing=1
else
  for item in platforms/android-35/android.jar build-tools/35.0.0/aapt2 build-tools/35.0.0/apksigner; do
    if [[ -f "$sdk/$item" ]]; then echo "[OK] $item"; else echo "[MISSING] $item"; missing=1; fi
  done
fi
if [[ "$missing" == 0 ]]; then echo 'Tooling located. Required versions: JDK 17, Gradle 8.9, Android platform 35/build-tools 35.0.0.'
else echo 'No APK build possible until the listed prerequisites are installed.'; fi
exit "$missing"
