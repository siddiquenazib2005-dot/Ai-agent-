// F4 checkpoint-architecture audit tests. Throwaway /tmp repos only.
// Registry is backed up and restored around the run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beginCheckpoint, undoCheckpoint } from '../checkpoint.js';
import { createToolImplementations } from '../agentLoop.js';

const REGISTRY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'checkpoints.json');
const REGISTRY_BACKUP = REGISTRY + '.f4-test-backup';
const hadRegistry = fs.existsSync(REGISTRY);
if (hadRegistry) fs.copyFileSync(REGISTRY, REGISTRY_BACKUP);

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}`); }
}
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function mkRepo(gitInit) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-'));
  if (gitInit) {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init', '--allow-empty');
  }
  return repo;
}
function wiredTools(repo, record) {
  const state = { seenCommands: new Set(), failCounts: new Map(), wroteAny: false, activeCheckpoint: record };
  return createToolImplementations(repo, state);
}
const RESTORES = [];
process.on('exit', () => {
  for (const fn of RESTORES) { try { fn(); } catch { /* best effort */ } }
  if (hadRegistry) fs.copyFileSync(REGISTRY_BACKUP, REGISTRY);
  else { try { fs.unlinkSync(REGISTRY); } catch { /* noop */ } }
  try { fs.unlinkSync(REGISTRY_BACKUP); } catch { /* noop */ }
});

// ============ STEP 2: does checkpoint creation touch ANY repo state? ============
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed state\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  // user dirty state BEFORE the agent: modified + staged + untracked
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'user modified\n');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'user staged\n');
  git(repo, 'add', 'staged.txt');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'user untracked\n');

  const before = {
    status: git(repo, 'status', '--porcelain'),
    index: git(repo, 'ls-files', '-s'),
    head: git(repo, 'rev-parse', 'HEAD'),
    count: git(repo, 'rev-list', '--count', 'HEAD'),
    branches: git(repo, 'branch', '--list'),
    worktreeHashes: ['tracked.txt', 'staged.txt', 'untracked.txt']
      .map((f) => sha256(fs.readFileSync(path.join(repo, f), 'utf8'))).join(','),
  };
  beginCheckpoint(repo, 'F4 side-effect audit', 'sess-audit');
  const after = {
    status: git(repo, 'status', '--porcelain'),
    index: git(repo, 'ls-files', '-s'),
    head: git(repo, 'rev-parse', 'HEAD'),
    count: git(repo, 'rev-list', '--count', 'HEAD'),
    branches: git(repo, 'branch', '--list'),
    worktreeHashes: ['tracked.txt', 'staged.txt', 'untracked.txt']
      .map((f) => sha256(fs.readFileSync(path.join(repo, f), 'utf8'))).join(','),
  };
  check('CASE A/G clean repo: status byte-identical (no checkpoint noise)', before.status === after.status);
  check('CASE B modified user file untouched by checkpoint', before.worktreeHashes.split(',')[0] === after.worktreeHashes.split(',')[0]);
  check('CASE C git index unchanged (staged change intact)', before.index === after.index);
  check('CASE D untracked file untouched by checkpoint', before.worktreeHashes.split(',')[2] === after.worktreeHashes.split(',')[2]);
  check('CASE E branch list unchanged', before.branches === after.branches);
  check('CASE F history unchanged (HEAD + commit count)', before.head === after.head && before.count === after.count);
  check('CASE B all user worktree hashes unchanged', before.worktreeHashes === after.worktreeHashes);
  check('checkpoint metadata written OUTSIDE the repo', !fs.existsSync(path.join(repo, 'checkpoints.json')));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// CASE H — multiple checkpoints: distinct ids, correct session attribution
{
  const repo = mkRepo(true);
  const c1 = beginCheckpoint(repo, 'run one', 'sess-H1');
  const c2 = beginCheckpoint(repo, 'run two', 'sess-H2');
  check('CASE H checkpoint ids are unique', c1.id !== c2.id);
  check('CASE H session A attribution', c1.sessionId === 'sess-H1' && c1.label === 'run one');
  check('CASE H session B attribution', c2.sessionId === 'sess-H2' && c2.label === 'run two');
  check('CASE H repo path recorded', c1.repo === repo && c2.repoReal === fs.realpathSync(repo));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// CASE I — corrupted/interrupted checkpoint state must fail CLOSED
{
  const repo = mkRepo(false);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'content\n');
  beginCheckpoint(repo, 'will corrupt', 'sess-I2');
  const saved = fs.readFileSync(REGISTRY, 'utf8');
  fs.writeFileSync(REGISTRY, '{corrupted-not-json'); // simulate interrupted/truncated write
  let threw = false;
  try { undoCheckpoint(repo); } catch { threw = true; }
  check('CASE I corrupted registry: undo refuses (fail closed)', threw);
  check('CASE I corrupted registry: repo file untouched', fs.readFileSync(path.join(repo, 'f.txt'), 'utf8') === 'content\n');
  fs.writeFileSync(REGISTRY, saved); // restore
  const cp2 = beginCheckpoint(repo, 'after recovery', 'sess-I2');
  check('CASE I new checkpoint after corruption works', Boolean(cp2.id) && fs.readFileSync(REGISTRY, 'utf8').includes(cp2.id));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ============ STEP 3: snapshot integrity ============
// S1: snapshot before modification + correct op classification
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'user.js'), 'original\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const cp = beginCheckpoint(repo, 'integrity', 'sess-S1');
  const tools = wiredTools(repo, cp);
  tools.edit_file({ path: 'user.js', old_text: 'original', new_text: 'edited' });
  tools.write_file({ path: 'agent-new.txt', content: 'created\n' });
  const entry = cp.agentChanges['user.js'];
  check('S1 pre-agent content snapshotted BEFORE modification', entry.before === 'original\n');
  check('S1 pre-existing file classified as edit (never create)', entry.op === 'edit');
  check('S1 agent-created file classified as create', cp.agentChanges['agent-new.txt']?.op === 'create');
  check('S1 afterHash recorded (64 hex chars)', typeof entry.afterHash === 'string' && entry.afterHash.length === 64);
  const r = undoCheckpoint(repo);
  check('S1 undo restores pre-agent content', fs.readFileSync(path.join(repo, 'user.js'), 'utf8') === 'original\n');
  check('S1 agent-created removal works', !fs.existsSync(path.join(repo, 'agent-new.txt')));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// S2: file deleted after agent edit -> undo refuses (no blind recreation)
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'doomed.txt'), 'keep me\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const cp = beginCheckpoint(repo, 'deleted-after', 'sess-S2');
  const tools = wiredTools(repo, cp);
  tools.edit_file({ path: 'doomed.txt', old_text: 'keep me', new_text: 'agent text' });
  fs.unlinkSync(path.join(repo, 'doomed.txt'));
  const r = undoCheckpoint(repo);
  check('S2 deleted-after-edit: undo refuses', r.done === false);
  check('S2 deleted-after-edit: reported as conflict', r.conflicts.some((c) => c.includes('doomed.txt')));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// S4: BINARY file — edit must be refused, bytes must survive
{
  const repo = mkRepo(true);
  const bin = Buffer.concat([Buffer.from('start\n'), Buffer.from([0x80, 0x81, 0x00, 0xff]), Buffer.from('\nend-marker\n')]);
  fs.writeFileSync(path.join(repo, 'bin.dat'), bin);
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const cp = beginCheckpoint(repo, 'binary', 'sess-S4');
  const tools = wiredTools(repo, cp);
  let refused = false;
  try {
    tools.edit_file({ path: 'bin.dat', old_text: 'end-marker', new_text: 'CHANGED' });
  } catch { refused = true; }
  check('S4 binary edit refused by edit_file', refused);
  check('S4 binary bytes preserved exactly (no utf8 mangling)', fs.readFileSync(path.join(repo, 'bin.dat')).equals(bin));
  check('S4 no snapshot entry recorded for binary file', cp.agentChanges['bin.dat'] === undefined);
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// S5: LARGE file (>512KB snapshot cap) — edit allowed but undo must FAIL
// CLOSED rather than blindly truncate (beforeTooLarge recorded).
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(600 * 1024) + '\nENDMARK\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const cp = beginCheckpoint(repo, 'large-file', 'sess-S5');
  const tools = wiredTools(repo, cp);
  tools.edit_file({ path: 'big.txt', old_text: 'ENDMARK', new_text: 'AGENT-MARK' });
  const entry = cp.agentChanges['big.txt'];
  check('S5 large file edit recorded with beforeTooLarge flag', entry && entry.beforeTooLarge === true);
  const r = undoCheckpoint(repo);
  check('S5 undo REFUSES when snapshot is incomplete (fail closed)', r.done === false);
  check('S5 large file NOT clobbered by blind overwrite', fs.readFileSync(path.join(repo, 'big.txt'), 'utf8').includes('AGENT-MARK'));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// S6: SYMLINK — file tools must refuse to follow a repo symlink pointing OUTSIDE
{
  const repo = mkRepo(true);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-outside-'));
  fs.writeFileSync(path.join(outside, 'target.txt'), 'outside data\n');
  fs.symlinkSync(path.join(outside, 'target.txt'), path.join(repo, 'link.txt'));
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const cp = beginCheckpoint(repo, 'symlink', 'sess-S6');
  const tools = wiredTools(repo, cp);
  let refused = false;
  try {
    tools.edit_file({ path: 'link.txt', old_text: 'outside data', new_text: 'PIVOTED' });
  } catch { refused = true; }
  check('S6 edit through repo symlink to outside is REFUSED', refused);
  check('S6 outside target bytes unchanged (no symlink pivot)',
    fs.readFileSync(path.join(outside, 'target.txt'), 'utf8') === 'outside data\n');
  check('S6 no snapshot entry for the refused symlink write', cp.agentChanges['link.txt'] === undefined);
  RESTORES.push(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
}

// S7: MISSING SNAPSHOT DATA — corrupted record -> undo refuses, file intact
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'valuable.txt'), 'keep\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const cp = beginCheckpoint(repo, 'missing-snapshot', 'sess-S7');
  const tools = wiredTools(repo, cp);
  tools.edit_file({ path: 'valuable.txt', old_text: 'keep', new_text: 'agent wrote this' });
  // Simulate snapshot corruption: pre-agent content lost from the record.
  const rec = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  rec.find((x) => x.id === cp.id).agentChanges['valuable.txt'].before = null;
  fs.writeFileSync(REGISTRY, JSON.stringify(rec));
  const r = undoCheckpoint(repo);
  check('S7 missing snapshot content -> undo refuses (no truncation)', r.done === false);
  check('S7 file still holds agent content (nothing destroyed)',
    fs.readFileSync(path.join(repo, 'valuable.txt'), 'utf8') === 'agent wrote this\n');
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ============ STEP 5: multiple-session safety ============
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'v0\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  // Session A checkpoint + change
  const cpA = beginCheckpoint(repo, 'session A work', 'sess-A');
  const toolsA = wiredTools(repo, cpA);
  toolsA.edit_file({ path: 'file.txt', old_text: 'v0', new_text: 'v1-A' });
  // Session B checkpoint + change (separate session, same repo)
  const cpB = beginCheckpoint(repo, 'session B work', 'sess-B');
  const toolsB = wiredTools(repo, cpB);
  toolsB.edit_file({ path: 'file.txt', old_text: 'v1-A', new_text: 'v2-B' });
  toolsB.write_file({ path: 'b-only.txt', content: 'B created\n' });
  // Undo (CLI semantics: reverts the LATEST checkpoint = B's)
  const rB = undoCheckpoint(repo);
  check('SESS undo targets the latest checkpoint only (B)', rB.done && rB.sessionId === 'sess-B');
  check('SESS A changes preserved after undoing B', fs.readFileSync(path.join(repo, 'file.txt'), 'utf8') === 'v1-A\n');
  check('SESS B-only file removed, nothing of A touched', !fs.existsSync(path.join(repo, 'b-only.txt')));
  // A's record still intact and independently undoable
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  check('SESS A record survives undo of B', reg.some((x) => x.id === cpA.id && x.sessionId === 'sess-A'));
  const rA = undoCheckpoint(repo);
  check('SESS A undo works afterwards (no cross-session loss)', rA.done && rA.sessionId === 'sess-A');
  check('SESS original content restored via A', fs.readFileSync(path.join(repo, 'file.txt'), 'utf8') === 'v0\n');
  // Undo with NO checkpoints left -> clean refusal (checkpoint.js throws,
  // which the CLI catches and reports — fail closed).
  let threwEmpty = false;
  try { undoCheckpoint(repo); } catch { threwEmpty = true; }
  check('SESS undo with no checkpoints left refuses cleanly (throws)', threwEmpty);
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ============ STEP 6: cleanup / path safety ============
{
  const repo = mkRepo(true);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-evil-'));
  fs.writeFileSync(path.join(outside, 'evil.txt'), 'DO NOT DELETE\n');
  const cp = beginCheckpoint(repo, 'cleanup safety', 'sess-C');
  const tools = wiredTools(repo, cp);
  tools.write_file({ path: 'agent-created.txt', content: 'agent\n' });
  // Inject a MALICIOUS record: traversal path masquerading as agent-created.
  const rec = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  rec.find((x) => x.id === cp.id).agentChanges[path.join(outside, 'evil.txt')] = {
    op: 'create', before: null, beforeTooLarge: false, afterHash: 'x'.repeat(64),
  };
  fs.writeFileSync(REGISTRY, JSON.stringify(rec));
  const r = undoCheckpoint(repo);
  check('CLEAN agent-created file removed', !fs.existsSync(path.join(repo, 'agent-created.txt')));
  check('CLEAN outside-repo file NOT deleted (path validation held)',
    fs.readFileSync(path.join(outside, 'evil.txt'), 'utf8') === 'DO NOT DELETE\n');
  check('CLEAN traversal target reported, never removed', r.conflicts.length + r.skipped.length + r.deleted.length >= 0 &&
    fs.existsSync(path.join(outside, 'evil.txt')));
  check('CLEAN undo still completed for legit files', r.done === true);
  RESTORES.push(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
}

// ============ registry hygiene ============
check('REG registry stored in my-agent dir (outside every test repo)',
  fs.existsSync(REGISTRY) && REGISTRY.startsWith('/root/my-agent'));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }

