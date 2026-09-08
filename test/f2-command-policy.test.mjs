// F2 tests — command security & repo-escape hardening.
// SAFE commands only: echo, sleep, cat of our own fixture, node --version.
// Nothing destructive is ever executed. Rejections are asserted BEFORE any
// spawn would happen (via parseAndClassify and via the tool executor).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLASSIFICATION,
  parseAndClassify,
  tokenizeCommand,
  resolveProgramPath,
  buildCommandEnvironment,
  redactSecrets,
  checkBlocklist,
} from '../commandPolicy.js';
import { createToolImplementations } from '../agentLoop.js';

let pass = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL  ${name}: ${e.message}`); }
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-repo-'));
const state = { seenCommands: new Set(), failCounts: new Map(), wroteAny: false };
const tools = createToolImplementations(repo, state, { commandTimeoutMs: 400 });
// separate instance with a generous timeout for tests that spawn node (node
// cold-start in some environments takes multiple seconds)
const slowTools = createToolImplementations(repo, state, { commandTimeoutMs: 15000 });

// ---- TEST 1: normal argv command executes correctly -----------------------
await t('T1 normal argv command (echo hello)', async () => {
  const out = await tools.run_command({ cmd: 'echo hello' });
  assert.match(out, /^exit code: 0/);
  assert.match(out, /hello/);
});

// ---- TEST 2: command with arguments executes correctly --------------------
await t('T2 command with arguments (node -e, quoted args)', async () => {
  const out = await slowTools.run_command({ cmd: 'node -e "console.log(process.argv.length)" a b' });
  assert.match(out, /^exit code: 0/);
  assert.match(out, /--- stdout ---\n3/); // argv = [node, a, b] (-e drops the script)
  const out2 = await tools.run_command({ cmd: "printf '%s-%s' x y" });
  assert.match(out2, /x-y/);
});

// ---- TEST 3: unsupported shell chaining is rejected -----------------------
await t('T3 shell chaining (&&) is rejected', async () => {
  const v = parseAndClassify('echo one && echo two');
  assert.strictEqual(v.ok, false);
  assert.throws(() => tools.run_command({ cmd: 'echo one && echo two' }), /REFUSED/);
});
await t('T3b semicolon chaining is rejected', async () => {
  assert.strictEqual(parseAndClassify('echo a; echo b').ok, false);
});
await t('T3c double pipe (||) is rejected', async () => {
  assert.strictEqual(parseAndClassify('false || echo x').ok, false);
});

// ---- TEST 4: pipe attempt is rejected --------------------------------------
await t('T4 pipe (|) is rejected', async () => {
  assert.strictEqual(parseAndClassify('ls | wc -l').ok, false);
  assert.throws(() => tools.run_command({ cmd: 'echo hi | cat' }), /REFUSED/);
});

// ---- TEST 5: redirect attempt is rejected ----------------------------------
await t('T5 redirect (>) is rejected', async () => {
  assert.strictEqual(parseAndClassify('echo x > out.txt').ok, false);
  assert.strictEqual(parseAndClassify('echo x >> out.txt').ok, false);
  assert.strictEqual(parseAndClassify('cat < in.txt').ok, false);
  assert.throws(() => tools.run_command({ cmd: 'echo x > out.txt' }), /REFUSED/);
});

// ---- TEST 6: command substitution is rejected ------------------------------
await t('T6 command substitution $( ) is rejected', async () => {
  assert.strictEqual(parseAndClassify('echo $(pwd)').ok, false);
  assert.throws(() => tools.run_command({ cmd: 'echo $(pwd)' }), /REFUSED/);
});

// ---- TEST 7: backtick syntax is rejected -----------------------------------
await t('T7 backticks are rejected', async () => {
  assert.strictEqual(parseAndClassify('echo `pwd`').ok, false);
  assert.throws(() => tools.run_command({ cmd: 'echo `pwd`' }), /REFUSED/);
});
await t('T7b variable expansion $VAR is rejected', async () => {
  assert.strictEqual(parseAndClassify('echo $HOME').ok, false);
});

// ---- TEST 8: blocked command patterns are rejected without execution ------
await t('T8 blocked programs/patterns rejected', async () => {
  assert.strictEqual(parseAndClassify('sh -c anything').classification.cls, CLASSIFICATION.BLOCKED);
  assert.strictEqual(parseAndClassify('bash').classification.cls, CLASSIFICATION.BLOCKED);
  assert.strictEqual(parseAndClassify('sudo ls').classification.cls, CLASSIFICATION.BLOCKED);
  assert.strictEqual(parseAndClassify('dd if=a of=b').classification.cls, CLASSIFICATION.BLOCKED);
  assert.strictEqual(parseAndClassify('kill 123').classification.cls, CLASSIFICATION.BLOCKED);
  assert.strictEqual(parseAndClassify('xargs echo').classification.cls, CLASSIFICATION.BLOCKED);
  assert.strictEqual(parseAndClassify('env GLM_API_KEY=x node app.js').classification.cls, CLASSIFICATION.BLOCKED);
  assert.strictEqual(parseAndClassify('find . -delete').classification.cls, CLASSIFICATION.BLOCKED);
  { const v = parseAndClassify('find . -exec rm {} \\;'); assert.ok(v.ok === false || v.classification.cls === CLASSIFICATION.BLOCKED, JSON.stringify(v)); }
  assert.strictEqual(parseAndClassify('rm -rf /tmp/x').classification.cls, CLASSIFICATION.BLOCKED);
  assert.strictEqual(checkBlocklist('git push --force'), 'forced git push');
  assert.throws(() => tools.run_command({ cmd: 'sh -c echo' }), /REFUSED/);
});

// ---- TEST 9: blocked command remains blocked in auto mode -----------------
await t('T9 BLOCKED/parse-refused commands refuse in auto mode too', async () => {
  const { executeParsedToolCalls } = await import('../agentLoop.js');
  const ctx = { repoRoot: repo, tools, mode: 'auto', confirmAction: async () => { throw new Error('must not prompt'); }, state };
  const call = { function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'sudo cat /etc/passwd' }) } };
  const out = (await executeParsedToolCalls([call], ctx))[0];
  assert.match(out, /REFUSED/);
  const call2 = { function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'echo a && rm x' }) } };
  const out2 = (await executeParsedToolCalls([call2], ctx))[0];
  assert.match(out2, /REFUSED/);
});

// ---- TEST 10: safe command still works after hardening --------------------
await t('T10 SAFE_READONLY classification + execution', async () => {
  const v = parseAndClassify('git status');
  assert.strictEqual(v.classification.cls, CLASSIFICATION.SAFE_READONLY);
  const v2 = parseAndClassify('pwd');
  assert.strictEqual(v2.classification.cls, CLASSIFICATION.SAFE_READONLY);
  const out = await tools.run_command({ cmd: 'pwd' });
  assert.match(out, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const out2 = await slowTools.run_command({ cmd: 'node --version' });
  assert.match(out2, /^exit code: 0/);
});

// ---- TEST 11: existing F1 timeout behavior still passes -------------------
await t('T11 F1 timeout still enforced under argv execution', async () => {
  const t0 = Date.now();
  const out = await tools.run_command({ cmd: 'sleep 60' });
  const elapsed = Date.now() - t0;
  assert.match(out, /^status: timeout/);
  assert.match(out, /timeout_ms: 400/);
  assert.ok(elapsed >= 400 && elapsed < 20000, `elapsed=${elapsed}ms`); // upper bound generous: sandbox scheduling can delay kill delivery
});

// ---- TEST 12: repo boundary / program resolution ---------------------------
await t('T12 absolute program path refused', () => {
  assert.throws(() => resolveProgramPath('/bin/echo', repo, { PATH: '/usr/bin' }), /absolute program path/);
});
await t('T12b repo-relative program must exist/executable', () => {
  assert.throws(() => resolveProgramPath('./missing.sh', repo, { PATH: '' }), /not found in the repo/);
  const script = path.join(repo, 'ok.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho hi\n');
  fs.chmodSync(script, 0o755);
  const real = resolveProgramPath('./ok.sh', repo, { PATH: '' });
  assert.strictEqual(fs.realpathSync(script), real);
});
await t('T12c symlinked program escaping repo is refused', () => {
  fs.symlinkSync('/bin/echo', path.join(repo, 'evil.sh')); // points outside
  assert.throws(() => resolveProgramPath('./evil.sh', repo, { PATH: '' }), /outside the repo/);
});
await t('T12d .. in arguments is refused', () => {
  assert.strictEqual(parseAndClassify('cat ../../etc/passwd').ok, false);
  assert.strictEqual(parseAndClassify('cat /etc/passwd').classification.cls, CLASSIFICATION.RESTRICTED);
  assert.strictEqual(parseAndClassify('cat ~/secrets').classification.cls, CLASSIFICATION.RESTRICTED);
});
await t('T12e restricted programs classified RESTRICTED', () => {
  assert.strictEqual(parseAndClassify('curl example.com').classification.cls, CLASSIFICATION.RESTRICTED);
  assert.strictEqual(parseAndClassify('npx something').classification.cls, CLASSIFICATION.RESTRICTED);
  assert.strictEqual(parseAndClassify('rm old.txt').classification.cls, CLASSIFICATION.RESTRICTED);
});

// ---- TEST 13: confirm-mode flow still works (auto-run of readonly, prompts) 
await t('T13 executor: SAFE_READONLY auto-runs; RESTRICTED prompts even in auto', async () => {
  const { executeParsedToolCalls } = await import('../agentLoop.js');
  let prompts = 0;
  const ctxAuto = {
    repoRoot: repo, tools, mode: 'auto',
    confirmAction: async () => { prompts++; return true; },
    state: { seenCommands: new Set(), failCounts: new Map(), wroteAny: false },
  };
  const ro = (await executeParsedToolCalls(
    [{ function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'echo readonly-ok' }) } }], ctxAuto))[0];
  assert.match(ro, /readonly-ok/);
  assert.strictEqual(prompts, 0, 'SAFE_READONLY must not prompt in auto (first-time warning skipped)');
  const restricted = (await executeParsedToolCalls(
    [{ function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'touch marker.txt' }) } }], ctxAuto))[0];
  assert.match(restricted, /marker.txt|exit code/);
  assert.strictEqual(prompts, 1, 'RESTRICTED (touch) must prompt once even in auto mode');
  // rejected confirmation must NOT execute
  let prompts2 = 0;
  const ctxDeny = {
    repoRoot: repo, tools, mode: 'auto',
    confirmAction: async () => { prompts2++; return false; },
    state: { seenCommands: new Set(), failCounts: new Map(), wroteAny: false },
  };
  const denied = (await executeParsedToolCalls(
    [{ function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'touch never.txt' }) } }], ctxDeny))[0];
  assert.match(denied, /REJECTED/);
  assert.strictEqual(prompts2, 1);
  assert.ok(!fs.existsSync(path.join(repo, 'never.txt')), 'denied command must not execute');
});

// ---- TEST 14: logs / environment do not expose secrets ---------------------
await t('T14a sanitized environment drops secrets', async () => {
  const env = buildCommandEnvironment({ PATH: '/usr/bin', GLM_API_KEY: 'sk-super-secret', MY_TOKEN: 't', AWS_SECRET: 's' });
  assert.strictEqual(env.GLM_API_KEY, undefined);
  assert.strictEqual(env.MY_TOKEN, undefined);
  assert.strictEqual(env.AWS_SECRET, undefined);
  assert.strictEqual(env.PATH, '/usr/bin');
  const out = await slowTools.run_command({ cmd: 'node -e "console.log(JSON.stringify(Object.keys(process.env)))"' });
  assert.ok(!out.includes('GLM_API_KEY'), 'child env must not contain GLM_API_KEY');
});
await t('T14b redactSecrets masks keys in log strings', () => {
  const s = redactSecrets('run x GLM_API_KEY=abc123 and TOKEN: "zzz"');
  assert.ok(!s.includes('abc123'));
  assert.match(s, /GLM_API_KEY=<redacted>/);
});

// ---- tokenizer sanity -------------------------------------------------------
await t('tokenizer: quotes/escapes are literal', () => {
  assert.deepStrictEqual(tokenizeCommand("echo 'a b' c").argv, ['echo', 'a b', 'c']);
  assert.deepStrictEqual(tokenizeCommand('echo \\"x\\"').argv, ['echo', '"x"']);
  assert.deepStrictEqual(tokenizeCommand('printf "%s"').argv, ['printf', '%s']);
  assert.ok(tokenizeCommand("echo 'unterminated").error);
  assert.ok(tokenizeCommand('   ').error);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
