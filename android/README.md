# Future Jarvis Android

Native Java/WebView client over the existing Node bridge. Read [ANDROID_HANDOFF.md](../ANDROID_HANDOFF.md) for setup, current blockers, build and USB installation.

Run `npm run android:build` from the repository root after installing the documented toolchain.

Expected output: `android/app/build/outputs/apk/debug/app-debug.apk`.

The GitHub workflow recipe is `ci/android-debug.yml`; it is not active until placed in `.github/workflows/` by an authorized connection. No APK is currently claimed.
