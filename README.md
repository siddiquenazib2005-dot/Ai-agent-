# my-agent

A standalone Node.js CLI coding agent (Claude Code / OpenCode style). Point it at a
repo, describe a task, and it plans, edits, runs and tests code through an
LLM tool loop — with hard safety rails around everything it does.

Zero runtime dependencies. Node >= 18 (native `fetch`).

## Setup

```bash
cd my-agent
cp .env.example .env      # then fill in your API key
npm link                  # optional: makes the `my-agent` command global
```

`.env` keys (see `.env.example`): `LLM_API_KEY` (required), `LLM_MODEL`,
`LLM_BASE_URL`, `LLM_TIMEOUT`, `LLM_PROVIDER` (optional), `FAST_MODEL` /
`SMART_MODEL` / `COMPLEX_MODEL` (routing), and optional multi-key
`LLM_KEYS` for authorized-key reliability/failover.

## Usage

```bash
my-agent --repo <project-path> --task "<task description>" [options]
my-agent sessions                      # list saved sessions
my-agent undo --repo <project-path>    # revert the last agent checkpoint
my-agent bridge [--port 8787]          # HTTP/SSE bridge for the Android app
```

| Flag | Meaning |
|---|---|
| `--repo <path>` | Target project folder (required) |
| `--task "<desc>"` | What the agent should do |
| `--mode confirm\|auto` | confirm (default): y/N before destructive actions; auto: no prompts, but dangerous commands still need approval and the blocklist still applies |
| `--plan` | Plan mode: agent shows a plan first, executes only after you type `approve` |
| `--model <name>` | Override automatic model routing |
| `--split` | Force splitting a broad task into sub-tasks (max 6, checkpoint between each) |
| `--skip-tests` | Skip the automatic post-change test run |
| `--resume <id>` | Continue a previous session (`my-agent sessions` to list) |

## What it can do

- **Files**: `read_file`, `list_files`, `search_code` (grep, .gitignore-aware),
  `write_file` (NEW files only), `edit_file` (exact unique-match replacement —
  0 or >1 matches are rejected so edits are always precise).
- **Commands**: `run_command` — **argv-only execution (NO shell)**, cwd locked
  to the repo, 30s hard timeout (whole process group killed, SIGKILL
  escalation), sanitized environment, stdout/stderr/exit-code fed back to the
  model. Shell syntax (pipes, redirects, `&&`, `$()`, backticks, globs) is
  **rejected, not interpreted**.
- **Git**: `git_status`, `git_diff`, `git_commit`, `git_branch` (commit/branch
  require approval).
- **Context**: repository overview (file names + sizes only), plus project
  instructions from `AGENT.md` at the repo root (which may also declare
  `test-command: <cmd>`).
- **Autonomy**: plan mode, broad-task splitting, automatic test run after code
  changes with up to 3 self-fix attempts, session persistence + resume,
  parallel read-only tool calls, streamed output, token/cost tracking
  (`usage.json`), simple-vs-complex model routing.

## Safety model (and its honest limits)

- All file paths are resolved and **must stay inside the target repo**;
  symlink escapes are detected and blocked.
- A command blocklist (`rm -rf`, `sudo`, `dd`, `mkfs`, `> /dev/...`,
  `curl|sh`, `git push --force`) is checked **before confirmation and again
  inside the tool** — those are refused outright, never even offered to you.
- Destructive actions (`write_file`, `edit_file`, `run_command`,
  `git_commit`, `git_branch`) get a diff/preview and an explicit y/N prompt in
  confirm mode (default **N**; EOF = no).
- A metadata-only checkpoint is recorded before work starts (git AND non-git
  repos); it lives in `my-agent/checkpoints.json`, **never inside your repo** —
  no commits, no staging, your branch/index/untracked files are untouched.
  `my-agent undo` reverses **only the file changes the agent itself made**
  (agent edits restored to pre-agent content, agent-created files removed).
  Your own edits, staged changes, untracked files, and git history are never
  touched. If a file the agent wrote was changed afterwards (by you or a
  command), undo **aborts without changing anything** and reports the conflict.
  Known limits: changes made by `run_command` are not reversible; non-git
  repos cannot even detect them (undo warns); file snapshots are capped at
  512 KB — larger edits make undo refuse rather than guess. Binary files
  (containing NUL bytes) are refused by `edit_file` entirely, so their bytes
  and any undo snapshot of them can never be utf8-mangled.
- All events are logged with timestamps to `my-agent/agent.log` (never inside
  the target repo).

**Known limitations (deliberate, see Phases 18 notes):** `run_command` is not
containerized — the blocklist is pattern-based, not a sandbox. Treat
`--mode auto` with care, review the log, and rely on git checkpoints.

## Command security & execution boundary (F2 — read this honestly)

### What the F2 hardening DOES protect against
- **Shell injection**: commands are tokenized into `argv` and executed directly
  via `spawn(program, args)` — there is **no `bash -c` / `sh -c` / `eval`**
  anywhere in the execution path, so shell metacharacters cannot smuggle a
  second command.
- **Unsupported shell syntax**: `;` `&&` `||` `|` `>` `>>` `<` `$VAR` `$()`
  backticks, subshells, globs, process substitution, comments, and multi-line
  commands are **refused with a clear explanation** — never silently run
  through a shell.
- **Blocked programs** (any mode, including auto): shells (`sh`, `bash`, …),
  `sudo`/`su`, `dd`, `mkfs*`, `mount`, `kill`/`pkill`/`xargs`/`env`/`nohup`/
  `setsid`, `chroot`/`unshare`, `find -delete/-exec`, plus the raw-string
  blocklist (`rm -rf`, `curl|sh`, `git push --force`, `> /dev/...`).
- **Restricted programs** (`rm`, `curl`, `wget`, `ssh`, `npx`, `apt`, `chmod`,
  `sed`, `awk`, …) and any command using absolute/`~` paths: **always require
  explicit y/N confirmation, even in `--mode auto`** — the policy overrides
  auto mode.
- **Secret leakage**: executed commands get an **allowlisted environment**
  (PATH, HOME, locale, TERM, …) — `GLM_API_KEY` and every other env secret is
  dropped — and `agent.log`/console output is redacted for KEY/TOKEN/SECRET
  patterns.
- **Repo-local program resolution**: `./script.sh` must realpath-resolve
  inside the repo, be a regular file, and be executable; absolute program
  paths and symlink escapes are refused.

### What the F2 hardening REDUCES (but does not eliminate)
- Arbitrary program execution: unrecognized programs still run after
  confirmation, and "safe-looking" programs can still do surprising things.
- Accidental outside-repo writes: `..` arguments are refused and absolute
  paths force confirmation, but a confirmed program can still write anywhere
  your user can.

### What it DOES NOT guarantee
- **`cwd = repo` is NOT a filesystem sandbox.** A spawned program may read or
  write absolute paths outside the repo, open network connections, and fork
  its own children. The repo boundary is *strongly enforced for the file
  tools* (path resolution + symlink checks) — **not for executed processes**.
- **Command execution is not OS-level isolation.** True containment requires a
  container/chroot/bubblewrap/namespace or MAC policy (e.g. Docker, systemd
  sandboxing, SELinux/AppArmor). my-agent runs commands as ordinary child
  processes of your Node process — **Termux/Linux userland execution is NOT
  equivalent to Docker/container sandboxing**, and this project does not claim
  to be "fully sandboxed".
- The tokenizer/classifier is conservative by design: if execution would be
  ambiguous, the command is **rejected** rather than guessed.

## Architecture

- `index.js` — CLI entry, arg parsing, `undo` / `sessions` / `bridge` subcommands
- `agentLoop.js` — tool schemas + implementations, safety layers, LLM loop
  (SSE streaming), plan/split/test/checkpoint/session logic, usage tracking,
  structured-event emitter (for the bridge)
- `checkpoint.js` — F3 safe checkpoint/undo: metadata-only checkpoints with
  content snapshots of agent-made file changes; verify-then-apply undo that
  never runs `git reset --hard`/`git clean` and never touches user changes
- `commandPolicy.js` — F2 command security: tokenizer (no shell), program
  denylist/restricted/read-only tables, classification, repo-local program
  resolution, environment allowlist, secret redaction
- `llmConfig.js` — config resolution, multi-key manager (health/failover),
  task complexity classification + model routing
- `providers/` — provider abstraction: `baseProvider.js`,
  `openaiCompatibleProvider.js` (fetch-based, no SDK), `futureProviders.js`
- `bridge/` — `server.js` HTTP/SSE bridge; `index.js` re-export. Endpoints:
  `POST /run`, `POST /confirm/:id`, `POST /cancel`, `POST /undo`,
  `GET /events` (SSE), `GET /health`, `GET /sessions`
- `config.js` — zero-dep `.env` loader (legacy GLM keys, still supported)
- `android-app/` — mobile-first dark WebView client (HTML/CSS/JS, no SDK
  needed to develop); `js/bridge.js` is the structured-event client
- `android/` — APK packaging: `README.md` (Cordova / Android SDK recipes),
  `scripts/check-toolchain.sh` (audits without installing), `scripts/build_apk.sh`
- `test/` — regression suites (`f1-timeout.test.mjs`, `f2-command-policy.test.mjs`,
  `f3-undo.test.mjs`, `f4-checkpoint-audit.test.mjs`, `bridge.test.mjs`,
  `android-bridge-client.test.mjs`)
- `agent.log`, `sessions/`, `usage.json`, `checkpoints.json` — runtime state
- `agent.log`, `sessions/`, `usage.json`, `checkpoints.json` — runtime state
  (all inside `my-agent/`, never in your repo)

## Bridge & Android app

```bash
my-agent bridge [--port 8787]     # start the HTTP/SSE bridge
```

The bridge exposes `POST /run`, `POST /confirm/:id`, `POST /cancel`, `POST /undo`,
`GET /events` (Server-Sent Events stream of structured `agent.*` events),
`GET /health`, and `GET /sessions`. The agent pushes progress as structured
events — the client never parses terminal text.

The mobile client lives in `android-app/` (dark, mobile-first, no SDK needed to
develop) and talks to the bridge via `js/bridge.js`. To package it as an APK see
`android/README.md` (Cordova or Android SDK recipe). **Status:** the client +
protocol are tested live (`android-bridge-client.test.mjs`); an APK is NOT built
in this environment (no Android SDK — `android/scripts/check-toolchain.sh`
reports the exact missing pieces) and device runtime is NOT verified.

## Model routing (heuristic — documented honestly)

Tasks are classified by keyword heuristics into SIMPLE / MEDIUM / COMPLEX /
PLANNED and routed to `FAST_MODEL` / `SMART_MODEL` (default) / `COMPLEX_MODEL`.
The decision is logged (`Task complexity: … → … Reason: …`). `--model <name>`
overrides routing. This is a heuristic, not intelligence — it is intentionally
simple and fully configurable via `.env`.

## Multi-key support (optional, authorized keys only)

`LLM_KEYS` (or a structured local config) configures multiple **authorized**
keys for reliability/failover and health monitoring. Features: per-key health
tracking, temporary disable after repeated failure, failover on invalid/unavailable
keys, redacted keys in logs (`sk-1234…abcd`), and no secret exposure. Failover is
for legitimate reliability only — it does not rotate keys to evade rate limits or
terms of service.

## Real API status

- **Mock verified:** all regression suites (F1–F4), bridge, and Android client
  tests run against an in-process OpenAI-compatible mock server.
- **Real API: NOT VERIFIED** in this environment (no API key present). To
  validate against a real provider, set `LLM_API_KEY` (and `LLM_BASE_URL` if not
  the default) in `.env`, then run a task. The code path is identical; only live
  latency/behavior remains unconfirmed here.
  (all inside `my-agent/`, never in your repo)
