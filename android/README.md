# Android packaging for my-agent

This directory prepares the my-agent mobile client for Android packaging.

## Architecture (documented decision)

```
Android App (mobile-first WebView client in ../android-app)
        │  HTML/CSS/JS — no SDK needed to develop
        ▼
my-agent bridge (HTTP + SSE)  →  `my-agent bridge [--port 8787]`
        ▼
my-agent core (CLI agent, unchanged)
```

The mobile client is a self-contained WebView web app (`../android-app/`) that
consumes the bridge's structured events (`agent.*`) and HTTP endpoints. The
CLI remains the core agent; the app is an additional interface.

## Validation status — honest

- **BUILD VERIFIED (client + bridge + protocol):** the `js/bridge.js` client
  protocol is tested live against the real bridge in
  `test/android-bridge-client.test.mjs`. All 24 bridge tests + this client
  test pass.
- **DEVICE RUNTIME NOT VERIFIED:** this environment has **no Android SDK**
  (no `java`, `gradle`, `adb`, `aapt2`, `kotlinc` — checked at build time by
  `scripts/check-toolchain.sh`). An APK could not be compiled here, and no
  emulator/device run was performed. No APK file exists; none is claimed.

## Build requirements (when an Android toolchain is available)

- Java (JDK 17+) and Android SDK command line tools (`sdkmanager`, `adb`)
- OR Android Studio
- OR Flutter SDK (if you prefer the Flutter route — not provided here)

## Recommended packaging: Cordova (WebView wrapper)

```bash
npm install -g cordova
mkdir -p /tmp/my-agent-apk && cd /tmp/my-agent-apk
cordova create my-agent-console && cd my-agent-console
cordova platform add android
rm -rf www && cp -r /root/my-agent/android-app www
# optionally: expose the bridge URL in js/app.js state.baseUrl or the Settings screen

# then, with Android SDK on PATH:
cordova build android            # debug APK
cordova build android --release  # release APK (needs signing config)

# artifact: platforms/android/build/outputs/apk/debug/my-agent-console-debug.apk
```

## Alternative: Android SDK WebView (no Cordova)

1. `sdkmanager "android-ndk;_latest_" "system;android_arch"` etc. per your SDK.
2. Create a `WebView` in a minimal Activity pointing at the app folder
   (`app:///android-app/index.html`) or serve it on the device and point the
   WebView at `http://127.0.0.1:8787/app/index.html`.
3. Build with `gradle assembleDebug` (APK at `build/outputs/apk/debug/`).

## Blockers in THIS environment (do not fake)

- No `java`/`javac`, no `gradle`, no Android SDK, no `adb` — verified by
  `scripts/check-toolchain.sh`, which exits non-zero and prints exactly what
  is missing.
- Expected artifact (once toolchain is present): a debug `.apk` at
  `platforms/android/build/outputs/apk/debug/`, size on the order of 5–40 MB
  (WebView app + Cordova runtime).

## Bridge note

The app talks to `my-agent bridge` on the host. For a phone, the bridge must
be reachable on the LAN (start with `my-agent bridge` on the host; the app's
Settings screen lets you point at `http://<host-ip>:8787`). The bridge is
intended for trusted networks only (no authentication built in).