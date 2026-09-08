import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { runAgentLoop, undoLastCheckpoint, listSessions, safeResolve, assertInsideRepo } from '../agentLoop.js';
import { loadLlmConfig } from '../llmConfig.js';
import { redactSecrets, registerSecrets } from '../commandPolicy.js';
const APP = fileURLToPath(new URL('../android-app/', import.meta.url)).replace(/\/$/, '');
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1']);
function clean(v) {
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return v;
}
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
/** Single-run local bridge. Remote binding requires authentication and TLS/tunnel.
 * Snapshots recover current state after reconnect; missed deltas are not replayed. */
export async function startBridge({ port = 8787, host = '127.0.0.1', token = process.env.BRIDGE_TOKEN || '' } = {}) {
  if (!LOCAL.has(host) && token.length < 32) throw new Error('Remote binding requires BRIDGE_TOKEN (32+ characters) and TLS or a secure tunnel');
  registerSecrets([token]);
  const clients = new Set(), pending = new Map(), queue = [], files = new Map();
  let activeRun = null, lastRun = null, completion = null, cancelled = false, controller, running = Promise.resolve();
  const config = () => loadLlmConfig(process.env); config();
  const snapshot = () => ({ activeRun, lastRun, completion, changedFiles: [...files.values()], pending: [...pending.values()].map(e => e.payload) });
  const broadcast = (name, payload) => {
    const data = 'event: ' + name + '\ndata: ' + JSON.stringify(clean(payload)) + '\n\n';
    for (const res of clients) {
      if (res.destroyed || res.writableLength > 1024 * 1024) { res.destroy(); clients.delete(res); }
      else res.write(data);
    }
  };
  const emitter = { emit(name, payload) {
    if (name === 'agent.confirmation.required') { pending.set(payload.id, { payload }); queue.push(payload.id); }
    if (name === 'agent.file.changed') files.set(payload.path, payload);
    if (name === 'agent.completed') completion = payload;
    broadcast(name, payload);
  } };
  const confirmAction = async () => {
    const id = queue.shift(), entry = pending.get(id);
    if (!entry || cancelled) return false;
    return new Promise(resolve => {
      entry.resolve = approved => { clearTimeout(entry.timer); pending.delete(id); resolve(approved); };
      entry.timer = setTimeout(() => entry.resolve(false), 300000);
    });
  };
  const rejectPending = () => { for (const e of pending.values()) { clearTimeout(e.timer); e.resolve?.(false); } pending.clear(); queue.length = 0; };
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = new Set(['https://appassets.androidplatform.net', ...(process.env.BRIDGE_ALLOWED_ORIGINS || '').split(',').filter(Boolean)]);
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) allowed.add('http://' + h + ':' + server.address()?.port);
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', ...(origin && allowed.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) };
    const send = (status, obj) => { if (!res.headersSent) res.writeHead(status, headers); res.end(JSON.stringify(clean(obj))); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const requestHost = new URL('http://' + (req.headers.host || '')).hostname.replace(/^\[|\]$/g, '');
      if (LOCAL.has(host) && !LOCAL.has(requestHost)) return send(403, { error: 'Untrusted host' });
      if (origin && !allowed.has(origin)) return send(403, { error: 'Untrusted origin' });
      if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
      if (req.method === 'GET' && url.pathname.startsWith('/app/')) {
        const file = safeResolve(APP, decodeURIComponent(url.pathname.slice(5)) || 'index.html'); assertInsideRepo(APP, file);
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }[path.extname(file)];
        if (!mime || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, { error: 'Asset not found' });
        res.writeHead(200, { ...headers, 'content-type': mime }); return res.end(fs.readFileSync(file));
      }
      if (token && !equal(req.headers.authorization, 'Bearer ' + token)) return send(401, { error: 'Bridge authorization required' });
      if (req.method === 'GET' && url.pathname === '/health') {
        const c = config(); return send(200, { ok: true, version: '0.2.0', config: { provider: c.providerName, providerId: c.providerId, model: c.model, timeoutMs: c.timeoutMs, keys: c.keyManager.entries.map((k, i) => ({ name: 'Key ' + (i + 1), masked: '[configured…]', enabled: k.disabledUntil <= Date.now() })) }, sessions: listSessions().length, activeRun, clients: clients.size });
      }
      if (req.method === 'GET' && url.pathname === '/providers') return send(200, { providers: config().profiles });
      if (req.method === 'GET' && url.pathname === '/sessions') return send(200, { sessions: listSessions() });
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('event: agent.snapshot\ndata: ' + JSON.stringify(clean(snapshot())) + '\n\n'); clients.add(res);
        const timer = setInterval(() => res.write(': ping\n\n'), 15000);
        res.on('close', () => { clearInterval(timer); clients.delete(res); }); return;
      }
      if (req.method !== 'POST') return send(404, { error: 'Unknown route' });
      let body = '', size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) return send(413, { error: 'Request too large' }); body += chunk; }
      let json; try { json = JSON.parse(body || '{}'); } catch { return send(400, { error: 'Invalid JSON body' }); }
      if (!json || Array.isArray(json) || typeof json !== 'object') return send(400, { error: 'Body must be a JSON object' });
      if (url.pathname === '/run') {
        if (activeRun) return send(409, { error: 'An agent run is already active' });
        const { repo, task, mode = 'confirm', plan = false, split = false, providerId, model, resumeSessionId } = json;
        if (typeof repo !== 'string' || typeof task !== 'string' || !repo.trim() || !task.trim()) return send(400, { error: 'Repository and task are required' });
        if (!['confirm', 'auto'].includes(mode) || typeof plan !== 'boolean' || typeof split !== 'boolean') return send(400, { error: 'Invalid execution flags' });
        if (providerId != null && typeof providerId !== 'string') return send(400, { error: 'Invalid provider profile' });
        let root, c;
        try { root = fs.realpathSync(repo); if (!fs.statSync(root).isDirectory()) throw new Error(); c = loadLlmConfig(process.env, providerId); } catch { return send(400, { error: 'Repository or provider profile is unavailable' }); }
        if (!c.hasKey) return send(400, { error: 'Configure provider credentials on the bridge host first' });
        activeRun = { repo: root, task, startedAt: new Date().toISOString(), providerId: c.providerId, model: model || c.model };
        lastRun = activeRun; completion = null; files.clear(); rejectPending(); cancelled = false; controller = new AbortController();
        send(200, { accepted: true });
        running = (async () => {
          try { await runAgentLoop(root, task, { mode, plan, split, providerId: c.providerId, modelOverride: typeof model === 'string' && model ? model : null, resumeSessionId: typeof resumeSessionId === 'string' ? resumeSessionId : null, emitter, confirmAction, signal: controller.signal, cancelRequested: () => cancelled }); }
          catch (err) {
            if (cancelled) emitter.emit('agent.completed', { status: 'cancelled', finalAnswer: 'Cancelled by user. Review changes already made.' });
            else { completion = { status: 'error', finalAnswer: redactSecrets(err.message) }; broadcast('agent.error', { message: err.message }); }
          } finally { activeRun = null; cancelled = false; rejectPending(); broadcast('agent.snapshot', snapshot()); }
        })(); return;
      }
      if (url.pathname === '/cancel') { if (!activeRun) return send(409, { error: 'No active run' }); cancelled = true; controller.abort(); rejectPending(); return send(200, { requested: true }); }
      if (url.pathname.startsWith('/confirm/')) {
        if (typeof json.approved !== 'boolean') return send(400, { error: 'approved must be a boolean' });
        const e = pending.get(decodeURIComponent(url.pathname.slice(9)));
        if (!e) return send(404, { error: 'Confirmation no longer pending' });
        if (!e.resolve) return send(409, { error: 'Confirmation not ready; retry' });
        e.resolve(json.approved); return send(200, { resolved: true, approved: json.approved });
      }
      if (url.pathname === '/file') {
        if (!lastRun || json.repo !== lastRun.repo || !files.has(json.path)) return send(403, { error: 'Only files changed in the latest bridge task can be previewed' });
        if (/(^|\/)(\.env(?:\..*)?|providers\.json|credentials[^/]*|[^/]*\.(key|pem|jks|keystore))$/i.test(json.path)) return send(403, { error: 'Sensitive preview blocked' });
        const file = safeResolve(lastRun.repo, json.path); assertInsideRepo(lastRun.repo, file);
        if (!fs.statSync(file).isFile() || fs.statSync(file).size > 262144) return send(413, { error: 'Preview supports text files up to 256 KB' });
        const bytes = fs.readFileSync(file); if (bytes.includes(0)) return send(415, { error: 'Binary preview unsupported' });
        return send(200, { path: json.path, content: bytes.toString('utf8') });
      }
      if (url.pathname === '/undo') {
        if (activeRun) return send(409, { error: 'Finish the active run before undo' });
        if (typeof json.repo !== 'string' || !json.repo) return send(400, { error: 'Repository required' });
        const result = undoLastCheckpoint(json.repo); files.clear(); return send(200, result);
      }
      return send(404, { error: 'Unknown route' });
    } catch { return send(400, { error: 'Request failed; check path and configuration' }); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  return { baseUrl: 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + actual, port: actual,
    close() { cancelled = true; controller?.abort(); rejectPending(); for (const r of clients) r.end(); clients.clear(); server.close(); server.closeAllConnections(); return running; },
    _hub: { clientCount: () => clients.size, broadcast },
  };
}
