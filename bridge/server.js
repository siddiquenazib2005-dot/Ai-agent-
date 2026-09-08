/**
 * bridge/server.js — HTTP/SSE bridge for remote my-agent clients (Android app).
 *
 * Architecture choice (documented): for this environment, a LOCAL HTTP +
 * Server-Sent-Events bridge is the realistic option — the Node core already
 * streams, SSE is a one-way push protocol (perfect for agent progress), and
 * confirmation is a simple POST. No WebSocket or broker dependency. The CLI is
 * untouched; the bridge is an ADDITIONAL interface.
 *
 * Events (structured; clients never parse terminal text):
 *   agent.started | agent.thinking | agent.stream.delta | agent.tool.start |
 *   agent.confirmation.required | agent.tool.complete | agent.plan.ready |
 *   agent.file.changed | agent.command.output | agent.test.complete |
 *   agent.completed | agent.error
 *
 * Security: intended for LOCAL/trusted networks — no caller authentication.
 * Do not expose to the public internet. API keys are never logged and are
 * masked in /health.
 */

import http from 'node:http';
import { runAgentLoop, undoLastCheckpoint, listSessions } from '../agentLoop.js';
import { loadLlmConfig } from '../llmConfig.js';

const VERSION = '0.1.0';

function maskKey(k) {
  if (!k || k.length < 8) return '***';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** Minimal SSE hub for broadcasting to EventSource clients. */
function createHub() {
  const clients = new Set();
  return {
    clientCount: () => clients.size,
    add: (res) => { clients.add(res); return () => clients.delete(res); },
    broadcast: (name, payload) => {
      const data = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const res of clients) {
        try { res.write(data); } catch { clients.delete(res); }
      }
    },
  };
}

export async function startBridge({ port = 8787, host = '127.0.0.1' } = {}) {
  const hub = createHub();
  const pending = new Map();   // confirmId -> { label, preview, resolve }
  const readyQueue = [];       // confirmIds announced (emit precedes confirmAction)
  let activeRun = null;        // { repo, task, startedAt }
  let cancelRequested = false;

  const config = loadLlmConfig(process.env);

  // --- emitter wired into runAgentLoop -------------------------------------
  const emitter = {
    emit(name, payload) {
      if (name === 'agent.confirmation.required') {
        pending.set(payload.id, { label: payload.label, preview: null, resolve: null });
        readyQueue.push(payload.id);
      }
      hub.broadcast(name, payload);
    },
  };

  const confirmAction = async (label, preview) => {
    const id = readyQueue.shift();
    if (!id || !pending.has(id)) return false; // no matching event -> reject safely
    const entry = pending.get(id);
    entry.label = label; entry.preview = preview;
    return new Promise((resolve) => { entry.resolve = resolve; });
  };

  const cancelRequestedFn = () => cancelRequested;

  // --- HTTP server ----------------------------------------------------------
  const server = http.createServer();
  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, obj, ctype = 'application/json') => {
      res.writeHead(code, {
        'content-type': ctype,
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') return send(204, '');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, {
        ok: true,
        version: VERSION,
        config: {
          provider: config.providerName,
          model: config.model,
          timeoutMs: config.timeoutMs,
          keys: config.keyManager.entries.map((k) => ({ name: k.name, masked: maskKey(k.key), enabled: !k.disabledUntil })),
        },
        sessions: listSessions().length,
        activeRun: activeRun ? { repo: activeRun.repo, task: activeRun.task, startedAt: activeRun.startedAt } : null,
        clients: hub.clientCount(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(': connected\n\n');
      const remove = hub.add(res);
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
      req.on('close', () => { remove(); clearInterval(heartbeat); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/sessions') {
      return send(200, { sessions: listSessions() });
    }
    // POST endpoints need a JSON body.
    let body = '';
    for await (const chunk of req) body += chunk;
    let json = {};
    try { json = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'invalid JSON body' }); }

    if (req.method === 'POST' && url.pathname === '/run') {
      if (activeRun) return send(409, { error: 'an agent run is already active; wait for agent.completed or POST /cancel' });
      const { repo, task, mode = 'confirm', plan = false, split = false, model } = json;
      if (typeof repo !== 'string' || typeof task !== 'string' || !repo.trim() || !task.trim()) {
        return send(400, { error: '"repo" and "task" (strings) are required' });
      }
      if (!['confirm', 'auto'].includes(mode)) return send(400, { error: 'mode must be "confirm" or "auto"' });
      activeRun = { repo, task, startedAt: new Date().toISOString() };
      cancelRequested = false;
      send(200, { accepted: true, repo, task, mode });
      // Run in the background; all progress is pushed over /events.
      (async () => {
        try {
          await runAgentLoop(repo, task, {
            mode, plan: Boolean(plan), split: Boolean(split),
            modelOverride: typeof model === 'string' && model ? model : null,
            emitter, confirmAction, cancelRequested: cancelRequestedFn,
          });
        } catch (err) {
          hub.broadcast('agent.error', { message: String(err.message), hint: 'see agent.log' });
        } finally {
          activeRun = null;
          cancelRequested = false;
        }
      })();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/cancel') {
      if (!activeRun) return send(409, { error: 'no active run to cancel' });
      cancelRequested = true;
      return send(200, { cancelled: true });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/confirm/')) {
      const id = decodeURIComponent(url.pathname.slice('/confirm/'.length));
      const entry = pending.get(id);
      if (!entry) return send(404, { error: `no pending confirmation with id ${id}` });
      if (!entry.resolve) return send(409, { error: 'confirmation not awaiting resolution yet' });
      entry.resolve(!!json.approved);
      pending.delete(id);
      return send(200, { resolved: true, approved: !!json.approved });
    }
    if (req.method === 'POST' && url.pathname === '/undo') {
      if (typeof json.repo !== 'string' || !json.repo) return send(400, { error: '"repo" is required' });
      try {
        const r = undoLastCheckpoint(json.repo);
        return send(200, { done: r.done, restored: r.restored, deleted: r.deleted, conflicts: r.conflicts, warnings: r.warnings });
      } catch (err) {
        return send(500, { error: err.message });
      }
    }
    return send(404, { error: `no route: ${req.method} ${url.pathname}` });
  });

  server.listen(port, host);
  // With port 0 the real port is assigned asynchronously — poll until bound.
  let actual = port;
  for (let i = 0; i < 100; i++) {
    const a = server.address?.();
    if (a?.port) { actual = a.port; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    baseUrl: `http://${host}:${actual}`,
    port: actual,
    close: () => { try { server.close(); } catch { /* already closed */ } },
    _hub: hub,
  };
}