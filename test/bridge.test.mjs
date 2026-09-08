// F5 bridge tests — inline OpenAI-compatible mock LLM + live HTTP/SSE bridge.
// Asserts the full structured-event flow: started → thinking → tool.start →
// (confirmation.required → POST /confirm) → tool.complete → completed,
// plus reject path, file.changed, and secret redaction over the wire.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startBridge } from '../bridge/server.js';

let passed = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}`); }
};
const json = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));

// --- inline OpenAI-compatible mock --------------------------------------
// Scenario by task marker:
//   "confirm"  -> write_file tool call (exercises confirmation path)
//   otherwise  -> list_files tool call
// After a tool result is present in history -> final text answer.
const MOCK_KEY = 'sk-mock-secret-abcdef1234567890';
function startMockLlm() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const b = JSON.parse(body || '{}');
        const msgs = b.messages || [];
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
        const hasToolResult = msgs.some((m) => m.role === 'tool');
        const isPlanPrompt = msgs[0]?.content?.includes('PLAN MODE');
        const isSplitPrompt = msgs[0]?.content?.includes('sub-tasks');
        let out;
        if (isPlanPrompt) {
          out = { choices: [{ message: { role: 'assistant', content: '1. inspect\n2. edit\n3. test' }, finish_reason: 'stop' }] };
        } else if (isSplitPrompt) {
          out = { choices: [{ message: { role: 'assistant', content: '["one"]' }, finish_reason: 'stop' }] };
        } else if (hasToolResult) {
          out = { choices: [{ message: { role: 'assistant', content: 'DONE: task complete via mock.' }, finish_reason: 'stop' }] };
        } else if (lastUser?.content?.includes('confirm')) {
          out = {
            choices: [{
              message: {
                role: 'assistant', content: null,
                tool_calls: [{ id: 'call-write', type: 'function', function: { name: 'write_file', arguments: '{"path":"bridge-created.txt","content":"made by bridge"}' } }],
              }, finish_reason: 'tool_calls',
            }],
          };
        } else if (lastUser) {
          out = {
            choices: [{
              message: {
                role: 'assistant', content: null,
                tool_calls: [{ id: 'call-ls', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
              }, finish_reason: 'tool_calls',
            }],
          };
        } else {
          out = { choices: [{ message: { role: 'assistant', content: 'DONE' }, finish_reason: 'stop' }] };
        }
        // Also report token usage for the token-tracking path.
        out.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

/** Consumes /events manually (no EventSource in Node) and returns a collector. */
function openEvents(baseUrl, hub) {
  const events = [];
  const waiters = [];
  let started = false;
  const fire = (name, data) => {
    events.push({ name, data });
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].name === name) { waiters[i].resolve(); waiters.splice(i, 1); }
    }
  };
  (async () => {
    try {
      const res = await fetch(`${baseUrl}/events`);
      let buf = '';
      for await (const chunk of res.body) {
        buf += new TextDecoder().decode(chunk);
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let name = null; let data = null;
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (name && data) {
            try { fire(name, JSON.parse(data)); } catch { /* ignore malformed */ }
          }
        }
      }
    } catch { /* server closed */ }
    started = true;
  })();
  return {
    events,
    waitFor: (name, timeoutMs = 15000) => {
      if (events.some((e) => e.name === name)) return Promise.resolve();
      if (started) return Promise.reject(new Error('stream closed before event'));
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${name} (got: ${events.map((e) => e.name).join(',')})`)), timeoutMs);
        waiters.push({ name, resolve: () => { clearTimeout(t); resolve(); } });
      });
    },
    close: () => {},
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------
const mock = await startMockLlm();
process.env.GLM_API_KEY = MOCK_KEY;
process.env.GLM_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
process.env.GLM_MODEL = 'mock-model';
process.env.FAST_MODEL = 'mock-model-fast';

const bridge = await startBridge({ port: 0 });
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-repo-'));
fs.writeFileSync(path.join(repo, 'existing.js'), '// existing\n');

// ---- TEST 1: auto run full event flow --------------------------------------
{
  const sse = openEvents(bridge.baseUrl);
  await new Promise((r) => setTimeout(r, 200)); // let SSE connect
  const resp = await json(`${bridge.baseUrl}/run`, { repo, task: 'list files', mode: 'auto' });
  check('T1 /run accepted', resp.status === 200 && resp.data.accepted === true);
  await sse.waitFor('agent.started');
  await sse.waitFor('agent.thinking');
  await sse.waitFor('agent.tool.start');
  await sse.waitFor('agent.tool.complete');
  await sse.waitFor('agent.completed');
  const names = sse.events.map((e) => e.name);
  check('T1 started event has repo/sessionId', sse.events.find((e) => e.name === 'agent.started').data.repo === repo);
  check('T1 list_files tool.start emitted', sse.events.find((e) => e.name === 'agent.tool.start').data.name === 'list_files');
  check('T1 tool.complete status ok', sse.events.find((e) => e.name === 'agent.tool.complete').data.status === 'ok');
  check('T1 completed has finalAnswer', String(sse.events.find((e) => e.name === 'agent.completed').data.finalAnswer).length > 0);
  check('T1 events ordered (start < thinking < completed)',
    names.indexOf('agent.started') < names.indexOf('agent.thinking') &&
    names.indexOf('agent.thinking') < names.indexOf('agent.completed'));
  check('T1 no secret in event stream', !JSON.stringify(sse.events).includes(MOCK_KEY));
  sse.close();
  await new Promise((r) => setTimeout(r, 300)); // let run fully settle
}

// ---- TEST 2: confirm-approve flow -------------------------------------------
{
  const sse = openEvents(bridge.baseUrl);
  await new Promise((r) => setTimeout(r, 200));
  const resp = await json(`${bridge.baseUrl}/run`, { repo, task: 'write a file confirm', mode: 'confirm' });
  check('T2 accepted', resp.status === 200);
  await sse.waitFor('agent.confirmation.required');
  const cf = sse.events.find((e) => e.name === 'agent.confirmation.required');
  check('T2 confirmation carries preview + label', cf.data.label.includes('write_file') && cf.data.preview.includes('bridge-created.txt'));
  const cRes = await json(`${bridge.baseUrl}/confirm/${encodeURIComponent(cf.data.id)}`, { approved: true });
  check('T2 confirm resolves', cRes.status === 200 && cRes.data.resolved === true);
  await sse.waitFor('agent.file.changed');
  check('T2 file.changed emitted', sse.events.find((e) => e.name === 'agent.file.changed').data.path === 'bridge-created.txt');
  await sse.waitFor('agent.completed');
  check('T2 file actually created after approval', fs.existsSync(path.join(repo, 'bridge-created.txt')));
  check('T2 tool.complete status ok', sse.events.filter((e) => e.name === 'agent.tool.complete').some((e) => e.data.status === 'ok'));
  sse.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.unlinkSync(path.join(repo, 'bridge-created.txt')); // clean for T3
}

// ---- TEST 3: confirm-reject flow --------------------------------------------
{
  const sse = openEvents(bridge.baseUrl);
  await new Promise((r) => setTimeout(r, 200));
  await json(`${bridge.baseUrl}/run`, { repo, task: 'write a file confirm', mode: 'confirm' });
  await sse.waitFor('agent.confirmation.required');
  const cf = sse.events.find((e) => e.name === 'agent.confirmation.required');
  await json(`${bridge.baseUrl}/confirm/${encodeURIComponent(cf.data.id)}`, { approved: false });
  await sse.waitFor('agent.completed');
  check('T3 rejected tool has status=rejected', sse.events.filter((e) => e.name === 'agent.tool.complete').some((e) => e.data.status === 'rejected'));
  check('T3 file NOT created after rejection', !fs.existsSync(path.join(repo, 'bridge-created.txt')));
  sse.close();
  await new Promise((r) => setTimeout(r, 300));
}

// ---- TEST 4: health + sessions + validation ---------------------------------
{
  const h = await fetch(`${bridge.baseUrl}/health`).then((r) => r.json());
  check('T4 health ok + keys masked', h.ok === true && h.config.keys.every((k) => k.masked !== MOCK_KEY && k.masked.includes('…')));
  check('T4 health provider/model present', typeof h.config.provider === 'string' && typeof h.config.model === 'string');
  check('T4 no active run after completion', h.activeRun === null);
  const s = await fetch(`${bridge.baseUrl}/sessions`).then((r) => r.json());
  check('T4 sessions endpoint lists repo sessions', s.sessions.some((x) => x.repo === repo));
  const err = await json(`${bridge.baseUrl}/run`, { repo, task: 'x', mode: 'bad' });
  check('T4 bad mode rejected 400', err.status === 400);
  const bad = await json(`${bridge.baseUrl}/confirm/nope`, { approved: true });
  check('T4 unknown confirm id -> 404', bad.status === 404);
}

// ---- TEST 5: undo via bridge ------------------------------------------------
{
  const sse = openEvents(bridge.baseUrl);
  await new Promise((r) => setTimeout(r, 200));
  await json(`${bridge.baseUrl}/run`, { repo, task: 'write a file confirm', mode: 'confirm' });
  await sse.waitFor('agent.confirmation.required');
  const cf = sse.events.find((e) => e.name === 'agent.confirmation.required');
  await json(`${bridge.baseUrl}/confirm/${encodeURIComponent(cf.data.id)}`, { approved: true });
  await sse.waitFor('agent.completed');
  check('T5 file exists pre-undo', fs.existsSync(path.join(repo, 'bridge-created.txt')));
  const u = await json(`${bridge.baseUrl}/undo`, { repo });
  check('T5 undo returns done with deleted entry', u.status === 200 && u.data.done === true && u.data.deleted.includes('bridge-created.txt'));
  check('T5 file removed by undo', !fs.existsSync(path.join(repo, 'bridge-created.txt')));
  sse.close();
}

mock.close();
bridge.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }