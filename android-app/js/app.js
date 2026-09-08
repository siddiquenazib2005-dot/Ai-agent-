/* my-agent mobile console — logic (works in WebView + Node for tests). */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const state = {
    client: null,
    baseUrl: localStorage.getItem('ma_bridge') || 'http://127.0.0.1:8787',
    mode: 'confirm',
    working: false,
    pendingConfirm: null,
    changedFiles: [],
    termEntries: [],
    plan: null,
  };

  // ---------- helpers -------------------------------------------------------
  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined) n.textContent = txt;
    return n;
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2600);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function go(screen) {
    document.querySelectorAll('.screen').forEach((s) => { s.classList.remove('active'); s.style.display = 'none'; });
    const target = $('screen-' + screen);
    target.style.display = 'block'; target.classList.add('active');
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.go === screen));
    if (screen === 'sessions') renderSessions();
    if (screen === 'files') renderFiles();
    if (screen === 'terminal') renderTerminal();
    if (screen === 'settings') refreshHealth();
  }
  function setPill(txt, cls) { $('connText').textContent = txt; $('connPill').className = 'status-pill' + (cls ? ' ' + cls : ''); }

  // ---------- activity feed -------------------------------------------------
  function addActivity(head, body, kind) {
    const feed = $('activityFeed');
    const card = el('div', 'activity');
    const h = el('div', 'a-head');
    const dot = el('span', 'pulse');
    dot.textContent = kind === 'done' ? '✓' : '●';
    const htxt = el('span');
    htxt.textContent = head;
    h.appendChild(dot); h.appendChild(htxt);
    card.appendChild(h);
    if (body) { const b = el('div', 'a-body'); b.textContent = body; card.appendChild(b); }
    const st = el('span', 'st'); st.textContent = new Date().toLocaleTimeString();
    card.appendChild(st);
    feed.appendChild(card);
    feed.scrollTop = feed.scrollHeight;
    return card;
  }

  function toolBadge(status) {
    const map = { ok: ['badge ok', 'Completed'], wait: ['badge wait', 'Waiting for approval'], run: ['badge run', 'Running'], err: ['badge err', 'Failed'], rejected: ['badge err', 'Rejected'], refused: ['badge err', 'Refused'] };
    const [cls, txt] = map[status] || ['badge wait', status || '…'];
    const b = el('span', cls); b.textContent = txt; return b;
  }

  function addToolCard(name, args, id) {
    const feed = $('activityFeed');
    const card = el('div', 'tool-card');
    card.id = 'tool-' + id;
    const row = el('div', 't-row');
    const nm = el('span', 't-name'); nm.textContent = name.toUpperCase();
    const argsTxt = JSON.stringify(args || {});
    nm.title = argsTxt;
    row.appendChild(nm);
    const badge = toolBadge('run'); badge.dataset.st = 'run';
    row.appendChild(badge);
    const detail = el('div', 't-detail');
    const pre = el('pre'); pre.textContent = argsTxt;
    detail.appendChild(pre);
    card.appendChild(row); card.appendChild(detail);
    card.addEventListener('click', () => card.classList.toggle('open'));
    feed.appendChild(card);
    return card;
  }
  function setToolStatus(id, status, result) {
    const card = $('tool-' + id);
    if (!card) return;
    const badge = card.querySelector('.badge');
    badge.className = 'badge ' + (['ok','wait','err'].includes(status.split(' ')[0]) ? status.split(' ')[0] : 'err');
    badge.textContent = status === 'ok' ? 'Completed' : status === 'wait' ? 'Waiting for approval' : status === 'run' ? 'Running' : (status.toUpperCase());
    if (result) {
      let detail = card.querySelector('.t-detail pre');
      if (detail) detail.textContent = detail.textContent + '\n\n' + String(result).slice(0, 2000);
    }
  }
// ---------- screens: sessions / files / terminal / plan --------------------
  function renderSessions() {
    const list = $('sessionList');
    list.innerHTML = '';
    const home = $('homeSessions');
    home.innerHTML = '';
    state.client.listSessions().then((r) => {
      const s = r.sessions || [];
      s.forEach((sess) => {
        const li = el('li');
        const t = el('div'); t.textContent = sess.task || '(no task)';
        const m = el('div', 's-meta');
        m.textContent = `${sess.id} · ${sess.repo} · msgs ${sess.messages} · ${sess.updatedAt}`;
        const btn = el('button'); btn.textContent = 'Resume';
        btn.addEventListener('click', () => {
          $('inpRepo').value = sess.repo; $('inpTask').value = sess.task || '';
          localStorage.setItem('ma_repo', sess.repo);
          go('task');
          toast('Session selected');
        });
        li.appendChild(t); li.appendChild(m); li.appendChild(btn);
        list.appendChild(li);
        if (home.children.length < 5) home.appendChild(li.cloneNode(true));
      });
    }).catch((e) => { list.appendChild(el('div', 'dim', 'Cannot reach bridge: ' + e.message)); });
  }

  function renderFiles() {
    const list = $('fileList');
    list.innerHTML = '';
    if (!state.changedFiles.length) { list.appendChild(el('div', 'dim', 'No files changed in this session yet.')); return; }
    state.changedFiles.forEach((f) => {
      const it = el('div', 'f-item');
      const p = el('span', 'mono'); p.textContent = f.path;
      const op = el('span', 'f-op ' + f.op); op.textContent = f.op;
      it.append(p, op);
      list.appendChild(it);
    });
  }

  function renderTerminal() {
    const list = $('termList');
    list.innerHTML = '';
    if (!state.termEntries.length) { list.appendChild(el('div', 'dim', 'No commands executed yet.')); return; }
    state.termEntries.forEach((t) => {
      const card = el('div', 'term-card ' + (t.exit === 0 ? 'exit0' : 'exit1'));
      const c = el('div', 't-cmd'); c.textContent = '$ ' + t.cmd;
      const o = el('div', 't-out'); o.textContent = (t.out || '').slice(0, 2500);
      const m = el('div', 't-meta'); m.textContent = `exit ${t.exit} · ${t.ms}ms`;
      card.append(c, o, m);
      list.appendChild(card);
    });
  }

  function renderPlan(planText, approveEnabled) {
    const ol = $('planSteps');
    ol.innerHTML = '';
    const steps = String(planText || '').split(/\r?\n/).map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
    (steps.length ? steps : ['(no plan steps produced)']).forEach((s) => {
      const li = el('li'); li.textContent = s; ol.appendChild(li);
    });
    $('btnApprovePlan').style.opacity = approveEnabled ? '1' : '.4';
    $('btnApprovePlan').dataset.enabled = approveEnabled ? '1' : '0';
    $('btnRejectPlan').style.opacity = approveEnabled ? '1' : '.4';
  }

  function openConfirm(id, label, preview) {
    state.pendingConfirm = id;
    $('cfLabel').textContent = label;
    const pre = $('cfPreview');
    pre.innerHTML = '';
    String(preview || '').split('\n').forEach((line) => {
      const d = el('div');
      if (line.startsWith('+ ')) { d.className = 'add'; d.textContent = line; }
      else if (line.startsWith('- ')) { d.className = 'del'; d.textContent = line; }
      else d.textContent = line;
      pre.appendChild(d);
    });
    $('confirmModal').classList.remove('hidden');
  }
  function closeModal() { $('confirmModal').classList.add('hidden'); state.pendingConfirm = null; }
// ---------- actions -------------------------------------------------------
  function sendTask() {
    if (state.working) { toast('Agent is busy — wait or cancel'); return; }
    const repo = $('inpRepo').value.trim();
    const task = $('inpTask').value.trim();
    if (!repo || !task) { toast('Repository and task are required'); return; }
    localStorage.setItem('ma_repo', repo);
    const prompts = JSON.parse(localStorage.getItem('ma_recent') || '[]');
    prompts.unshift(task);
    localStorage.setItem('ma_recent', JSON.stringify(prompts.slice(0, 5)));
    renderRecents();
    state.client.run({
      repo, task, mode: state.mode,
      plan: state.mode === 'plan',
      model: $('inpModel').value.trim() || null,
    }).then((r) => {
      if (r.status === 409) toast('A run is already active');
    }).catch((e) => toast('Run failed: ' + e.message));
    addActivity('Task queued', task, 'run');
    go('activity');
  }
  function renderRecents() {
    const list = $('recentPrompts');
    list.innerHTML = '';
    JSON.parse(localStorage.getItem('ma_recent') || '[]').slice(0, 5).forEach((p) => {
      const li = el('li'); li.textContent = p;
      li.addEventListener('click', () => { $('inpTask').value = p; });
      list.appendChild(li);
    });
  }

  // ---------- init ----------------------------------------------------------
  function init() {
    $('inpRepo').value = localStorage.getItem('ma_repo') || '';
    $('inpBridge').value = state.baseUrl;
    document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.plan === '1') { state.mode = 'plan'; markMode(); }
      go(b.dataset.go);
    }));
    document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
    document.querySelectorAll('.mode-btn[data-mode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.mode; markMode(); }));
    function markMode() {
      document.querySelectorAll('.mode-btn[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    }
    markMode();
    $('btnSend').addEventListener('click', sendTask);
    $('btnSaveBridge').addEventListener('click', () => {
      state.baseUrl = $('inpBridge').value.trim().replace(/\/$/, '');
      localStorage.setItem('ma_bridge', state.baseUrl);
      connectBridge();
      toast('Bridge: ' + state.baseUrl);
    });
    $('btnApprove').addEventListener('click', () => {
      if (state.pendingConfirm) state.client.confirm(state.pendingConfirm, true);
      closeModal();
    });
    $('btnReject').addEventListener('click', () => {
      if (state.pendingConfirm) state.client.confirm(state.pendingConfirm, false);
      closeModal();
    });
    $('btnCloseModal').addEventListener('click', () => {
      if (state.pendingConfirm) state.client.confirm(state.pendingConfirm, false);
      closeModal();
    });
    $('btnApprovePlan').addEventListener('click', () => {
      if ($('btnApprovePlan').dataset.enabled !== '1') return;
      state.plan = null; renderPlan('', false);
      state.mode = 'confirm';
      go('task');
      setTimeout(sendTask, 120);
    });
    $('btnRejectPlan').addEventListener('click', () => { state.plan = null; renderPlan('', false); go('task'); });
    $('btnModeConfirm').addEventListener('click', () => { state.mode = 'confirm'; markMode(); });
    $('btnModeAuto').addEventListener('click', () => { state.mode = 'auto'; markMode(); });
    $('btnUndo').addEventListener('click', () => {
      const repo = $('inpRepo').value.trim();
      if (!repo) { toast('Set repository first'); return; }
      state.client.undo(repo).then((r) => {
        toast(r.data.done ? `Undone: ${r.data.restored.length} restored, ${r.data.deleted.length} removed` : 'Undo aborted: ' + (r.data.conflicts || r.data.warnings || []).join('; '));
      }).catch((e) => toast('Undo error: ' + e.message));
    });
    renderRecents();
    connectBridge();
    go('home');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
// ---------- bridge wiring --------------------------------------------------
  function connectBridge() {
    if (state.client) { try { state.client.close(); } catch { /* noop */ } }
    state.client = window.createAgentClient(state.baseUrl);
    state.changedFiles = [];
    state.termEntries = [];
    state.plan = null;

    state.client.on('agent.started', (p) => {
      state.working = true;
      setPill('running', 'busy');
      $('stAgentStatus').textContent = 'running';
      $('stRepo').textContent = p.repo; $('stModel').textContent = p.model;
      $('stMode').textContent = p.mode || state.mode;
      $('stProvider').textContent = p.provider || '—';
      $('activitySession').textContent = p.sessionId ? '· ' + p.sessionId : '';
      addActivity('Agent started', `${p.task}\nmodel ${p.model} · mode ${p.mode}`, 'run');
    });
    state.client.on('agent.thinking', (p) => {
      addActivity(`Thinking (iteration ${p.iteration})`, p.model || '', 'run');
    });
    state.client.on('agent.stream.delta', (p) => {
      const feed = $('activityFeed');
      const last = feed.children[feed.children.length - 1];
      if (last && last.classList.contains('activity') && last.querySelector('.a-body')) {
        let b = last.querySelector('.a-body');
        b.textContent += p.delta;
        if (b.textContent.length > 4000) b.textContent = b.textContent.slice(-3000) + ' …';
      }
    });
    state.client.on('agent.tool.start', (p) => {
      addToolCard(p.name, p.args, p.id);
      addActivity('Tool → ' + p.name, JSON.stringify(p.args), 'run');
    });
    state.client.on('agent.tool.complete', (p) => {
      setToolStatus(p.id, p.status, p.result);
      if (p.status === 'rejected') toast('Action rejected');
      if (p.status === 'refused') toast('Action refused by security policy');
      if (p.status === 'error') toast('Tool error: ' + String(p.result).slice(0, 80));
    });
    state.client.on('agent.confirmation.required', (p) => {
      addActivity('Approval needed', p.label, 'run');
      openConfirm(p.id, p.label, p.preview);
    });
    state.client.on('agent.plan.ready', (p) => {
      state.plan = p.plan;
      renderPlan(p.plan, true);
    });
    state.client.on('agent.file.changed', (p) => {
      state.changedFiles.unshift({ path: p.path, op: p.op });
      renderFiles();
    });
    state.client.on('agent.command.output', (p) => {
      const exitM = String(p.result).match(/^exit code: (\S+)/m);
      const msM = String(p.result).match(/(\d+)ms/);
      state.termEntries.unshift({
        cmd: p.cmd, out: p.result,
        exit: exitM ? (exitM[1] === '0' ? 0 : 1) : (String(p.result).startsWith('status: timeout') ? 124 : 1),
        ms: msM ? Number(msM[1]) : 0,
      });
      renderTerminal();
    });
    state.client.on('agent.test.complete', (p) => {
      addActivity(`Tests ${p.passed ? 'PASSED ✓' : 'FAILED ✗'}`, `${p.cmd} (attempt ${p.attempt})`, p.passed ? 'done' : 'run');
    });
    state.client.on('agent.completed', (p) => {
      state.working = false;
      setPill('connected', 'ok');
      $('stAgentStatus').textContent = p.status === 'plan_aborted' ? 'idle (plan aborted)' : 'idle';
      const extra = p.usage ? `\n\n[usage] in ${p.usage.prompt} · out ${p.usage.completion} · calls ${p.usage.calls}` : '';
      addActivity('Agent completed', String(p.finalAnswer).slice(0, 1500) + extra, 'done');
      closeModal();
    });
    state.client.on('agent.error', (p) => {
      state.working = false;
      setPill('error', 'err');
      addActivity('Agent error', `${p.message}\n${p.hint || ''}`, 'err');
      closeModal();
    });

    state.client.connect().then(refreshHealth).catch((e) => { setPill('offline', 'err'); toast('Bridge unreachable: ' + e.message); });
  }

  function refreshHealth() {
    if (!state.client) return;
    state.client.health().then((h) => {
      if (!h.ok) return;
      $('setConnStatus').textContent = 'connected ✓';
      $('setProvider').textContent = h.config.model + ' @ ' + h.config.provider;
      $('setKeys').textContent = h.config.keys.map((k) => k.masked).join('  ');
      setPill('connected', 'ok');
      $('inpModelCfg').placeholder = h.config.model;
    }).catch(() => { $('setConnStatus').textContent = 'unreachable'; setPill('offline', 'err'); });
  }