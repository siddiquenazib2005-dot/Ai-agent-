import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const patch = 'scripts/core-integration.patch';
if (fs.existsSync(new URL('../' + patch, import.meta.url))) {
  const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const already = run(['apply', '--check', '--reverse', '--unidiff-zero', patch]);
  if (already.status === 0) console.log('Core integration already applied.');
  else {
    const check = run(['apply', '--check', '--unidiff-zero', patch]);
    if (check.status !== 0) throw new Error('Core patch conflicts with this checkout; no changes applied. Review the patch manually. Git must be installed.');
    const applied = run(['apply', '--unidiff-zero', patch]);
    if (applied.status !== 0) throw new Error('Core patch could not be applied. Inspect git status.');
    console.log('Reviewed core integration applied to working tree. Run tests and commit these source changes.');
  }
}
