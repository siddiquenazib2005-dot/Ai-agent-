// F1 regression tests — run_command timeout enforcement.
// Safe: only sleeps/echoes, 400ms test timeout, all fixtures in a mkdtemp dir.
import { createToolImplementations } from '../agentLoop.js';
import fs from 'node:fs';

const repo = fs.mkdtempSync('/tmp/f1-test-');
const tools = createToolImplementations(
  repo,
  { seenCommands: new Set(), failCounts: new Map(), wroteAny: false },
  { commandTimeoutMs: 400 },
);

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** True if the process with this pid is still alive. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---- TEST 1: fast command completes normally -------------------------------
const r1 = await tools.run_command({ cmd: 'echo hello-f1' });
check('TEST1 fast command: status=success format + stdout',
  r1.startsWith('exit code: 0') && r1.includes('hello-f1') && !r1.includes('status: timeout'),
  r1.slice(0, 120));

// ---- TEST 2: command exceeding timeout is terminated (incl. children) ------
// F2-compat: the agent runs argv-only (no shell). The victim is a repo-local
// fixture script (created by THIS TEST, not by the LLM) whose shebang spawns
// sh internally; it background-kills-proof children and records their pids.
fs.writeFileSync(`${repo}/victim.sh`, '#!/bin/sh\necho $$ > leader.pid\nsleep 5 &\necho $! > sleep.pid\nwait\n');
fs.chmodSync(`${repo}/victim.sh`, 0o755);
const r2 = await tools.run_command({ cmd: './victim.sh' });
check('TEST2a timeout reported with timeout_ms',
  r2.startsWith('status: timeout') && r2.includes('timeout_ms: 400'),
  r2.slice(0, 160));
const bashPid = parseInt(fs.readFileSync(`${repo}/leader.pid`, 'utf8'), 10);
const sleepPid = parseInt(fs.readFileSync(`${repo}/sleep.pid`, 'utf8'), 10);
await new Promise((r) => setTimeout(r, 300)); // give the reaper a moment
check('TEST2b bash (group leader) is dead', !alive(bashPid), `pid=${bashPid} still alive`);
check('TEST2c background child (sleep) is dead', !alive(sleepPid), `pid=${sleepPid} still alive`);

// ---- TEST 3: stdout produced before the timeout is returned ----------------
fs.writeFileSync(`${repo}/out.sh`, '#!/bin/sh\necho stdout-before-timeout\nsleep 5\n');
fs.chmodSync(`${repo}/out.sh`, 0o755);
const r3 = await tools.run_command({ cmd: './out.sh' });
check('TEST3 partial stdout captured on timeout',
  r3.startsWith('status: timeout') && r3.includes('stdout-before-timeout'));

// ---- TEST 4: stderr produced before the timeout is returned ----------------
fs.writeFileSync(`${repo}/err.sh`, '#!/bin/sh\necho stderr-before-timeout >&2\nsleep 5\n');
fs.chmodSync(`${repo}/err.sh`, 0o755);
const r4 = await tools.run_command({ cmd: './err.sh' });
check('TEST4 partial stderr captured on timeout',
  r4.startsWith('status: timeout') && r4.includes('stderr-before-timeout'));

// ---- TEST 5: no timer / listener leak --------------------------------------
const timeoutCount = () => process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length;
const baseline = timeoutCount();
await tools.run_command({ cmd: 'sleep 5' }); // timeout path (plain argv)
await tools.run_command({ cmd: 'echo x' });  // success path
await tools.run_command({ cmd: 'sleep 5' }); // timeout path again
const after = timeoutCount();
check('TEST5 no leaked timers (Timeout resources back to baseline)',
  after === baseline, `baseline=${baseline} after=${after}`);

// Watchdog: if a dangling handle keeps the event loop alive, node hangs and
// the shell-level `timeout` wrapper reports failure.
const watchdog = setTimeout(() => {
  console.log('FAIL  TEST5b process did not exit (leaked handle keeps loop alive)');
  process.exit(1);
}, 5000);
watchdog.unref();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
