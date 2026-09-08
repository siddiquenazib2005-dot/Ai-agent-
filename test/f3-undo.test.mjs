// F3 tests — safe checkpoint/undo. Throwaway /tmp repos only; the real
// checkpoints.json registry is backed up and restored around the run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { beginCheckpoint, recordAgentWrite, undoCheckpoint } from '../checkpoint.js';
import { createToolImplementations } from '../agentLoop.js';

const REGISTRY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'checkpoints.json');
const REGISTRY_BACKUP = REGISTRY + '.f3-test-backup';
const hadRegistry = fs.existsSync(REGISTRY);
if (hadRegistry) fs.copyFileSync(REGISTRY, REGISTRY_BACKUP);

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}`); }
}
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const mkRepo = (gitInit) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-'));
  if (gitInit) {
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init', '--allow-empty');
  }
  return repo;
};
// Production-like wiring: tools record into the active checkpoint via state.
function wiredTools(repo, record) {
  const state = { seenCommands: new Set(), failCounts: new Map(), wroteAny: false, activeCheckpoint: record };
  return createToolImplementations(repo, state);
}
const RESTORES = [];
process.on('exit', () => {
  for (const fn of RESTORES) { try { fn(); } catch { /* best effort */ } }
  if (hadRegistry) fs.copyFileSync(REGISTRY_BACKUP, REGISTRY_BACKUP); // keep backup file small
  if (hadRegistry) fs.copyFileSync(REGISTRY_BACKUP, REGISTRY);
  else { try { fs.unlinkSync(REGISTRY); } catch { /* noop */ } }
  try { fs.unlinkSync(REGISTRY_BACKUP); } catch { /* noop */ }
});

// ---------------------------------------------------------------- TEST 1
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add a.txt');
  const cp = beginCheckpoint(repo, 'clean repo test', 'sess-1');
  const tools = wiredTools(repo, cp);
  tools.edit_file({ path: 'a.txt', old_text: 'original', new_text: 'agent-was-here' });
  tools.write_file({ path: 'src/new.js', content: 'agent created this\n' });
  check('T1 agent edits visible before undo', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').includes('agent-was-here'));
  const r = undoCheckpoint(repo);
  check('T1 undo done', r.done === true);
  check('T1 edit restored', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'original\n');
  check('T1 agent file removed', !fs.existsSync(path.join(repo, 'src/new.js')));
  check('T1 empty dir pruned', !fs.existsSync(path.join(repo, 'src')));
  check('T1 git worktree clean after undo', git(repo, 'status', '--porcelain') === '');
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- TEST 2
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'user.txt'), 'user base\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  // user's UNCOMMITTED modification made BEFORE the agent starts
  fs.writeFileSync(path.join(repo, 'user.txt'), 'user uncommitted work\n');
  const cp = beginCheckpoint(repo, 'pre-modified test', 'sess-2');
  const tools = wiredTools(repo, cp);
  tools.edit_file({ path: 'user.txt', old_text: 'user uncommitted work', new_text: 'user uncommitted work + agent edit' });
  const r = undoCheckpoint(repo);
  check('T2 undo done', r.done);
  check('T2 user uncommitted modification SURVIVES (restored to pre-agent content)',
    fs.readFileSync(path.join(repo, 'user.txt'), 'utf8') === 'user uncommitted work\n');
  check('T2 change still shows in git status (not silently committed/lost)', git(repo, 'status', '--porcelain').includes('user.txt'));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- TEST 3
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'head version\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'user staged version\n');
  git(repo, 'add', 'staged.txt'); // STAGED user change
  const cp = beginCheckpoint(repo, 'staged test', 'sess-3');
  const tools = wiredTools(repo, cp);
  tools.edit_file({ path: 'staged.txt', old_text: 'user staged version', new_text: 'staged + agent edit' });
  const r = undoCheckpoint(repo);
  check('T3 undo done', r.done);
  check('T3 worktree back to pre-agent (= staged) content',
    fs.readFileSync(path.join(repo, 'staged.txt'), 'utf8') === 'user staged version\n');
  check('T3 user staged change survives in the index',
    git(repo, 'diff', '--cached', '--name-only').includes('staged.txt'));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- TEST 4
{
  const repo = mkRepo(true);
  const cp = beginCheckpoint(repo, 'untracked test', 'sess-4');
  fs.writeFileSync(path.join(repo, 'user-untracked.txt'), 'precious user notes\n'); // user untracked, pre-agent
  const tools = wiredTools(repo, cp);
  tools.write_file({ path: 'agent-file.txt', content: 'agent\n' });
  const r = undoCheckpoint(repo);
  check('T4 undo done', r.done);
  check('T4 agent-created file removed', !fs.existsSync(path.join(repo, 'agent-file.txt')));
  check('T4 user untracked file SURVIVES',
    fs.readFileSync(path.join(repo, 'user-untracked.txt'), 'utf8') === 'precious user notes\n');
  check('T4 user untracked reported as preserved', r.preserved.some((p) => p.includes('user-untracked.txt')));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- TEST 5
{
  const repo = mkRepo(false); // deep-create; git variant covered in T1
  const cp = beginCheckpoint(repo, 'new-file test', 'sess-5');
  const tools = wiredTools(repo, cp);
  tools.write_file({ path: 'deep/nested/agent.js', content: 'x\n' });
  const r = undoCheckpoint(repo);
  check('T5 agent-created file removed', !fs.existsSync(path.join(repo, 'deep/nested/agent.js')));
  check('T5 now-empty dirs pruned', !fs.existsSync(path.join(repo, 'deep')));
  check('T5 deletion reported', r.deleted.includes('deep/nested/agent.js'));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- TEST 6
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'a.js'), 'v0\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const cp1 = beginCheckpoint(repo, 'sub-task 1', 'sess-6');
  const tools1 = wiredTools(repo, cp1);
  tools1.edit_file({ path: 'a.js', old_text: 'v0', new_text: 'v1' });
  const cp2 = beginCheckpoint(repo, 'sub-task 2', 'sess-6');
  const tools2 = wiredTools(repo, cp2);
  tools2.edit_file({ path: 'a.js', old_text: 'v1', new_text: 'v2' });
  tools2.write_file({ path: 'b.js', content: 'agent b\n' });
  const r2 = undoCheckpoint(repo); // latest checkpoint only
  check('T6 undo of latest reverts only its change', fs.readFileSync(path.join(repo, 'a.js'), 'utf8') === 'v1\n');
  check('T6 latest checkpoint file removed', !fs.existsSync(path.join(repo, 'b.js')));
  check('T6 latest recorded in result', r2.done && r2.restored.includes('a.js'));
  const r1 = undoCheckpoint(repo); // then the earlier one
  check('T6 sequential undo reaches original', fs.readFileSync(path.join(repo, 'a.js'), 'utf8') === 'v0\n');
  check('T6 earlier checkpoint also done', r1.done);
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- TEST 7
{
  const repo = mkRepo(false); // NOT a git repo
  fs.writeFileSync(path.join(repo, 'code.js'), 'original code\n');
  const cp = beginCheckpoint(repo, 'non-git test', 'sess-7');
  check('T7 non-git checkpoint has no headSha', cp.headSha === null);
  const tools = wiredTools(repo, cp);
  tools.edit_file({ path: 'code.js', old_text: 'original code', new_text: 'edited code' });
  tools.write_file({ path: 'extra.txt', content: 'agent\n' });
  const r = undoCheckpoint(repo);
  check('T7 non-git undo works (content-based)', r.done);
  check('T7 edit restored in non-git repo', fs.readFileSync(path.join(repo, 'code.js'), 'utf8') === 'original code\n');
  check('T7 agent file removed in non-git repo', !fs.existsSync(path.join(repo, 'extra.txt')));
  check('T7 honest warning about run_command limits', r.warnings.some((w) => w.includes('run_command')));
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- TEST 8
{
  const repo = mkRepo(true);
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other base\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const cp = beginCheckpoint(repo, 'conflict test', 'sess-8');
  const tools = wiredTools(repo, cp);
  tools.edit_file({ path: 'shared.txt', old_text: 'base', new_text: 'agent edit' });
  tools.edit_file({ path: 'other.txt', old_text: 'other base', new_text: 'agent edit 2' });
  // user independently modifies a file the agent touched (after the agent did)
  fs.appendFileSync(path.join(repo, 'shared.txt'), 'user concurrent edit\n');
  const r = undoCheckpoint(repo);
  check('T8 undo REFUSES on conflict (done=false)', r.done === false);
  check('T8 conflict reported for the user-modified file', r.conflicts.some((c) => c.includes('shared.txt')));
  check('T8 user concurrent edit preserved', fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8').includes('user concurrent edit'));
  check('T8 NO partial undo — other agent-edited file also untouched',
    fs.readFileSync(path.join(repo, 'other.txt'), 'utf8') === 'agent edit 2\n');
  check('T8 nothing deleted/restored when conflicts exist', r.deleted.length === 0 && r.restored.length === 0);
  // once the user resolves (reverts) their own edit, undo succeeds
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'agent edit\n');
  const r2 = undoCheckpoint(repo);
  check('T8 undo succeeds once conflict is resolved', r2.done === true);
  check('T8 restore correct after resolution', fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8') === 'base\n');
  RESTORES.push(() => fs.rmSync(repo, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- extra
check('X1 no reset --hard / git clean in undo code (comments stripped)',
  (() => {
    const src = fs.readFileSync(new URL('../checkpoint.js', import.meta.url).pathname, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // comments may mention the banned ops
    return !/reset|['"]clean['"]/.test(code);
  })());

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }
