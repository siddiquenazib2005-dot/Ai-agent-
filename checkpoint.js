/**
 * checkpoint.js — F3 safe checkpoint/undo for my-agent.
 *
 * DESIGN (no git state mutation, no reset --hard, no clean):
 *  - A checkpoint is pure metadata stored OUTSIDE the repo
 *    (<my-agent>/checkpoints.json). Nothing is committed, nothing is
 *    staged, the user's branch/index/stash/untracked files are untouched.
 *  - While the session runs, every agent write_file / edit_file records
 *    into the active checkpoint:
 *        { op: 'create'|'edit', before: <full prior content or null>,
 *          afterHash: sha256 of content after the agent's last write }
 *    The EARLIEST `before` wins, so undo always has the user's original
 *    content, and afterHash is refreshed on every agent write.
 *  - Undo verifies sha256(current) === afterHash for every recorded file
 *    BEFORE touching anything. Any mismatch (user or command edited the
 *    file after the agent) aborts the whole undo with zero changes.
 *  - Only recorded agent paths are restored/deleted. Everything else in
 *    the working tree is preserved by construction and reported.
 *  - Works identically for git and non-git repos (content-based).
 *
 * LIMITATIONS (honest): changes made by commands (run_command) are not
 * recorded, so they are not reversible — in git repos they are detected
 * and reported as preserved; in non-git repos they cannot even be
 * detected (warned). Snapshot contents are capped at 512 KB per file;
 * larger edits make undo refuse rather than guess.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MY_AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINTS_FILE = path.join(MY_AGENT_DIR, 'checkpoints.json');
const MAX_BEFORE_BYTES = 512 * 1024; // per-file snapshot cap
const GIT_TIMEOUT_MS = 15_000;

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINTS_FILE, 'utf8')); } catch { return []; }
}

function writeRegistry(list) {
  fs.writeFileSync(CHECKPOINTS_FILE, JSON.stringify(list, null, 2));
}

function persistRecord(record) {
  const list = readRegistry();
  const i = list.findIndex((r) => r.id === record.id);
  if (i >= 0) list[i] = record; else list.push(record);
  writeRegistry(list);
}

function gitRun(repoRoot, args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim();
  } catch {
    return null; // non-git repo or git unavailable — callers handle null
  }
}

/**
 * Begins a checkpoint. Records repo identity (abs + realpath), session,
 * HEAD sha (git repos, informational only — never reset to), and an empty
 * agentChanges map. Writes nothing inside the target repo.
 */
export function beginCheckpoint(repoRoot, label, sessionId = null) {
  const repoAbs = path.resolve(repoRoot);
  let repoReal = repoAbs;
  try { repoReal = fs.realpathSync(repoAbs); } catch { /* deleted repo — undo will fail loudly */ }
  const headSha = gitRun(repoAbs, ['rev-parse', 'HEAD']);
  const record = {
    id: `cp-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    sessionId,
    repo: repoAbs,
    repoReal,
    label: String(label ?? ''),
    at: new Date().toISOString(),
    headSha,
    agentChanges: {}, // relPath -> { op, before, beforeTooLarge, afterHash }
    undoneAt: null,
  };
  persistRecord(record);
  return record;
}

/**
 * Records one agent file operation into the active checkpoint.
 * - op 'create': file did not exist before (write_file is create-only).
 * - op 'edit': `before` is the FULL file content prior to the agent's
 *   first edit of this path in this checkpoint.
 * The first op/before for a path wins (original user state is kept);
 * afterHash is refreshed on every write so undo can detect later
 * third-party modifications (conflict detection).
 */
export function recordAgentWrite(record, relPath, { op, before = null, after = '' } = {}) {
  if (!record || record.undoneAt) return;
  const key = String(relPath).replace(/\\/g, '/');
  const existing = record.agentChanges[key];
  if (!existing) {
    const tooLarge = op === 'edit' && typeof before === 'string' &&
      Buffer.byteLength(before, 'utf8') > MAX_BEFORE_BYTES;
    record.agentChanges[key] = {
      op: op === 'create' ? 'create' : 'edit',
      before: tooLarge ? null : (op === 'edit' && typeof before === 'string' ? before : null),
      beforeTooLarge: tooLarge,
      afterHash: sha256(typeof after === 'string' ? after : ''),
    };
  } else {
    existing.afterHash = sha256(typeof after === 'string' ? after : '');
  }
  persistRecord(record);
}

/** Normalizes git porcelain output to repo-relative posix paths. */
function porcelainPaths(porcelain) {
  if (!porcelain) return [];
  return porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '').replace(/\\\\/g, '\\'))
    .filter((p) => !p.startsWith('..'));
}

/** Deletes a directory only if it is empty; walks up without leaving the repo. */
function pruneEmptyDirs(repoAbs, dirAbs) {
  let cur = dirAbs;
  const root = path.resolve(repoAbs);
  while (cur.startsWith(root + path.sep) && cur !== root) {
    let entries;
    try { entries = fs.readdirSync(cur); } catch { return; }
    if (entries.length > 0) return;
    try { fs.rmdirSync(cur); } catch { return; }
    cur = path.dirname(cur);
  }
}

/**
 * Reverts the LATEST non-undone checkpoint for this repo.
 * Verify-then-apply: if ANY recorded file was modified after the agent's
 * last write (conflict), NOTHING is changed and done=false is returned.
 * Non-agent files are never touched; they are reported as preserved.
 */
export function undoCheckpoint(repoRoot) {
  const repoAbs = path.resolve(repoRoot);
  let repoReal = repoAbs;
  try { repoReal = fs.realpathSync(repoAbs); } catch { /* missing repo handled below */ }

  const registry = readRegistry();
  const mine = registry.filter(
    (r) => !r.undoneAt && (r.repo === repoAbs || r.repoReal === repoReal) && fs.existsSync(r.repo),
  );
  if (mine.length === 0) {
    throw new Error(`No my-agent checkpoints found for ${repoAbs}.`);
  }
  const record = mine[mine.length - 1];
  const changes = record.agentChanges ?? {};
  const warnings = [];
  if (!record.agentChanges) {
    warnings.push('legacy checkpoint without change records — nothing reversible; aborting');
    return { done: false, id: record.id, restored: [], deleted: [], skipped: [], preserved: [], conflicts: [], warnings };
  }

  // ---- PASS 1: verify everything first (no writes until all checks pass).
  const conflicts = [];
  const plan = [];
  for (const [rel, entry] of Object.entries(changes)) {
    const abs = path.join(record.repo, rel);
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
    if (entry.op === 'create') {
      if (!exists) { plan.push({ rel, action: 'skip', why: 'already gone' }); continue; }
      if (entry.afterHash && sha256(fs.readFileSync(abs, 'utf8')) !== entry.afterHash) {
        conflicts.push(`${rel} was modified after the agent created it — refusing to delete`);
        continue;
      }
      plan.push({ rel, action: 'delete', abs });
    } else {
      if (entry.beforeTooLarge) {
        conflicts.push(`${rel} pre-agent content was too large to snapshot — cannot restore safely`);
        continue;
      }
      if (typeof entry.before !== 'string') {
        conflicts.push(`${rel} has no recorded pre-agent content — cannot restore safely`);
        continue;
      }
      if (!exists) { conflicts.push(`${rel} was deleted after the agent edited it — cannot restore safely`); continue; }
      if (entry.afterHash && sha256(fs.readFileSync(abs, 'utf8')) !== entry.afterHash) {
        conflicts.push(`${rel} was modified after the agent's last write — refusing to overwrite`);
        continue;
      }
      plan.push({ rel, action: 'restore', abs, before: entry.before });
    }
  }

  const result = {
    id: record.id, sessionId: record.sessionId ?? '(unknown)', at: record.at, label: record.label,
    headSha: record.headSha, restored: [], deleted: [], skipped: [], preserved: [], conflicts, warnings, done: false,
  };
  if (conflicts.length > 0) return result; // abort — user data untouched

  // ---- PASS 2: apply.
  for (const step of plan) {
    if (step.action === 'skip') { result.skipped.push(`${step.rel} (${step.why})`); continue; }
    if (step.action === 'delete') {
      fs.unlinkSync(step.abs);
      pruneEmptyDirs(record.repo, path.dirname(step.abs));
      result.deleted.push(step.rel);
    } else {
      fs.writeFileSync(step.abs, step.before, 'utf8');
      result.restored.push(step.rel);
    }
  }

  // ---- Git-aware reporting (informational — git state is never modified).
  if (record.headSha) {
    const nowHead = gitRun(record.repo, ['rev-parse', 'HEAD']);
    if (nowHead && nowHead !== record.headSha) {
      result.warnings.push('commits were made during the session — undo never touches commits; they are still yours');
    }
    const agentSet = new Set(Object.keys(changes));
    const untouched = porcelainPaths(gitRun(record.repo, ['status', '--porcelain']))
      .filter((p) => !agentSet.has(p));
    if (untouched.length > 0) {
      result.preserved = untouched;
    }
  } else if (!gitRun(record.repo, ['rev-parse', 'HEAD'])) {
    result.warnings.push('non-git repo: undo reverses only file changes made by the agent itself; changes made via run_command cannot be detected or reversed');
  }

  record.undoneAt = new Date().toISOString();
  persistRecord(record);
  result.done = result.restored.length + result.deleted.length + result.skipped.length > 0 || Object.keys(changes).length === 0;
  return result;
}
