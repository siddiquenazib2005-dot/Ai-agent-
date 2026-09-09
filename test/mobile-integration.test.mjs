import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startBridge } from '../bridge/server.js';
import { OpenAICompatibleProvider } from '../providers/openaiCompatibleProvider.js';
import { loadLlmConfig } from '../llmConfig.js';
import { createToolImplementations } from '../agentLoop.js';
await import('../android-app/js/bridge.js');
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const delay = ms => new Promise(r => setTimeout(r, ms));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fj-mobile-'));
const requests = [];
const mock = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const body = JSON.parse(b); requests.push(body);
  const system = body.messages[0].content;
  const lastUser = body.messages.filter(m => m.role === 'user').at(-1)?.content || '';
  if (lastUser.includes('STALL')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': stalled\n\n'); return; }
  if (lastUser.includes('ERROR_ECHO')) { res.writeHead(401); res.end('server echoed ' + req.headers.authorization); return; }
  let msg;
  if (system.includes('PLAN MODE')) msg = { role: 'assistant', content: '1. Create hello.txt\n2. Review changes' };
  else if (body.messages.some(m => m.role === 'tool')) msg = { role: 'assistant', content: 'Mock task finished. नमस्ते 🚀' };
  else msg = { role: 'assistant', content: null, tool_calls: [{ id: 'write-test', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'Hello from test\n' }) } }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (msg.tool_calls) res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: msg.tool_calls.map((t, i) => ({ ...t, index: i })) } }] }) + '\n\n');
  else for (const s of [msg.content.slice(0, 10), msg.content.slice(10)]) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: s } }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + mock.address().port;
process.env.LLM_API_KEY = 'TEST_ONLY_PROVIDER_CREDENTIAL'; process.env.LLM_MODEL = 'mock-model'; process.env.LLM_BASE_URL = base;
const token = 'TEST_ONLY_BRIDGE_CREDENTIAL_32_CHARACTERS';
const bridge = await startBridge({ port: 0, token });
const events = [];
let client = globalThis.createAgentClient(bridge.baseUrl, { token });
for (const name of ['agent.snapshot','agent.started','agent.plan.ready','agent.confirmation.required','agent.stream.delta','agent.file.changed','agent.completed','agent.error']) client.on(name, p => events.push({ name, p }));
const wait = async (name, predicate = () => true) => {
  for (let i = 0; i < 300; i++) { const e = events.find(e => e.name === name && predicate(e.p)); if (e) return e.p; await delay(10); }
  throw new Error('Event not received: ' + name);
};
const post = (route, body) => fetch(bridge.baseUrl + route, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
try {
  await check('unauthorized API and SSE requests rejected', async () => { for (const p of ['/health','/events','/sessions','/providers']) assert.equal((await fetch(bridge.baseUrl+p)).status,401); });
  await check('foreign origin rejected even with auth', async () => { assert.equal((await fetch(bridge.baseUrl+'/health', {headers:{origin:'https://untrusted.example',authorization:'Bearer '+token}})).status,403); });
  await check('remote bind requires token', async () => { await assert.rejects(startBridge({host:'0.0.0.0',port:0,token:''}),/BRIDGE_TOKEN/); });
  await check('health reveals no key fragments', async () => { const h=await client.health(); assert.equal(h.config.keys[0].masked,'[configured…]'); assert.ok(!JSON.stringify(h).includes(process.env.LLM_API_KEY)); });
  await check('client rejects insecure remote HTTP and embedded credentials', async () => { assert.throws(()=>globalThis.createAgentClient('http://192.168.1.10:8787'),/HTTPS/); assert.throws(()=>globalThis.createAgentClient('https://user:pass@example.com'),/credentials/); });
  await check('connect waits for live SSE and receives snapshot', async () => { await client.connect(); assert.ok(client.isConnected()); await wait('agent.snapshot'); });
  await check('invalid repository and unknown provider rejected before run', async () => { assert.equal((await post('/run',{repo:'/missing-fj-repo',task:'x'})).status,400); assert.equal((await post('/run',{repo,task:'x',providerId:'missing'})).status,400); });
  await check('plan approval uses HTTP; cannot write before approval', async () => {
    events.length=0; await client.run({repo,task:'Create a greeting',plan:true,model:'selected-model',mode:'confirm'});
    await wait('agent.plan.ready'); const p=await wait('agent.confirmation.required',p=>p.tool==='plan');
    assert.ok(!fs.existsSync(path.join(repo,'hello.txt')));
    assert.equal((await post('/confirm/'+p.id,{approved:'true'})).status,400);
    assert.equal((await post('/undo',{repo})).status,409);
    assert.equal((await post('/run',{repo,task:'second'})).status,409);
    await client.confirm(p.id,true); const tool=await wait('agent.confirmation.required',p=>p.tool==='write_file');
    assert.ok(!fs.existsSync(path.join(repo,'hello.txt'))); await client.confirm(tool.id,true);
    await wait('agent.completed'); assert.equal(fs.readFileSync(path.join(repo,'hello.txt'),'utf8'),'Hello from test\n');
    assert.ok(requests.every(r=>r.model==='selected-model'));
  });
  await check('structured Unicode streaming and bounded file preview', async () => {
    const text=events.filter(e=>e.name==='agent.stream.delta').map(e=>e.p.delta).join(''); assert.match(text,/नमस्ते 🚀/);
    assert.equal((await client.file(repo,'hello.txt')).content,'Hello from test\n');
    assert.equal((await post('/file',{repo,path:'../outside'})).status,403);
  });
  await check('snapshot restores pending approval after reconnect', async () => {
    fs.unlinkSync(path.join(repo,'hello.txt')); events.length=0; await delay(20);
    await client.run({repo,task:'Create another greeting',mode:'confirm'}); await wait('agent.confirmation.required');
    client.close(); await delay(30); events.length=0; await client.connect();
    const snap=await wait('agent.snapshot',p=>p.pending?.length>0); assert.equal(snap.pending[0].tool,'write_file');
    await client.cancel(); const done=await wait('agent.completed'); assert.equal(done.status,'cancelled');
    assert.ok(!fs.existsSync(path.join(repo,'hello.txt')));
  });
  await check('provider timeout includes stalled response body', async () => {
    const p=new OpenAICompatibleProvider({baseUrl:base,model:'m',timeoutMs:100});
    await assert.rejects(p.chat([{role:'user',content:'STALL'}],{apiKey:process.env.LLM_API_KEY}), e=>e.kind==='timeout');
  });
  await check('provider error bodies never echo API credentials', async () => {
    const p=new OpenAICompatibleProvider({baseUrl:base,model:'m',timeoutMs:1000});
    await assert.rejects(p.chat([{role:'user',content:'ERROR_ECHO'}],{apiKey:process.env.LLM_API_KEY}),e=>!e.message.includes(process.env.LLM_API_KEY)&&e.kind==='auth');
  });
  await check('cancellation interrupts stalled LLM streaming', async () => {
    await delay(30); events.length=0; await client.run({repo,task:'STALL',mode:'confirm'}); await wait('agent.started'); await client.cancel();
    assert.equal((await wait('agent.completed')).status,'cancelled');
  });
  await check('regex search works without changing file safety', async () => {
    fs.writeFileSync(path.join(repo,'regex.txt'),'hello123'); const tools=createToolImplementations(repo,{});
    assert.match(tools.search_code({query:'hello[0-9]+',regex:true}),/regex.txt/);
  });
  await check('provider selection preserves adapter and authorized multi-key config', async () => {
    const c=loadLlmConfig({...process.env,LLM_KEYS:'TEST_ONLY_SECOND_KEY'},'environment'); assert.equal(c.providerId,'environment'); assert.equal(c.keyManager.entries.length,2);
  });
  await check('request size cap rejects oversized task bodies', async () => { assert.equal((await post('/run',{repo,task:'x'.repeat(70000)})).status,413); });
  await check('SSE close releases connection', async () => { client.close(); await delay(80); assert.equal(bridge._hub.clientCount(),0); });
} finally { client.close(); await bridge.close(); mock.close(); mock.closeAllConnections(); fs.rmSync(repo,{recursive:true,force:true}); }
console.log(passed+' mobile integration checks passed');
