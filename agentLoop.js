/**
 * agentLoop.js — the core of my-agent: a tool-calling agent loop over an
 * OpenAI-compatible LLM API (GLM 5.3 primary / fast model for simple tasks).
 *
 * Capabilities (Phases 2–19):
 *   - Repo-scoped file tools: read_file, write_file (NEW files only),
 *     edit_file (exact single-match replace), list_files, search_code
 *   - run_command: F2 argv-only execution (NO shell), structured command
 *     policy (SAFE_READONLY/…/RESTRICTED/BLOCKED), 30s timeout, cwd locked
 *     to the repo, sanitized environment (no API keys)
 *   - Git tools: git_status, git_diff, git_commit, git_branch
 *   - Safety: blocklist, y/N confirmations with diff previews, first-time
 *     command warnings in auto mode, timestamped agent.log (my-agent dir only)
 *   - Context management: repo tree summary (names+sizes) + AGENT.md
 *   - Plan mode (--plan), broad-task splitting, test-run fix loop (max 3)
 *   - Git checkpoint before work + `my-agent undo`
 *   - Session persistence (--resume), parallel read-only tool calls,
 *     streaming output, token tracking, model routing, retry caps
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadLlmConfig, KeyManager, routeTask } from './llmConfig.js';
import { redactKey } from './providers/baseProvider.js';
// Legacy-compatible routing re-exports (existing tests import from here).
export { chooseModel, classifyTask, routeTask } from './llmConfig.js';
import { beginCheckpoint, recordAgentWrite, undoCheckpoint } from './checkpoint.js';
import {
  CLASSIFICATION,
  checkBlocklist,
  parseAndClassify,
  resolveProgramPath,
  buildCommandEnvironment,
  redactSecrets,
} from './commandPolicy.js';

// F2: the blocklist now lives in commandPolicy.js; re-exported for
// backward compatibility with existing tests and the tool executor.
export { checkBlocklist } from './commandPolicy.js';


const MAX_ITERATIONS = 20;            // per loop segment (safety guard)
const LOG_VALUE_LIMIT = 80;           // truncate long args in console logs
const COMMAND_TIMEOUT_MS = 30_000;    // run_command hard timeout (F1: enforced manually — spawn has no timeout option)
const COMMAND_KILL_GRACE_MS = 2_000;  // F1: SIGTERM -> SIGKILL escalation grace period
const COMMAND_OUTPUT_LIMIT = 10_000;  // stdout/stderr chars sent to the LLM
const TOOL_OUTPUT_LIMIT = 20_000;     // cap on any tool result sent to the LLM
const MAX_IDENTICAL_TOOL_RETRIES = 3; // Phase 17: same failing call cap
const MAX_TEST_FIX_RETRIES = 3;       // Phase 9
const ALWAYS_IGNORED = new Set(['node_modules', '.git']);

const MY_AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(MY_AGENT_DIR, 'agent.log'); // never in target repo
const SESSIONS_DIR = path.join(MY_AGENT_DIR, 'sessions');
const USAGE_FILE = path.join(MY_AGENT_DIR, 'usage.json');

// F2: BLOCKED_PATTERNS and checkBlocklist moved to commandPolicy.js
// (re-exported above). See that module for the full command security policy.

/** Appends a timestamped event line to <my-agent>/agent.log. */
export function logEvent(event, detail = '') {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${event}] ${detail}\n`);
  } catch {
    /* logging must never crash the agent */
  }
}

// ---------------------------------------------------------------------------
// Path safety — every tool path MUST resolve inside the repo root
// ---------------------------------------------------------------------------

export function safeResolve(repoRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new Error('Path argument is required.');
  }
  const root = path.resolve(repoRoot);
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Access denied: "${relativePath}" resolves outside the repo (${root}).`);
  }
  return abs;
}

/** Catches symlink escapes via the deepest existing ancestor. */
export function assertInsideRepo(repoRoot, absPath) {
  const root = path.resolve(repoRoot);
  let probe = absPath;
  while (probe !== path.dirname(probe)) {
    if (fs.existsSync(probe)) {
      const real = fs.realpathSync(probe);
      if (real !== root && !real.startsWith(root + path.sep)) {
        throw new Error(`Access denied: path resolves (via symlink) outside the repo (${root}).`);
      }
      return;
    }
    probe = path.dirname(probe);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function capText(s, limit) {
  return s.length > limit ? `${s.slice(0, limit)}\n...(truncated, ${s.length} chars total)` : s;
}

function truncateForLog(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > LOG_VALUE_LIMIT ? `${str.slice(0, LOG_VALUE_LIMIT)}... (${str.length} chars)` : str;
}

/** Rough token estimate when the API does not report usage (Phase 15). */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ---------------------------------------------------------------------------
// Best-effort .gitignore support (Phases 5 & 6)
// Supports: comments, dir patterns ("build/"), "*", "?", "**", negation "!".
// ---------------------------------------------------------------------------

function globToRegExp(pattern, anchored, dirOnly) {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        src += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else {
      src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const head = anchored ? '^' : '(?:^|/)';
  if (dirOnly) return new RegExp(`${head}${src}(?:/.*)?$`);
  return new RegExp(`${head}${src}$`);
}

export function loadIgnoreRules(repoRoot) {
  const rules = [];
  const igFile = path.join(repoRoot, '.gitignore');
  if (fs.existsSync(igFile)) {
    for (const rawLine of fs.readFileSync(igFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line === '!') continue;
      const negate = line.startsWith('!');
      let pattern = negate ? line.slice(1) : line;
      const dirOnly = pattern.endsWith('/');
      pattern = pattern.replace(/\/+$/, '');
      if (!pattern) continue;
      const anchored = pattern.includes('/');
      rules.push({ re: globToRegExp(pattern, anchored, dirOnly), negate });
    }
  }
  return rules;
}

function isIgnored(relPath, rules) {
  if (relPath.split('/').some((seg) => ALWAYS_IGNORED.has(seg))) return true;
  let ignored = false;
  for (const { re, negate } of rules) {
    if (re.test(relPath)) ignored = !negate; // last matching rule wins
  }
  return ignored;
}

/** Recursively collects repo-relative FILE paths, gitignore-aware. */
export function walkRepo(repoRoot, { maxEntries = Infinity } = {}) {
  const rules = loadIgnoreRules(repoRoot);
  const out = [];
  const walk = (absDir, relBase) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (isIgnored(rel, rules)) continue;
      if (entry.isDirectory()) walk(path.join(absDir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(repoRoot, '');
  return out;
}

// ---------------------------------------------------------------------------
// Tool implementations (all strictly scoped to the repo).
// `state` carries cross-call info: seenCommands, failCounts, wroteAny.
// ---------------------------------------------------------------------------

export function createToolImplementations(repoRoot, state, { commandTimeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const gitRun = (args) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 15_000 }).trim();
    } catch (err) {
      throw new Error(`git ${args[0]} failed: ${err.stderr || err.message}`);
    }
  };

  return {
    read_file({ path: relPath }) {
      const abs = safeResolve(repoRoot, relPath);
      assertInsideRepo(repoRoot, abs);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw new Error(`File not found: ${relPath}`);
      }
      const content = fs.readFileSync(abs, 'utf8');
      return content === '' ? '(file is empty)' : capText(content, TOOL_OUTPUT_LIMIT);
    },

    /**
     * Phase 4: write_file creates NEW files only. Modifying an existing
     * file must go through edit_file (exact single-match replacement).
     */
    write_file({ path: relPath, content }) {
      if (typeof content !== 'string') throw new Error('"content" (string) is required.');
      const abs = safeResolve(repoRoot, relPath);
      assertInsideRepo(repoRoot, abs);
      if (fs.existsSync(abs)) {
        throw new Error(
          `"${relPath}" already exists. write_file only creates NEW files — use edit_file to change an existing file.`
        );
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      state.wroteAny = true;
      // F3: record the agent-created file so undo can remove exactly it.
      if (state.activeCheckpoint) recordAgentWrite(state.activeCheckpoint, relPath, { op: 'create', after: content });
      state.emit?.('agent.file.changed', { path: relPath, op: 'create' });
      return `Created ${relPath} (${Buffer.byteLength(content, 'utf8')} bytes).`;
    },

    /** Phase 4: str_replace-style edit. old_text must match EXACTLY once. */
    edit_file({ path: relPath, old_text, new_text }) {
      if (typeof old_text !== 'string' || old_text === '') {
        throw new Error('"old_text" (non-empty string) is required.');
      }
      if (typeof new_text !== 'string') throw new Error('"new_text" (string) is required.');
      if (old_text === new_text) throw new Error('old_text and new_text are identical — nothing to change.');
      const abs = safeResolve(repoRoot, relPath);
      assertInsideRepo(repoRoot, abs);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw new Error(`File not found: ${relPath}`);
      }
      // F4 snapshot-integrity guard: a utf8 read would MANGLE binary data
      // (and the undo snapshot with it). Refuse instead of corrupting.
      const rawBuf = fs.readFileSync(abs);
      if (rawBuf.includes(0)) {
        throw new Error(
          `"${relPath}" appears to be a binary file (contains NUL bytes) — edit_file only supports text files. Refusing to avoid corrupting it.`
        );
      }
      const content = rawBuf.toString('utf8');
      const occurrences = content.split(old_text).length - 1;
      if (occurrences === 0) {
        throw new Error(
          `old_text not found in ${relPath} (it must match EXACTLY, including whitespace/indentation). Use read_file and copy the text precisely.`
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `old_text matches ${occurrences} places in ${relPath} — it must be UNIQUE. Include more surrounding lines to disambiguate.`
        );
      }
      const updated = content.replace(old_text, new_text);
      fs.writeFileSync(abs, updated, 'utf8');
      state.wroteAny = true;
      // F3: record the pre-agent content (earliest wins) + latest afterHash
      // so undo can restore exactly this file and detect later conflicts.
      if (state.activeCheckpoint) recordAgentWrite(state.activeCheckpoint, relPath, { op: 'edit', before: content, after: updated });
      state.emit?.('agent.file.changed', { path: relPath, op: 'edit' });
      return `Edited ${relPath}: replaced ${old_text.length} chars with ${new_text.length} chars (1 exact match).`;
    },

    list_files({ dir = '.' } = {}) {
      const relDir = dir === '.' || dir === '' ? '' : String(dir).replace(/\/+$/, '');
      const absDir = safeResolve(repoRoot, relDir || '.');
      assertInsideRepo(repoRoot, absDir);
      if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
        throw new Error(`"${dir}" is not a directory inside the repo.`);
      }
      const all = walkRepo(repoRoot, { maxEntries: 2000 });
      const filtered = relDir ? all.filter((f) => f === relDir || f.startsWith(`${relDir}/`)) : all;
      const capped = filtered.slice(0, 500);
      return capped.length ? capped.join('\n') : `(no files found in "${dir}")`;
    },

    /**
     * Phase 5: grep-like search so the agent can locate code without
     * reading whole files. Respects .gitignore (best effort).
     */
    search_code({ query, regex = false, ignore_case = true } = {}) {
      if (typeof query !== 'string' || !query.trim()) throw new Error('"query" (string) is required.');
      let matcher;
      if (regex) {
        matcher = new RegExp(query, ignore_case ? 'i' : '');
      } else {
        const q = ignore_case ? query.toLowerCase() : query;
        matcher = (line) => (ignore_case ? line.toLowerCase() : line).includes(q);
      }
      const hits = [];
      for (const rel of walkRepo(repoRoot, { maxEntries: 2000 })) {
        if (hits.length >= 100) break;
        const abs = path.join(repoRoot, rel);
        let stat;
        try { stat = fs.statSync(abs); } catch { continue; }
        if (stat.size > 512 * 1024) continue;
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        if (text.includes('\0')) continue; // skip binary-looking files
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matcher(lines[i])) {
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= 100) break;
          }
        }
      }
      return hits.length ? hits.join('\n') : `(no matches for "${truncateForLog(query)}")`;
    },

    run_command({ cmd }) {
      if (typeof cmd !== 'string' || !cmd.trim()) throw new Error('"cmd" (string) is required.');

      // F2 defense in depth: re-check policy inside the tool itself.
      // (The tool executor already gated confirmation/blocking on this.)
      const verdict = parseAndClassify(cmd);
      if (!verdict.ok) {
        throw new Error(`REFUSED (command policy): ${verdict.error} Commands run WITHOUT a shell, so only a single program with plain arguments is supported.`);
      }
      if (verdict.classification.cls === CLASSIFICATION.BLOCKED) {
        throw new Error(`REFUSED (command policy): ${verdict.classification.reason}. This agent will not run it.`);
      }

      // F2: resolve the program to a concrete executable path — NO bash/sh.
      const cmdEnv = buildCommandEnvironment();
      let programPath;
      try {
        programPath = resolveProgramPath(verdict.argv[0], repoRoot, cmdEnv);
      } catch (err) {
        throw new Error(`REFUSED (command policy): ${err.message}`);
      }

      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(programPath, verdict.argv.slice(1), {
            cwd: repoRoot, // always starts inside the target repo
            env: cmdEnv,   // F2: sanitized environment (no API keys/secrets)
            // F1: own process group so the WHOLE tree (program + descendants)
            // can be killed on timeout. POSIX only; on Windows killTree falls
            // back to child.kill() (grandchildren may survive there).
            detached: process.platform !== 'win32',
          });
        } catch (err) {
          reject(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let escalated = false;
        let timeoutTimer = null;
        let escalationTimer = null;

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });

        /** Kills the child's whole process group; falls back to the child alone. */
        const killTree = (signal) => {
          try {
            process.kill(-child.pid, signal); // negative pid = process group
          } catch {
            try { child.kill(signal); } catch { /* already gone */ }
          }
        };

        /** Idempotent cleanup: stop the timers once the child is done. */
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (escalationTimer) clearTimeout(escalationTimer);
        };

        // F1: explicit timer (spawn's timeout option is NOT supported and was
        // silently ignored). SIGTERM first, then SIGKILL after a grace period.
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          killTree('SIGTERM');
          escalationTimer = setTimeout(() => {
            escalated = true;
            killTree('SIGKILL');
          }, COMMAND_KILL_GRACE_MS);
          escalationTimer.unref?.();
        }, commandTimeoutMs);

        child.on('error', (err) => {
          finish();
          reject(err);
        });

        child.on('close', (code, signal) => {
          finish();
          let text;
          if (timedOut) {
            text =
              `status: timeout\n` +
              `timeout_ms: ${commandTimeoutMs}\n` +
              `(timed out after ${commandTimeoutMs}ms — SIGTERM sent to the process tree` +
              `${escalated ? ', then SIGKILL' : ''}; exit info: code=${code === null ? 'none' : code}, signal=${signal ?? 'none'})\n` +
              `--- stdout ---\n${capText(stdout, COMMAND_OUTPUT_LIMIT).trim() || '(empty)'}` +
              `\n--- stderr ---\n${capText(stderr, COMMAND_OUTPUT_LIMIT).trim() || '(empty)'}`;
          } else {
            text = `exit code: ${code === null ? 'none' : code}`;
            if (signal) {
              text += ` (killed by signal: ${signal})`;
            }
            text += `\n--- stdout ---\n${capText(stdout, COMMAND_OUTPUT_LIMIT).trim() || '(empty)'}` +
              `\n--- stderr ---\n${capText(stderr, COMMAND_OUTPUT_LIMIT).trim() || '(empty)'}`;
          }
          resolve(text);
          state.emit?.('agent.command.output', { cmd: redactSecrets(String(cmd)), result: truncateForLog(redactSecrets(String(text)), 4000) });
        });
      });
    },

    // Phase 11: git tools -----------------------------------------------------
    git_status() {
      const out = gitRun(['status', '--short', '--branch']);
      return capText(out || '(clean working tree)', 5000);
    },

    git_diff() {
      const out = gitRun(['diff', 'HEAD']);
      return out ? capText(out, TOOL_OUTPUT_LIMIT) : '(no changes vs HEAD)';
    },

    git_commit({ message }) {
      if (typeof message !== 'string' || !message.trim()) throw new Error('"message" (string) is required.');
      const status = gitRun(['status', '--porcelain']);
      if (!status.trim()) return '(nothing to commit — working tree clean)';
      gitRun(['add', '-A']);
      gitRun(['-c', 'user.name=my-agent', '-c', 'user.email=agent@localhost', 'commit', '-m', message]);
      const sha = gitRun(['rev-parse', '--short', 'HEAD']);
      state.committed = true;
      return `Committed ${sha}: ${message}`;
    },

    git_branch({ name }) {
      if (typeof name !== 'string' || !/^[A-Za-z0-9._\-/]+$/.test(name)) {
        throw new Error('"name" must be a valid branch name (letters, digits, . _ - /).');
      }
      let exists = false;
      try { gitRun(['rev-parse', '--verify', name]); exists = true; } catch { exists = false; }
      if (exists) throw new Error(`Branch "${name}" already exists.`);
      gitRun(['checkout', '-b', name]);
      return `Created and switched to branch "${name}".`;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool classification, confirmation layer (Phases 3/4/11/18)
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search_code', 'git_status', 'git_diff']);
const DESTRUCTIVE_TOOLS = new Set(['write_file', 'edit_file', 'run_command', 'git_commit', 'git_branch']);

/** Compact LCS-based line diff, capped. */
function lineDiff(oldText, newText, maxChangedLines = 40) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length + b.length > 4000) {
    return [`(diff skipped: content too large — ${a.length} old + ${b.length} new lines)`];
  }
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  if (out.length > maxChangedLines) {
    return [...out.slice(0, maxChangedLines), `... (${out.length - maxChangedLines} more changed lines)`];
  }
  return out;
}

/** Human-readable preview of a destructive action, shown before confirmation. */
function buildToolPreview(repoRoot, name, args) {
  if (name === 'write_file') {
    const abs = safeResolve(repoRoot, args.path);
    assertInsideRepo(repoRoot, abs);
    if (fs.existsSync(abs)) {
      return `NOTE: "${args.path}" already exists — write_file only creates NEW files, so this call will be REFUSED. The model must use edit_file instead.`;
    }
    const lines = String(args.content ?? '').split('\n').slice(0, 40).map((l) => `+ ${l}`);
    return `CREATE new file: ${args.path}\n${lines.join('\n')}`;
  }
  if (name === 'edit_file') {
    const abs = safeResolve(repoRoot, args.path);
    assertInsideRepo(repoRoot, abs);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${args.path}`);
    return `EDIT file: ${args.path}\n${lineDiff(String(args.old_text ?? ''), String(args.new_text ?? '')).join('\n')}`;
  }
  if (name === 'run_command') {
    return `RUN COMMAND (cwd: ${repoRoot}, timeout: ${COMMAND_TIMEOUT_MS / 1000}s):\n  ${args.cmd}`;
  }
  if (name === 'git_commit') {
    let status = '';
    try {
      status = execFileSync('git', ['status', '--short'], { cwd: repoRoot, encoding: 'utf8', timeout: 15_000 });
    } catch { status = '(git status unavailable)'; }
    return `GIT COMMIT\nmessage: ${args.message}\nchanges to commit:\n${capText(status.trim() || '(none)', 1500)}`;
  }
  if (name === 'git_branch') {
    return `GIT BRANCH — create and switch to: ${args.name}`;
  }
  return JSON.stringify(args);
}

/**
 * Returns an async confirm(label, preview) -> boolean for the given mode.
 * - "confirm": interactive y/N prompt on stdin (default is NO; EOF = NO).
 * - "auto": always approve, but log what was done after the fact.
 */
export function createConfirmFunction(mode) {
  if (mode === 'auto') {
    return async (label) => {
      console.log(`[AUTO-APPROVED] ${label}`);
      return true;
    };
  }
  return async (label, preview) => {
    console.log('\n──── CONFIRMATION REQUIRED ────');
    console.log(label);
    console.log(preview);
    console.log('───────────────────────────────');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    } catch {
      return false; // stdin closed or interrupted -> treat as "no"
    } finally {
      rl.close();
    }
  };
}

// ---------------------------------------------------------------------------
// Context management (Phases 6 & 7)
// ---------------------------------------------------------------------------

/** Lightweight repo tree: names + sizes only, never full contents. */
export function buildRepoSummary(repoRoot, maxEntries = 300) {
  const files = walkRepo(repoRoot, { maxEntries: maxEntries + 1 });
  if (!files.length) return '(empty repository)';
  const lines = [];
  for (const rel of files.slice(0, maxEntries)) {
    let size = 0;
    try { size = fs.statSync(path.join(repoRoot, rel)).size; } catch { /* gone */ }
    lines.push(`  ${rel} (${size} B)`);
  }
  if (files.length > maxEntries) lines.push(`  ... (${files.length - maxEntries} more files)`);
  return `${files.length} file(s):\n${lines.join('\n')}`;
}

/** Phase 7: project-provided instructions (AGENT.md at repo root). */
export function loadAgentInstructions(repoRoot) {
  const p = path.join(repoRoot, 'AGENT.md');
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf8').trim();
  return content || null;
}

// ---------------------------------------------------------------------------
// Model routing (Phase 16, upgraded in the final integration pass):
// chooseModel / classifyTask / routeTask now live in llmConfig.js and are
// re-exported above (line ~29) — one implementation, legacy-compatible.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Token / cost tracking (Phase 15)
// ---------------------------------------------------------------------------

function accumulateUsage(runUsage, apiUsage, messages, assistantText) {
  const prompt = apiUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(messages));
  const completion = apiUsage?.completion_tokens ?? estimateTokens(assistantText);
  runUsage.prompt += prompt;
  runUsage.completion += completion;
  runUsage.calls += 1;
  return { prompt, completion, estimated: !apiUsage };
}

function loadCumulativeUsage() {
  const u = readJson(USAGE_FILE, null);
  return u && typeof u.prompt === 'number' ? u : { prompt: 0, completion: 0, calls: 0 };
}

function saveCumulativeUsage(u) {
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2)); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// LLM call with streaming (Phases 14 & 15)
// ---------------------------------------------------------------------------

/**
 * One chat-completions call via the provider abstraction (Part 6) with
 * multi-key failover (Part 7). SSE streaming and the plain-JSON fallback are
 * handled inside OpenAICompatibleProvider; LLM_TIMEOUT is enforced with an
 * AbortController (a stalled server can no longer hang the loop).
 *
 * FAILOVER POLICY (explicit): only AUTH failures (key invalid/rejected)
 * rotate to the next AUTHORIZED key. Rate limits (429) NEVER rotate —
 * provider limits and account rules are respected. Network/server/timeout
 * errors surface immediately to the caller.
 */
async function callLLM(messages, config, { tools = null, onDelta = null } = {}) {
  const keyManager = config.keyManager ?? new KeyManager(config.apiKey ? [config.apiKey] : []);
  const availableKeys = keyManager.available().map((e) => e.key);
  if (availableKeys.length === 0) {
    throw new Error('No usable LLM API key. Add LLM_API_KEY (or LLM_KEYS) to my-agent/.env (see .env.example).');
  }
  let lastError = null;
  for (const key of availableKeys) {
    try {
      const r = await config.provider.chat(messages, {
        apiKey: key,
        model: config.model,
        tools,
        onDelta,
      });
      keyManager.reportSuccess(key);
      return { message: r.message, usage: r.usage, model: r.model, provider: r.provider };
    } catch (err) {
      const kind = err?.kind ?? null;
      if (kind === 'auth') {
        keyManager.reportFailure(key, err.message);
        logEvent('LLM_KEY_FAILED', `provider=${config.providerName ?? 'unknown'} key=${redactKey(key)}: ${err.message} — trying next authorized key if any`);
        lastError = err;
        continue;
      }
      if (kind === 'rate_limited') {
        // Deliberately NO key rotation on 429 — provider limits are respected.
        throw new Error(`${err.message} [key ${redactKey(key)}]`);
      }
      throw err;
    }
  }
  throw lastError ?? new Error('LLM call failed (no authorized key succeeded).');
}

// ---------------------------------------------------------------------------
// Plan mode (Phase 8) + task splitting (Phase 19)
// ---------------------------------------------------------------------------

async function generatePlan(task, config, contextPrefix) {
  const messages = [
    {
      role: 'system',
      content:
        'You are in PLAN MODE. Produce a short, ordered, step-by-step plan (numbered list) for the task. ' +
        'Do NOT write code and do NOT use tools — planning only. Keep it under 15 steps.',
    },
    { role: 'user', content: `${contextPrefix}\n\nTask: ${task}` },
  ];
  const { message } = await callLLM(messages, config, { onDelta: (d) => process.stdout.write(d) });
  process.stdout.write('\n');
  return message.content ?? '(no plan produced)';
}

async function promptApprove() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Type "approve" to execute this plan (anything else aborts): ')).trim().toLowerCase();
    return answer === 'approve' || answer === 'y' || answer === 'yes';
  } catch {
    return false; // stdin closed -> abort
  } finally {
    rl.close();
  }
}

/** True if the task looks broad/multi-step (or the user forced --split). */
export function shouldSplitTask(task, forced) {
  if (forced) return true;
  const words = task.trim().split(/\s+/).length;
  const stepMarkers = (task.match(/\b(then|after that|and then|next,)\b/gi) || []).length;
  return words > 40 || stepMarkers >= 2;
}

async function generateSubTasks(task, config, contextPrefix) {
  const messages = [
    {
      role: 'system',
      content:
        "Break the user's task into an ordered list of concrete sub-tasks (max 6). " +
        'Respond with ONLY a JSON array of strings, no other text.',
    },
    { role: 'user', content: `${contextPrefix}\n\nTask: ${task}` },
  ];
  const { message } = await callLLM(messages, config);
  const raw = (message.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0 && arr.every((s) => typeof s === 'string' && s.trim())) {
      return arr.slice(0, 6);
    }
  } catch { /* fall through to single-task fallback */ }
  return [task];
}

// ---------------------------------------------------------------------------
// Checkpoints / undo (Phase 10, redesigned in F3 — see checkpoint.js)
// ---------------------------------------------------------------------------

export function isGitRepo(repoRoot) {
  return fs.existsSync(path.join(repoRoot, '.git'));
}

/** F3: metadata-only checkpoint (no git commit, no add -A, no user state touched). */
export function createCheckpoint(repoRoot, label, sessionId = null) {
  try {
    const record = beginCheckpoint(repoRoot, label, sessionId);
    logEvent('CHECKPOINT', `repo=${repoRoot} id=${record.id} session=${sessionId ?? '-'} head=${record.headSha ?? '(non-git)'}`);
    return record;
  } catch (err) {
    logEvent('CHECKPOINT_FAILED', `${repoRoot}: ${err.message}`);
    return null;
  }
}

/** F3: safe undo — reverses ONLY recorded agent file changes, never git state. */
export function undoLastCheckpoint(repoRoot) {
  const result = undoCheckpoint(repoRoot);
  logEvent('UNDO', `repo=${repoRoot} id=${result.id} done=${result.done} restored=${result.restored.length} deleted=${result.deleted.length} conflicts=${result.conflicts.length}`);
  return result;
}

// ---------------------------------------------------------------------------
// Sessions (Phase 12)
// ---------------------------------------------------------------------------

function newSessionId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function persistSession(session) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(SESSIONS_DIR, `session-${session.id}.json`), JSON.stringify(session, null, 2));
  } catch { /* best effort */ }
}

export function loadSession(id) {
  const file = path.join(SESSIONS_DIR, `session-${id}.json`);
  const session = readJson(file, null);
  if (!session) throw new Error(`Session not found: ${id} (run "my-agent sessions" to list them)`);
  return session;
}

export function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const s = readJson(path.join(SESSIONS_DIR, f), null);
      return s ? { id: s.id, repo: s.repo, task: s.task, updatedAt: s.updatedAt, messages: (s.messages || []).length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// ---------------------------------------------------------------------------
// Test command detection (Phase 9)
// ---------------------------------------------------------------------------

export function detectTestCommand(repoRoot) {
  const agentMdPath = path.join(repoRoot, 'AGENT.md');
  if (fs.existsSync(agentMdPath)) {
    const m = fs.readFileSync(agentMdPath, 'utf8').match(/^test-command:\s*(.+)\s*$/m);
    if (m) return m[1].trim();
  }
  const pkg = readJson(path.join(repoRoot, 'package.json'), null);
  if (pkg?.scripts?.test) return 'npm test';
  return null;
}

// ---------------------------------------------------------------------------
// Tool schemas (OpenAI-compatible `tools` format)
// ---------------------------------------------------------------------------

export function createToolSchemas() {
  return [
    { type: 'function', function: { name: 'read_file', description: 'Read the full text contents of a file inside the target repo.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Repo-relative file path.' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'write_file', description: 'Create a NEW file with the given content (fails if the file already exists — use edit_file for existing files). Parent directories are created automatically.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Repo-relative file path.' }, content: { type: 'string', description: 'Full file content.' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'edit_file', description: 'Replace an EXACT, UNIQUE occurrence of old_text with new_text in an existing file. old_text must match exactly once (including whitespace); zero or multiple matches are rejected.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Repo-relative file path.' }, old_text: { type: 'string', description: 'Exact text to find (must be unique in the file).' }, new_text: { type: 'string', description: 'Replacement text.' } }, required: ['path', 'old_text', 'new_text'] } } },
    { type: 'function', function: { name: 'list_files', description: 'List files (recursively) in a directory inside the target repo.', parameters: { type: 'object', properties: { dir: { type: 'string', description: 'Repo-relative directory. Defaults to repo root.' } } } } },
    { type: 'function', function: { name: 'search_code', description: 'Grep-like search across the repo (respects .gitignore). Returns file:line: text matches. Cheaper than reading many files.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for.' }, regex: { type: 'boolean', description: 'Treat query as a regular expression.' }, ignore_case: { type: 'boolean', description: 'Case-insensitive (default true).' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'run_command', description: 'Run ONE program with plain arguments, cwd = repo root, 30s timeout. NO shell is used: shell operators (; | && || > >> < $() backticks globs) and "$" are rejected. Examples: "npm test", "node script.js", "git status". Returns stdout, stderr and exit code. Blocked programs (sh, bash, sudo, dd, kill, xargs, ...) and dangerous patterns (rm -rf, curl|sh, git push --force, > /dev) are permanently refused; restricted programs (rm, curl, npx, ...) require user approval even in auto mode.', parameters: { type: 'object', properties: { cmd: { type: 'string', description: 'Single program name plus plain arguments, e.g. "npm test" — no shell syntax.' } }, required: ['cmd'] } } },
    { type: 'function', function: { name: 'git_status', description: 'Show branch + short git status of the target repo.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'git_diff', description: 'Show the working-tree diff vs HEAD (capped output).', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'git_commit', description: 'Stage all changes and create a git commit with the given message. Requires user approval.', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Commit message.' } }, required: ['message'] } } },
    { type: 'function', function: { name: 'git_branch', description: 'Create a new git branch and switch to it. Requires user approval.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'New branch name.' } }, required: ['name'] } } },
  ];
}

// ---------------------------------------------------------------------------
// Tool executor with safety layers + retry cap (Phases 3/4/11/17/18)
// ---------------------------------------------------------------------------

async function executeToolCall(call, ctx) {
  const { repoRoot, tools, mode, confirmAction, state } = ctx;
  const name = call.function.name;
  const tcid = call.id ?? `${name}-${Date.now()}`;
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    args = {}; // force a clean "invalid args" error back to the LLM
  }
  const emit = ctx.emit ?? (() => {});

  console.log(`[TOOL] ${name} ${truncateForLog(redactSecrets(JSON.stringify(args)))}`);
  logEvent('TOOL_REQUESTED', `${name} ${redactSecrets(JSON.stringify(args))}`);
  emit('agent.tool.start', { id: tcid, name, args: redactSecrets(JSON.stringify(args)) });

  let result;
  let outcome = 'ok';
  try {
    if (!tools[name]) throw new Error(`Unknown tool "${name}".`);

    if (READ_ONLY_TOOLS.has(name)) {
      result = await tools[name](args);
    } else if (DESTRUCTIVE_TOOLS.has(name)) {
      // Safety layer 1 (F2): command policy — BLOCKED commands are refused
      // outright, never confirmed, and never bypassed by auto mode.
      let mustConfirm = false;
      if (name === 'run_command') {
        const blockedWhy = checkBlocklist(args.cmd);
        if (blockedWhy) {
          result = `REFUSED: this command matches a blocked pattern (${blockedWhy}). The agent will not run it. Choose a safer approach.`;
          outcome = 'refused';
          console.log(`[TOOL] ${name} ✗ BLOCKED (${blockedWhy})`);
          logEvent('TOOL_BLOCKED', `${name} ${redactSecrets(JSON.stringify(args))} reason=${blockedWhy}`);
        } else {
          const verdict = parseAndClassify(typeof args.cmd === 'string' ? args.cmd : '');
          if (!verdict.ok) {
            result = `REFUSED (command policy): ${verdict.error} Commands run WITHOUT a shell — use one program with plain arguments, or the file tools.`;
            outcome = 'refused';
            console.log(`[TOOL] ${name} ✗ POLICY-REFUSED`);
            logEvent('TOOL_BLOCKED', `${name} ${redactSecrets(JSON.stringify(args))} reason=policy-parse`);
          } else if (verdict.classification.cls === CLASSIFICATION.BLOCKED) {
            result = `REFUSED (command policy): ${verdict.classification.reason}. The agent will not run it. Choose a safer approach.`;
            outcome = 'refused';
            console.log(`[TOOL] ${name} ✗ BLOCKED (policy)`);
            logEvent('TOOL_BLOCKED', `${name} ${redactSecrets(JSON.stringify(args))} reason=${verdict.classification.reason}`);
          } else if (verdict.classification.cls === CLASSIFICATION.RESTRICTED) {
            // Restricted programs ALWAYS require explicit confirmation —
            // the security policy overrides auto mode.
            mustConfirm = true;
          }
        }
      }
      // Safety layer 2: user confirmation (Phase 18: in auto mode, still ask
      // once for a run_command never seen before in this session — except
      // F2 SAFE_READONLY commands, which are safe to auto-run).
      if (result === undefined) {
        const firstTimeCmd = mode === 'auto' && name === 'run_command' && !state.seenCommands.has(args.cmd);
        const skipFirstTimeWarn =
          name === 'run_command' && parseAndClassify(typeof args.cmd === 'string' ? args.cmd : '').ok === true &&
          parseAndClassify(typeof args.cmd === 'string' ? args.cmd : '').classification?.cls === CLASSIFICATION.SAFE_READONLY;
        const needsFirstTimeConfirm = firstTimeCmd && !skipFirstTimeWarn;
        if (mode === 'confirm' || needsFirstTimeConfirm || mustConfirm) {
          const preview = buildToolPreview(repoRoot, name, args); // may throw on invalid path
          const label = `${name} → ${name === 'run_command' ? args.cmd : args.path}`;
          emit('agent.confirmation.required', { id: tcid, tool: name, label, preview });
          const approved = await confirmAction(label, preview);
          if (!approved) {
            result = 'The user REJECTED this action. Do not retry it unchanged; adjust your approach or ask the user for guidance.';
            outcome = 'rejected';
            console.log(`[TOOL] ${name} ✗ rejected by user`);
            logEvent('TOOL_REJECTED', `${name} ${JSON.stringify(args)}`);
          }
        } else {
          console.log(`[AUTO-APPROVED] ${name}`);
        }
      }
      // Execute if not blocked/rejected.
      if (result === undefined) {
        logEvent('TOOL_CONFIRMED', `${name} ${JSON.stringify(args)} mode=${mode}`);
        result = await tools[name](args);
        if (name === 'run_command') state.seenCommands.add(args.cmd);
      }
    } else {
      throw new Error(`Tool "${name}" has no safety classification — refusing.`);
    }
  } catch (err) {
    // Feed the error BACK to the model so it can self-correct (Phase 17).
    result = `ERROR: ${err.message}`;
    outcome = 'error';
    logEvent('TOOL_ERROR', `${name} ${err.message}`);
  }

  // Phase 17: cap retries of the SAME failing call.
  if (typeof result === 'string' && result.startsWith('ERROR:')) {
    const key = `${name}:${JSON.stringify(args)}`;
    const count = (state.failCounts.get(key) ?? 0) + 1;
    state.failCounts.set(key, count);
    if (count >= MAX_IDENTICAL_TOOL_RETRIES) {
      result += ` (This identical call has now failed ${count} times — STOP retrying it and report the problem to the user.)`;
    }
  }

  console.log(`[TOOL] ${name} ${result.startsWith('ERROR:') || result.startsWith('REFUSED:') ? '✗' : '✓'} ${truncateForLog(redactSecrets(result))}`);
  logEvent('TOOL_RESULT', `${name} ${truncateForLog(redactSecrets(result))}`);
  emit('agent.tool.complete', {
    id: tcid,
    name,
    status: outcome,
    result: truncateForLog(redactSecrets(String(result)), 4000),
  });
  return result;
}

/**
 * Executes parsed tool calls. Independent READ-ONLY calls requested in the
 * same turn run CONCURRENTLY (Phase 13); destructive calls always run
 * sequentially. Returns results in the same order as the input calls.
 */
export async function executeParsedToolCalls(calls, ctx) {
  const parsed = calls.map((call) => {
    let args = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* handled later */ }
    return { call, name: call.function.name, args };
  });
  const readIdx = parsed.map((p, i) => (READ_ONLY_TOOLS.has(p.name) ? i : -1)).filter((i) => i >= 0);
  const results = new Array(parsed.length);
  if (readIdx.length > 1) {
    console.log(`[AGENT] ${readIdx.length} read-only call(s) — executing in parallel`);
    const settled = await Promise.all(readIdx.map((i) => executeToolCall(parsed[i].call, ctx)));
    readIdx.forEach((i, k) => { results[i] = settled[k]; });
  } else if (readIdx.length === 1) {
    results[readIdx[0]] = await executeToolCall(parsed[readIdx[0]].call, ctx);
  }
  for (let i = 0; i < parsed.length; i++) {
    if (results[i] === undefined) results[i] = await executeToolCall(parsed[i].call, ctx);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT =
  'You are a coding agent working inside a target project folder. ' +
  'Use the provided tools (read_file, list_files, search_code, write_file, edit_file, run_command, git_status, git_diff, git_commit, git_branch) ' +
  'to inspect and modify the project. All paths are relative to the repo root — you cannot access anything outside it. ' +
  'PREFER search_code/list_files to locate code, and edit_file (exact unique match) to modify existing files; ' +
  'write_file only creates NEW files. run_command starts in the repo directory with a 30s timeout; ' +
  'dangerous commands (rm -rf, sudo, dd, mkfs, > /dev, curl|sh, git push --force) are permanently blocked. ' +
  'write_file, edit_file, run_command and git_commit/git_branch may require user approval — if the user rejects an action, do NOT retry it unchanged. ' +
  'If a tool errors, adjust the arguments and retry (at most 3 attempts for the identical call). ' +
  'Explore before editing, make focused changes, and when done reply with a short summary.';

/**
 * Runs agent iterations for one logical segment (a task or sub-task) until
 * the model returns a final text answer.
 */
async function agentSegment(messages, ctx, session, runUsage, iterationOffset) {
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (ctx.isCancelled && ctx.isCancelled()) {
      console.log('[AGENT] cancelled by user');
      return '(aborted: user cancelled)';
    }
    console.log(`\n────────── Iteration ${iterationOffset + iteration} ──────────`);
    console.log(`[LLM] → sending ${messages.length} message(s) to ${ctx.config.model}`);
    ctx.emit('agent.thinking', { iteration: iterationOffset + iteration, model: ctx.config.model });

    const { message: assistantMessage, usage } = await callLLM(messages, ctx.config, {
      tools: ctx.toolSchemas,
      onDelta: (d) => {
        process.stdout.write(d); // Phase 14: stream as it arrives
        ctx.emit('agent.stream.delta', { delta: d });
      },
    });
    const used = accumulateUsage(runUsage, usage, messages, assistantMessage.content ?? '');
    process.stdout.write('\n');
    console.log(`[TOKENS] in=${used.prompt} out=${used.completion}${used.estimated ? ' (estimated)' : ''}`);

    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const finalAnswer = assistantMessage.content ?? '(empty response)';
      console.log('[LLM] ← final text response (no tool calls). Segment complete.');
      logEvent('AGENT_DONE', `final answer after ${iterationOffset + iteration} iteration(s)`);
      return finalAnswer;
    }

    console.log(`[LLM] ← requested ${toolCalls.length} tool call(s)`);
    messages.push(assistantMessage);

    const results = await executeParsedToolCalls(toolCalls, ctx);
    toolCalls.forEach((call, i) => {
      messages.push({ role: 'tool', tool_call_id: call.id, content: results[i] });
    });
    persistSession(session);
  }
  const finalAnswer = '(agent loop hit MAX_ITERATIONS without a final answer)';
  console.warn(`\n[AGENT] ${finalAnswer}`);
  logEvent('AGENT_DONE', 'stopped: MAX_ITERATIONS reached');
  return finalAnswer;
}

/**
 * Main entry: context prep, routing, plan/split handling, checkpoints,
 * sessions, the loop itself, the test-run fix loop, and token reporting.
 */
export async function runAgentLoop(repoPath, task, opts = {}) {
  const {
    mode = 'confirm',
    plan = false,
    split = false,
    modelOverride = null,
    resumeSessionId = null,
    skipTests = false,
    emitter = null,        // F5: optional structured-event sink (the Android bridge)
    confirmAction = null,  // F5: overridable confirmation (bridge resolves via HTTP)
    cancelRequested = null,
  } = opts;

  const repoRoot = path.resolve(repoPath);
  const state = { seenCommands: new Set(), failCounts: new Map(), wroteAny: false };
  // Structured event emitter (never crashes the agent; fails silent + logged).
  const emit = (name, payload = {}) => {
    try { if (emitter) emitter.emit(name, payload); } catch (err) { logEvent('EMIT_FAILED', `${name}: ${err.message}`); }
  };
  state.emit = emit;
  const tools = createToolImplementations(repoRoot, state);
  const toolSchemas = createToolSchemas();
  const config = loadLlmConfig(process.env);
  const routed = routeTask(task, config, modelOverride);
  config.model = routed.model;
  config.baseURL = routed.baseURL;
  const isCancelled = () => (typeof cancelRequested === 'function') ? cancelRequested() : false;
  const confirmFn = confirmAction ?? createConfirmFunction(mode);
  const ctx = { repoRoot, tools, mode, confirmAction: confirmFn, state, config, toolSchemas, emit, isCancelled };
  const runUsage = { prompt: 0, completion: 0, calls: 0 };

  // Phase 6 + 7: lightweight context instead of dumping full files.
  const agentInstructions = loadAgentInstructions(repoRoot);
  const repoSummary = buildRepoSummary(repoRoot);
  const contextPrefix =
    `Target repo: ${repoRoot}\n\nRepository overview (names + sizes only — use read_file for contents):\n${repoSummary}` +
    (agentInstructions ? `\n\nProject instructions (AGENT.md):
${agentInstructions}` : '');

  console.log(`[AGENT] repo: ${repoRoot}`);
  console.log(`[AGENT] task: ${truncateForLog(task)}`);
  console.log(`[AGENT] mode: ${mode}`);
  console.log(`[AGENT] model: ${config.model} — Task complexity: ${routed.category} — Reason: ${routed.reason}`);
  console.log(`[AGENT] provider: ${config.providerName} | timeout: ${config.timeoutMs}ms | authorized keys: ${config.keyManager.entries.length} (${config.keyManager.available().length} available)`);
  if (agentInstructions) console.log('[AGENT] AGENT.md instructions loaded ✓');
  logEvent('AGENT_START', `repo=${repoRoot} task=${truncateForLog(task)} mode=${mode} model=${config.model}`);

  // Phase 12: sessions.
  const session = resumeSessionId ? loadSession(resumeSessionId) : null;
  const messages = session ? session.messages : [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT + (agentInstructions ? `\n\nProject instructions (AGENT.md):\n${agentInstructions}` : '') },
  ];
  const activeSession = session ?? {
    id: newSessionId(), repo: repoRoot, task, createdAt: new Date().toISOString(), updatedAt: null, messages,
  };
  if (session) {
    console.log(`[AGENT] resuming session ${session.id} (${session.messages.length} message(s) restored)`);
    logEvent('SESSION_RESUMED', session.id);
  }
  messages.push({ role: 'user', content: `${contextPrefix}\n\nTask: ${task}` });
  persistSession(activeSession);

  // F3: metadata-only checkpoint before any work (git AND non-git repos).
  // Records agent file edits as they happen; `my-agent undo` reverses exactly
  // those. No git commit, no add -A, user's branch/index/untracked untouched.
  state.activeCheckpoint = createCheckpoint(repoRoot, truncateForLog(task, 60), activeSession.id);
  if (state.activeCheckpoint) console.log(`[AGENT] checkpoint: ${state.activeCheckpoint.id.slice(3, 13)} (revert with: my-agent undo --repo ${repoRoot})`);
  emit('agent.started', {
    repo: repoRoot,
    task,
    mode,
    model: config.model,
    provider: config.providerName,
    sessionId: activeSession.id,
    checkpointId: state.activeCheckpoint?.id ?? null,
    planMode: plan,
  });

  // Phase 8: plan mode.
  if (plan) {
    console.log('\n════════ PLAN MODE ════════');
    const planText = await generatePlan(task, config, contextPrefix);
    emit('agent.plan.ready', { plan: planText });
    logEvent('PLAN_SHOWN', truncateForLog(planText, 400));
    const approved = await promptApprove();
    if (!approved) {
      console.log('Plan NOT approved — aborting without changes.');
      logEvent('PLAN_ABORTED');
      accumulateUsage(runUsage, null, messages, planText);
      emit('agent.completed', { status: 'plan_aborted', finalAnswer: '(aborted in plan mode)', sessionId: activeSession.id, iterations: 0 });
      return { finalAnswer: '(aborted in plan mode)', iterations: 0, sessionId: activeSession.id, planText };
    }
    console.log('Plan approved — executing.\n');
    logEvent('PLAN_APPROVED');
  }

  // Phase 19: broad-task splitting.
  let segments;
  if (shouldSplitTask(task, split)) {
    console.log('[AGENT] broad task detected — splitting into sub-tasks');
    segments = await generateSubTasks(task, config, contextPrefix);
    console.log(`[AGENT] ${segments.length} sub-task(s):`);
    segments.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  } else {
    segments = [task];
  }

  let totalIterations = 0;
  let finalAnswer = '';
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      messages.push({ role: 'user', content: `Now execute sub-task ${i + 1}: ${segments[i]}\n(Sub-task "${segments[i - 1]}" is complete.)` });
      state.activeCheckpoint = createCheckpoint(repoRoot, `sub-task ${i + 1}/${segments.length}: ${truncateForLog(segments[i], 40)}`, activeSession.id);
    }
    console.log(`\n========== SUB-TASK ${i + 1}/${segments.length}: ${segments[i]} ==========`);
    finalAnswer = await agentSegment(messages, ctx, activeSession, runUsage, totalIterations);
    totalIterations += countSegmentIterations(finalAnswer);
  }

  // Phase 9: test-run fix loop after code changes.
  if (!skipTests && state.wroteAny) {
    const testCmd = detectTestCommand(repoRoot);
    if (testCmd) {
      console.log(`\n[TESTS] code changes made — running test command: ${testCmd}`);
      for (let attempt = 1; attempt <= MAX_TEST_FIX_RETRIES; attempt++) {
        const testResult = await tools.run_command({ cmd: testCmd });
        const passed = /^exit code: 0$/m.test(testResult);
        ctx.emit('agent.test.complete', { cmd: testCmd, attempt, passed });
        console.log(`[TESTS] attempt ${attempt}/${MAX_TEST_FIX_RETRIES}: ${passed ? 'PASSED ✓' : 'FAILED ✗'}`);
        logEvent('TEST_RUN', `attempt=${attempt} passed=${passed} cmd=${testCmd}`);
        if (passed) break;
        if (attempt === MAX_TEST_FIX_RETRIES) {
          finalAnswer += `\n\nWARNING: tests still failing after ${MAX_TEST_FIX_RETRIES} fix attempts ("${testCmd}"). Manual review needed.\nLast failure:\n${capText(testResult, 2000)}`;
          logEvent('TESTS_FAILED_FINAL', `after ${MAX_TEST_FIX_RETRIES} attempts`);
          break;
        }
        console.log('[TESTS] asking the model to fix the failures…');
        messages.push({
          role: 'user',
          content: `The test command "${testCmd}" FAILED after your changes (attempt ${attempt} of ${MAX_TEST_FIX_RETRIES}). Fix the problem. Test output:\n${capText(testResult, 4000)}`,
        });
        finalAnswer = await agentSegment(messages, ctx, activeSession, runUsage, totalIterations);
        totalIterations += 1;
      }
    }
  }

  // Phase 12 + 15: persist session, cumulative usage.
  activeSession.messages = messages;
  activeSession.finalAnswer = finalAnswer;
  persistSession(activeSession);
  const cumulative = loadCumulativeUsage();
  cumulative.prompt += runUsage.prompt;
  cumulative.completion += runUsage.completion;
  cumulative.calls += runUsage.calls;
  saveCumulativeUsage(cumulative);

  console.log(`\n[TOKENS] this run: in=${runUsage.prompt} out=${runUsage.completion} calls=${runUsage.calls}`);
  console.log(`[TOKENS] cumulative: in=${cumulative.prompt} out=${cumulative.completion} calls=${cumulative.calls}`);
  logEvent('RUN_COMPLETE', `in=${runUsage.prompt} out=${runUsage.completion} calls=${runUsage.calls} session=${activeSession.id}`);
  emit('agent.completed', {
    status: 'done',
    finalAnswer,
    sessionId: activeSession.id,
    iterations: totalIterations,
    usage: { prompt: runUsage.prompt, completion: runUsage.completion, calls: runUsage.calls },
  });

  return { finalAnswer, iterations: totalIterations, sessionId: activeSession.id };
}

// Approximate bookkeeping for the printed iteration count.
function countSegmentIterations() {
  return 1;
}
