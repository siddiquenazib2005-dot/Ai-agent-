/**
 * bridge.js — structured client for the my-agent bridge (HTTP + SSE).
 * Used by the Android WebView app AND by Node tests (no EventSource in Node,
 * so a fetch-based reader is used there; browsers use native EventSource).
 *
 * Events consumed (never terminal text):
 *   agent.started | agent.thinking | agent.stream.delta | agent.tool.start |
 *   agent.confirmation.required | agent.tool.complete | agent.plan.ready |
 *   agent.file.changed | agent.command.output | agent.test.complete |
 *   agent.completed | agent.error
 */
'use strict';

(function (global) {
  function parseSseBlock(block) {
    let name = null, data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (name && data) { try { return { name, payload: JSON.parse(data) }; } catch { return null; } }
    return null;
  }

  /** Fetch-based SSE reader (Node / WebView without EventSource). */
  async function fetchSseReader(url, onEvent) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);
    let buf = '';
    for await (const chunk of res.body) {
      buf += new TextDecoder().decode(chunk);
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = parseSseBlock(block);
        if (ev) onEvent(ev.name, ev.payload);
      }
    }
  }

  function createAgentClient(baseUrl) {
    const listeners = new Map();   // event name -> [cb]
    let connected = false;
    let reader = null;

    function on(event, cb) { (listeners.get(event) ?? listeners.set(event, []).get(event)).push(cb); return api; }
    function fire(event, payload) { for (const cb of listeners.get(event) ?? []) { try { cb(payload); } catch { /* guard */ } } }

    const post = (p, body) => fetch(`${baseUrl}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));

    const api = {
      baseUrl,
      isConnected: () => connected,
      on,
      connect() {
        if (connected) return Promise.resolve();
        const useEventSource = typeof global.EventSource === 'function';
        if (useEventSource) {
          const es = new global.EventSource(`${baseUrl}/events`);
          es.addEventListener('open', () => { connected = true; });
          ['agent.started', 'agent.thinking', 'agent.stream.delta', 'agent.tool.start',
            'agent.confirmation.required', 'agent.tool.complete', 'agent.plan.ready',
            'agent.file.changed', 'agent.command.output', 'agent.test.complete',
            'agent.completed', 'agent.error'].forEach((name) => {
            es.addEventListener(name, (e) => { try { fire(name, JSON.parse(e.data)); } catch { /* ignore */ } });
          });
          reader = es;
          return new Promise((resolve) => setTimeout(resolve, 250));
        }
        reader = fetchSseReader(`${baseUrl}/events`, (name, payload) => fire(name, payload));
        connected = true;
        return new Promise((resolve) => setTimeout(resolve, 250));
      },
      close() { if (reader) { try { reader.close && reader.close(); } catch { /* noop */ } } connected = false; },
      health: () => fetch(`${baseUrl}/health`).then((r) => r.json()),
      listSessions: () => fetch(`${baseUrl}/sessions`).then((r) => r.json()),
      run: (body) => post('/run', body),
      confirm: (id, approved) => post(`/confirm/${encodeURIComponent(id)}`, { approved: !!approved }),
      cancel: () => post('/cancel', {}),
      undo: (repo) => post('/undo', { repo }),
    };
    return api;
  }

  global.createAgentClient = createAgentClient;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createAgentClient };
})(typeof window !== 'undefined' ? window : globalThis);