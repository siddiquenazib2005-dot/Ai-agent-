// android-bridge-client.test.mjs — exercises android-app/js/bridge.js (the
// exact client the Android WebView uses) against a live bridge + mock LLM.
// PROTOCOL VERIFIED here; device runtime is not (no Android toolchain).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startBridge } from '../bridge/server.js';

let passed = 0;
const failures = [];
const check = (name, cond) => { if (cond) { passed++; console.log(`PASS  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}`); } };

const MOCK_KEY = 'sk-android-secret-1234567890';
function startMock() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const msgs = JSON.parse(b).messages || [];
        const hasTool = msgs.some((m) => m.role === 'tool');
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
        let out;
        if (hasTool) out = { choices: [{ message: { role: 'assistant', content: 'CLIENT-TEST-DONE' }, finish_reason: 'stop' }] };
        else if (lastUser?.content?.includes('confirm')) {
          out = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"client-made.txt","content":"x"}' } }] }, finish_reason: 'tool_calls' }] };
        } else {
          out = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'list_files', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
        }
        out.usage = { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 };
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => s.close() }));
  });
}

const mock = await startMock();
process.env.GLM_API_KEY = MOCK_KEY;
process.env.GLM_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
process.env.GLM_MODEL = 'android-mock';

// load the WebView's client module (as a Node module; global binding set)
await import('../android-app/js/bridge.js');
const createAgentClient = globalThis.createAgentClient;
check('P0 createAgentClient exported by app client', typeof createAgentClient === 'function');

const bridge = await startBridge({ port: 0 });
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'android-repo-'));
fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');

function makeClient() {
  const client = createAgentClient(bridge.baseUrl);
  const got = [];
  const waiters = [];
  ['agent.started', 'agent.thinking', 'agent.tool.start', 'agent.confirmation.required',
    'agent.tool.complete', 'agent.file.changed', 'agent.command.output', 'agent.test.complete',
    'agent.completed', 'agent.error'].forEach((n) => client.on(n, (p) => {
    got.push({ n, p });
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].n === n) { waiters[i].r(); waiters.splice(i, 1); }
  }));
  client.waitFor = (n, ms = 15000) => new Promise((resolve, reject) => {
    if (got.some((e) => e.n === n)) return resolve();
    const t = setTimeout(() => reject(new Error(`timeout ${n}; got ${got.map((e) => e.n).join(',')}`)), ms);
    waiters.push({ n, r: () => { clearTimeout(t); resolve(); } });
  });
  return { client, got };
}

// T1: auto flow through the app client
{
  const { client, got } = makeClient();
  await client.connect();
  check('T1 connect ok', client.isConnected());
  const h = await client.health();
  check('T1 health ok + masked key (no raw key)', h.ok && JSON.stringify(h).indexOf(MOCK_KEY) === -1 && h.config.keys[0].masked.includes('…'));
  const r = await client.run({ repo, task: 'list files', mode: 'auto' });
  check('T1 run accepted', r.status === 200);
  await client.waitFor('agent.tool.start');
  await client.waitFor('agent.completed');
  check('T1 got started', got.some((e) => e.n === 'agent.started'));
  check('T1 got list_files tool.start', got.find((e) => e.n === 'agent.tool.start')?.p.name === 'list_files');
  check('T1 tool.complete ok', got.filter((e) => e.n === 'agent.tool.complete').some((e) => e.p.status === 'ok'));
  check('T1 completed payload good', got.find((e) => e.n === 'agent.completed')?.p.status === 'done');
  const ss = await client.listSessions();
  check('T1 sessions listed', ss.sessions.some((x) => x.repo === repo));
  client.close();
}

// T2: confirmation through the app client (approve -> file created)
{
  const { client, got } = makeClient();
  await client.connect();
  await client.run({ repo, task: 'write a file confirm', mode: 'confirm' });
  await client.waitFor('agent.confirmation.required');
  const cf = got.find((e) => e.n === 'agent.confirmation.required');
  check('T2 confirmation has preview', String(cf.p.preview).includes('client-made.txt'));
  const cr = await client.confirm(cf.p.id, true);
  check('T2 confirm resolved', cr.status === 200);
  await client.waitFor('agent.completed');
  check('T2 file created after approve', fs.existsSync(path.join(repo, 'client-made.txt')));
  check('T2 file.changed seen', got.some((e) => e.n === 'agent.file.changed'));
  client.close();
}

// T3: reject via client -> file NOT created
{
  const { client, got } = makeClient();
  await client.connect();
  fs.unlinkSync(path.join(repo, 'client-made.txt'));
  await client.run({ repo, task: 'write a file confirm', mode: 'confirm' });
  await client.waitFor('agent.confirmation.required');
  const cf = got.find((e) => e.n === 'agent.confirmation.required');
  await client.confirm(cf.p.id, false);
  await client.waitFor('agent.completed');
  check('T3 rejected -> tool.complete rejected', got.filter((e) => e.n === 'agent.tool.complete').some((e) => e.p.status === 'rejected'));
  check('T3 file NOT created after reject', !fs.existsSync(path.join(repo, 'client-made.txt')));
  client.close();
}

mock.close(); bridge.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }