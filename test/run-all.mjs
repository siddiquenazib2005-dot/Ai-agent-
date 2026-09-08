import { spawn } from 'node:child_process';
import fs from 'node:fs';
// Suites share a checkpoint registry, so run serially, never node --test in parallel.
let failed = false;
for (const file of fs.readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.mjs')).sort()) {
  console.log('\n=== ' + file + ' ===');
  const code = await new Promise(resolve => {
    const p = spawn(process.execPath, ['test/' + file], { stdio: 'inherit' });
    const timer = setTimeout(() => { console.error('Suite timed out: ' + file); p.kill('SIGKILL'); }, 60000);
    p.on('error', () => { clearTimeout(timer); resolve(1); });
    p.on('exit', code => { clearTimeout(timer); resolve(code ?? 1); });
  });
  if (code !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
