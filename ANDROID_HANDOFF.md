# Future Jarvis Android continuation

## Current delivery status

Source changes were pushed to **android/test-apk-20260909**, not merged into main. The secure GitHub connection accepted ordinary source commits but rejected adding `.github/workflows/android-debug.yml` with **403 Resource not accessible by integration**. No workflow was activated; no APK was compiled or published. Keep main unchanged until a build is verified.

A reviewed core change is transported as `scripts/core-integration.patch`. `npm run setup:core` applies it safely once after a Git check; `npm test`, `npm start`, `npm run bridge` and `npm run android:build` invoke setup automatically. It refuses conflicts rather than overwriting another version. Applied changes are visible in git status and should be committed after tests. Until setup runs, direct `node index.js` calls are not the completed integration. The separately delivered source ZIP already includes the applied core.

## Architecture and fixes

Retained the dependency-free Node execution engine, provider abstraction, command policy, sessions and checkpoint architecture. Added a real Java/Gradle Android application hosting the bundled web client. Node, Git, filesystem and provider work run on a separately configured host, not inside the APK.

Fixed UI startup/scope failure; phone plan approval instead of terminal stdin; leaking SSE handles; full-response provider timeout; provider/model selection; UTF-8 streaming; strict requests/approval validation; provider cancellation and pending-approval release; bounded terminal output with exit/duration metadata; authenticated bridge/origin checks; reconnect snapshots; changed-file previews; and rapid consecutive approval races.

Original dark UI: Home/task composer, Agent timeline, live model text, tool approvals, Files/preview, Terminal, Sessions/continuation and Settings. Animations are event-driven/indeterminate, not fake percentages. No proprietary logos or UI assets copied.

## Tests performed locally

All six supplied suites passed and exited normally: Android client 15, bridge 24, timeout 7, policy 23, undo 37, checkpoint audit 46 assertions. Initially both bridge suites hung after passing assertions, and one audit assertion referenced the old developer's directory.

Added 17 mobile integration checks: auth, foreign origins, invalid input, HTTP plan approval, concurrent runs/undo guard, model override, Unicode streaming, previews, reconnect, cancellation, stalled-body timeout, provider-error redaction, regex search, multi-key config, request-size cap, connection cleanup.

Chromium mobile flow passed startup/provider loading, plan/tool approvals, actual host file creation, command output, preview, sessions, no horizontal overflow and no JavaScript runtime errors. All provider tests used explicitly labeled local mocks. Live providers and Android devices have not been verified.

## APK build requirements and exact output

JDK **17**, Gradle **8.9**, Android SDK platform **35**, build-tools **35.0.0**. Node **20.3+**; CI uses 24. Set ANDROID_HOME. Local sandbox lacked javac, Gradle and Android SDK; download DNS was blocked. The local build script exited with missing prerequisites, not success.

```sh
npm test
sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools"
sdkmanager --licenses
npm run android:build
```

Expected output: **android/app/build/outputs/apk/debug/app-debug.apk**. Package: **dev.futurejarvis.agent**. Minimum Android **8.0 / API 26**; target API 35. Update Android System WebView/Chrome. Debug signing is not production signing.

## Enable the GitHub build

Using an account or secure connection permitted to write workflows, copy `android/ci/android-debug.yml` to `.github/workflows/android-debug.yml` on the test branch and commit. The file currently in `android/ci/` is a recipe, not an active workflow. Once activated, it applies/tests/commits the core patch, installs tooling, builds/lints and verifies the debug signature, then uploads an APK artifact. Download only from a successful Actions run. A workflow being added does not prove it ran successfully.

## Install and test on your Android phone

After an APK is successfully built, enable USB debugging and connect your phone to the host. Approve its debugging prompt:

```sh
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8787 tcp:8787
```

If downloading an Actions artifact ZIP, extract the APK first and substitute its path. Alternatively open the APK on your phone and allow installation from that file app when prompted. USB port mapping is still needed for a computer-hosted bridge. A different old debug signature may require uninstalling the old app first; back up preferences because uninstall clears them.

On the host configure provider credentials in ignored `.env`, then `npm run bridge`. Create an existing disposable project folder. On the phone connect to `http://127.0.0.1:8787`, enter the project's **absolute host path**, choose provider/model and Plan first, and ask `Create a minimal index.html greeting page`. Approve/reject tools; check the real host file, Files preview, terminal exit codes and streamed response. Test rejection, cancellation, reconnect, continuation and undo. Cancel does not automatically roll back files.

## Provider configuration

Keep keys on the host, never in chat or source control. Set `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, optional authorized backup `LLM_KEYS`. APINEX uses the existing adapter only if its endpoint supports chat completions/tool calls; no endpoint/model was guessed.

Multiple ignored `providers.json` profiles can reference host environment names:

```json
[
  {"id":"primary","name":"openai-compatible","baseUrl":"https://your-provider.example/v1","model":"your-model","apiKeyEnv":"PRIMARY_API_KEY","keyEnvs":["PRIMARY_BACKUP_KEY"],"priority":0},
  {"id":"secondary","name":"openai-compatible","baseUrl":"https://other-provider.example/v1","model":"other-model","apiKeyEnv":"SECONDARY_API_KEY","priority":1}
]
```

Replace example domains/models and set the referenced environment values locally. Reconnect to refresh profiles. Same-provider authorized-key auth-error failover remains; 429 errors are surfaced, not rotated around. Automatic cross-provider fallback and live-provider health probes are not implemented. Bridge health checks configuration only.

## Remaining safety/runtime limits

- Revoke any token shared in chat. No supplied token was copied into source, logs or build files.
- Use loopback + USB reverse or authenticated HTTPS. Remote HTTP is rejected by the client. Remote binding requires a 32+ character BRIDGE_TOKEN and explicit allowed origins. A token does not encrypt HTTP.
- Phone stores non-secret preferences only; optional bridge token is in memory. No native JavaScript execution interface; file/content access disabled; asset-only top-level navigation; cleartext limited to localhost.
- Node command execution is not OS-sandboxed. Use a dedicated environment and confirm mode. Existing explicit git_commit can stage all target-project changes; review its preview. Undo does not reverse arbitrary command effects.
- Cancellation may wait up to the existing 30-second limit for an executing command. Reconnect snapshots do not replay missed deltas. Rotation/process death can lose token/timeline.
- Previews are latest-task file-tool changes only, text up to 256 KB; sensitive filenames/binary files refused. Command-created files are not indexed. Terminal output arrives on command completion.
- Physical-device install/runtime, keyboard/insets, background lifecycle, performance and real provider behavior remain untested. A successful APK compilation alone will not verify these.
