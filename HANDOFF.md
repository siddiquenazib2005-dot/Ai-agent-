# HANDOFF.md — my-agent Project

> **For the next AI model / developer picking up this project.**
> Read this fully before making changes.

---

## 1. What is my-agent?

A standalone Node.js CLI coding agent (Claude Code / OpenCode style). Point it at a
repo, describe a task, and it plans, edits, runs and tests code through an LLM tool
loop — with hard safety rails around everything it does.

**Zero runtime dependencies.** Node >= 18 (native `fetch`).

---

## 2. Current Architecture

```
my-agent/
├── index.js                  CLI entry: --repo/--task, undo, sessions, bridge
├── agentLoop.js              Core loop, tools, safety layers, SSE, emitter (~1220 lines)
├── commandPolicy.js          F2: argv-only execution, tokenizer, program tables
├── checkpoint.js             F3: metadata-only checkpoints + verify-then-apply undo
├── llmConfig.js              Config resolution, multi-key manager, task routing
├── providers/                baseProvider, openaiCompatibleProvider (fetch, no SDK)
├── bridge/server.js          HTTP/SSE bridge (zero-dep node:http)
├── android-app/              Mobile WebView client (HTML/CSS/JS, dark, no SDK needed)
├── android/                  APK packaging: README + check-toolchain.sh + build_apk.sh
├── test/                     6 regression suites + bridge + android-client
└── config.js                 Legacy .env loader (still supported)
```

### Key design choices (do NOT undo without understanding why)

- **Argv-only command execution** — no `bash -c`/`sh -c`/`eval` anywhere. Shell syntax is
  *rejected*, not interpreted. This is the F2 security boundary.
- **Metadata-only checkpoints** — `undo` reverses *only* agent-made file changes. User's
  own edits, staged changes, untracked files, and git history are never touched.
- **Structured events** — the bridge emits `agent.*` events; clients never parse terminal text.
- **Provider abstraction** — core depends only on `baseProvider` interface, not any SDK.

---

## 3. All Completed Features

### Core agent (Phases 1–20)
- File tools: `read_file`, `write_file` (new-only), `edit_file` (exact unique match),
  `list_files`, `search_code` (grep, .gitignore-aware)
- Command runner: `run_command` — argv-only, 30s timeout, group-kill, sanitized env
- Git tools: `git_status`, `git_diff`, `git_commit`, `git_branch`
- Context: repo overview (names+sizes) + `AGENT.md` project instructions
- Autonomy: plan mode, broad-task splitting (max 6), auto test-fix loop (3 attempts)
- Sessions + `--resume`, parallel read-only calls, SSE streaming, token tracking
- Model routing: SIMPLE/MEDIUM/COMPLEX/PLANNED heuristic

### Security hardening (F1–F4) — ALL FIXED & VERIFIED
| Finding | Problem | Fix |
|---|---|---|
| F1 CRITICAL | `spawn({timeout})` ignored → commands ran forever | Explicit timer + SIGTERM→SIGKILL group kill |
| F2 CRITICAL | Full shell (`bash -c cmd`) → injection | Argv-only execution, tokenizer rejects shell syntax |
| F3 HIGH | `git reset --hard` destroyed user work | Metadata-only checkpoints, verify-then-apply undo |
| F4 HIGH | `git add -A` swept user changes | Eliminated by F3 redesign + binary guard |

### Integration (this pass)
- Provider abstraction (`providers/`) — fetch-based, no SDK
- Multi-key support — health tracking, failover, redacted logs
- Bridge — HTTP/SSE server (`POST /run`, `/confirm`, `/undo`, `GET /events`)
- Android app — dark mobile WebView client (8 screens)
- Android packaging — APK build scripts + toolchain check

---

## 4. Test Results

**150 regression tests, 0 failures:**

| Suite | Result |
## 5. Known Limitations (honest — do NOT claim otherwise)

- **Real API: NOT verified** — all tests use an in-process mock. Live provider
  latency/behavior is unconfirmed. Set `LLM_API_KEY` in `.env` to validate.
- **run_command is not containerized** — the blocklist is pattern-based, not a sandbox.
  A confirmed program can still read/write absolute paths, open network connections,
  and fork children.
- **run_command file changes are not reversible** by undo (warned in output).
- **Windows limitation**: process-group kill falls back to `child.kill()` (grandchildren
  may survive).
- **Routing is a heuristic**, not intelligence.

---

## 6. Real API Status

**NOT VERIFIED.** No API key present in this environment. To test against a real
provider (APInex, OpenAI, Zhipu, etc.):

1. Set in `.env`:
   ```
   LLM_API_KEY=<your-key>
   LLM_BASE_URL=<provider-url>   # if not default
   LLM_MODEL=<model-name>
   ```
2. Run: `my-agent --repo <path> --task "describe task" --mode confirm`

---

## 7. Android APK Status

**NOT built.** No Android SDK in this environment (`java`, `gradle`, `adb`,
`sdkmanager`, `aapt2` all missing — verified by `android/scripts/check-toolchain.sh`).

The client app in `android-app/` is complete and its protocol is tested live
(`test/android-bridge-client.test.mjs`, 15/15). To build an APK see
`android/README.md` (Cordova or Android SDK recipe).

---

## 8. Exact Next Steps (pick up here)

### Immediate (unblocked)
1. **Real API test** — provide a key, run a real task, confirm live behavior
2. **Calculator website test** — create a real test repo, verify full flow:
   thinking → search → code → edit → commands → tests → result

### Short-term (need environment)
3. **Android env setup** — install JDK 17+, Android SDK, Gradle
4. **APK build** — `bash android/scripts/build_apk.sh` (after env is ready)

### Medium-term
5. **Codex-style UI polish** — streaming code, live terminal, thinking state,
   file changes, diff viewer, task progress, plan/execute modes, cancel, resume
6. **JARVIS integration** — bridge the agent into the JARVIS system via the
   structured-event contract (`agent.*` events over SSE)

---

## 9. Critical Safety Rules (never break these)

- **NEVER** add `bash -c`/`sh -c`/`eval` back into command execution
- **NEVER** use `git reset --hard` or `git clean` in checkpoint/undo
- **NEVER** push API keys, tokens, or secrets to git
- **NEVER** use `git push --force`
- **NEVER** claim the APK is built unless an actual `.apk` file exists
- **NEVER** claim real-API verification without a live test
- **ALWAYS** run the full test suite before committing
- **ALWAYS** keep `.env`, `sessions/`, `usage.json`, `checkpoints.json`, `agent.log`
  out of git (already in `.gitignore`)

---

## 10. Quick Commands

```bash
# Run a task
my-agent --repo <path> --task "Fix the bug" --mode confirm

# Start the bridge (for Android app)
my-agent bridge --port 8787

# List sessions
my-agent sessions

# Undo last checkpoint
my-agent undo --repo <path>

# Run all regression tests
for f in test/f*.test.mjs; do node "$f"; done
node test/bridge.test.mjs
node test/android-bridge-client.test.mjs

# Check Android toolchain
bash android/scripts/check-toolchain.sh
```

---

*Last updated: 2026-09-08 · Commit: see `git log -1`*
|---|---|
| F1 command timeout | 7/7 |
| F2 command security | 23/23 |
| F3 safe undo | 37/37 |
| F4 checkpoint audit | 46/46 |
| Path-safety / blocklist | 18/18 |
| Phases 4–19 unit | 19/19 |

Plus: bridge (24/24), Android client (15/15), E2E (32/32), dummy-repo (7/7),
confirm-mode (5/5), auto-safety (4/4).

Run tests with: `node test/<suite>.test.mjs`