#!/usr/bin/env bash
# check-toolchain.sh — audits the Android build toolchain WITHOUT installing
# anything. Exits 0 when everything needed for an APK build is present,
# otherwise prints exactly what is missing and exits 1.
set -u
missing=0
need() { # need <name> <cmd...>
  local name="$1"; shift
  if command -v "$1" >/dev/null 2>&1; then
    echo "  [ok]     $name ($(command -v "$1"))"
  else
    echo "  [MISSING] $name"
    missing=1
  fi
}
echo "Android toolchain audit:"
need "java (JDK)"      java
need "javac"           javac
need "gradle"          gradle
need "sdkmanager"      sdkmanager
need "adb"             adb
need "aapt2"           aapt2
need "npx (cordova)"   npx

node -e "console.log('  [ok]     node', process.version)" 2>/dev/null || { echo "  [MISSING] node"; missing=1; }

if [ "$missing" -eq 0 ]; then
  echo "TOOLCHAIN COMPLETE — you can build an APK."
  echo "First command: cd /tmp/my-agent-apk && npm install -g cordova && cordova create my-agent-console && cd my-agent-console && cordova platform add android"
else
  echo "TOOLCHAIN INCOMPLETE — APK build is NOT possible in this environment."
  echo "Install the missing pieces above (Android SDK / openjdk / gradle / cordova),"
  echo "or build the APK on a machine that has them (see ../android/README.md)."
fi
exit "$missing"