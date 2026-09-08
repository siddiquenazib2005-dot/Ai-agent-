'use strict';
(function (global) {
  function createAgentClient(baseUrl, { token = '', fetchImpl = global.fetch.bind(global) } = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use an HTTP(S) bridge origin without credentials or a path');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote bridges require HTTPS; use USB reverse for local HTTP');
    baseUrl = url.origin;
    const listeners = new Map(); let connected = false, controller, connecting;
    const headers = () => token ? { authorization: 'Bearer ' + token } : {};
    const fire = (name, p) => { for (const cb of listeners.get(name) || []) cb(p); };
    const request = async (route, body) => {
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15000);
      try {
        const res = await fetchImpl(baseUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
        const data = await res.json(); if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        return { status: res.status, data };
      } finally { clearTimeout(timer); }
    };
    const api = { baseUrl, isConnected: () => connected,
      on(name, cb) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(cb); return api; },
      connect() {
        if (connected) return Promise.resolve(); if (connecting) return connecting;
        const ac = new AbortController(); controller = ac;
        let accept, reject; const ready = new Promise((a, r) => { accept = a; reject = r; }); connecting = ready;
        const timer = setTimeout(() => ac.abort(), 10000);
        (async () => {
          let reader;
          try {
            const res = await fetchImpl(baseUrl + '/events', { headers: headers(), signal: ac.signal });
            if (!res.ok || !res.body) throw new Error('Stream connection failed: HTTP ' + res.status);
            if (ac.signal.aborted) throw new Error('Connection cancelled');
            reader = res.body.getReader(); clearTimeout(timer); connected = true; accept(); fire('connection.open', {});
            const decoder = new TextDecoder(); let buffer = '';
            for (;;) {
              const { done, value } = await reader.read(); if (done) break;
              buffer += decoder.decode(value, { stream: true });
              if (buffer.length > 2097152) throw new Error('Stream event exceeded size limit');
              let match;
              while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
                let name = '', data = [];
                for (const line of block.split(/\r?\n/)) { if (line.startsWith('event:')) name = line.slice(6).trim(); if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
                if (name && data.length) fire(name, JSON.parse(data.join('\n')));
              }
            }
            if (!ac.signal.aborted) throw new Error('Stream disconnected; reconnect to recover task state');
          } catch (err) { reject(err); if (!ac.signal.aborted) fire('connection.error', { message: err.message }); }
          finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); reader?.releaseLock(); if (controller === ac) { connected = false; connecting = null; } }
        })(); return ready;
      },
      close() { controller?.abort(); controller = null; connected = false; connecting = null; },
      health: () => request('/health').then(r => r.data), providers: () => request('/providers').then(r => r.data), listSessions: () => request('/sessions').then(r => r.data),
      run: body => request('/run', body), confirm: (id, approved) => request('/confirm/' + encodeURIComponent(id), { approved }), cancel: () => request('/cancel', {}), undo: repo => request('/undo', { repo }), file: (repo, path) => request('/file', { repo, path }).then(r => r.data),
    }; return api;
  }
  global.createAgentClient = createAgentClient;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createAgentClient };
})(typeof window !== 'undefined' ? window : globalThis);
