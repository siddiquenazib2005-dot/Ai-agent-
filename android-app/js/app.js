'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const read = (key, fallback = '') => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable: this session still works */ } };
  const state = { client: null, working: false, submitting: false, pending: null, files: [], repo: '', profiles: [], resume: null, stream: null, generation: 0, tools: new Map() };
  let toastTimer;
  function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
  function connection(label, kind = '') { $('connText').textContent = label; $('connection').className = 'connection ' + kind; }
  function go(screen) {
    if (!$('screen-' + screen)) screen = 'home';
    document.querySelectorAll('.screen').forEach(n => n.classList.toggle('active', n.id === 'screen-' + screen));
    document.querySelectorAll('.nav-btn').forEach(n => { const selected = n.dataset.go === screen; n.classList.toggle('active', selected); if (selected) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); });
    if (screen === 'sessions') sessions();
    if (location.hash !== '#' + screen) history.replaceState(null, '', '#' + screen);
    window.scrollTo(0, 0);
  }
  function busy(value, title, subtitle) {
    state.working = value; $('send').disabled = value || state.submitting; $('newTask').disabled = value || state.submitting; $('cancel').disabled = !value;
    $('runState').classList.toggle('working', value); $('progress').hidden = !value;
    if (title) $('currentAction').textContent = title;
    if (subtitle) $('runSubtitle').textContent = subtitle;
    if (!value) document.querySelectorAll('.event.live').forEach(n => n.classList.remove('live'));
  }
  function event(title, text = '', kind = '') {
    $('activityFeed').querySelector('.empty')?.remove();
    document.querySelectorAll('.event.live').forEach(n => n.classList.remove('live'));
    const card = node('article', 'event ' + kind);
    card.append(node('div', 'event-title', title), node('time', '', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), node('div', 'event-body', text));
    $('activityFeed').append(card);
    while ($('activityFeed').children.length > 300) $('activityFeed').firstChild.remove();
    return card;
  }
  function previewFiles() {
    $('fileList').replaceChildren();
    if (!state.files.length) $('fileList').append(node('p', 'empty', 'No file changes yet. Files appear after a successful file tool operation.'));
    for (const file of state.files) {
      const row = node('button', 'file-row'); row.append(node('span', '', file.path), node('small', '', file.op === 'create' ? 'Created ↗' : 'Modified ↗'));
      row.onclick = async () => {
        try { const data = await state.client.file(state.repo, file.path); $('previewTitle').textContent = data.path; $('previewContent').textContent = data.content; $('filePreview').hidden = false; }
        catch (err) { toast(err.message); }
      }; $('fileList').append(row);
    }
  }
  function showConfirmation(p) {
    state.pending = p.id; $('confirmTitle').textContent = p.label; $('confirmPreview').textContent = p.preview || ''; $('confirmError').textContent = '';
    $('approve').disabled = false; $('reject').disabled = false;
    if (!$('confirmation').open) $('confirmation').showModal();
    $('reject').focus();
    busy(true, p.tool === 'plan' ? 'Review the plan' : 'Waiting for your approval');
  }
  async function resolveConfirmation(approved) {
    if (!state.pending) return;
    $('approve').disabled = true; $('reject').disabled = true;
    try {
      const id = state.pending;
      await state.client.confirm(id, approved);
      if (state.pending === id) { state.pending = null; $('confirmation').close(); busy(true, approved ? 'Continuing task' : 'Action rejected'); }
    } catch (err) { $('confirmError').textContent = err.message; }
    finally { $('approve').disabled = false; $('reject').disabled = false; }
  }
  async function refreshProfiles(client) {
    const [health, result] = await Promise.all([client.health(), client.providers()]);
    if (state.client !== client) return;
    state.profiles = result.providers;
    const selected = $('provider').value || read('fj_provider');
    $('provider').replaceChildren(); $('providerList').replaceChildren(); $('models').replaceChildren();
    for (const p of result.providers) {
      const option = node('option', '', p.id + (p.configured ? '' : ' · needs key')); option.value = p.id; $('provider').append(option);
      const item = node('p', 'helper', p.id + ' · ' + p.name + '\n' + p.model + ' · ' + (p.configured ? 'Credentials configured' : 'Missing credentials')); $('providerList').append(item);
      const model = node('option'); model.value = p.model; $('models').append(model);
    }
    if (result.providers.some(p => p.id === selected)) $('provider').value = selected;
    $('model').placeholder = health.config.model + ' (default)';
    $('health').textContent = 'Bridge connected · ' + health.config.keys.length + ' configured key(s). This checks bridge configuration, not live provider availability.';
    connection('Connected', 'connected');
    $('workspaceHint').textContent = 'Host connected · review changes in confirm mode.';
  }
  async function connect() {
    const generation = ++state.generation;
    state.client?.close(); connection('Connecting'); $('connect').disabled = true;
    try {
      const client = createAgentClient($('bridgeUrl').value.trim(), { token: $('bridgeToken').value }); state.client = client;
      save('fj_bridge', client.baseUrl);
      const on = (name, fn) => client.on(name, p => { if (state.client === client) fn(p); });
      on('connection.error', p => { connection('Offline', 'error'); $('health').textContent = p.message; toast(p.message); });
      on('agent.snapshot', p => {
        state.files = p.changedFiles || []; state.repo = (p.activeRun || p.lastRun)?.repo || state.repo; previewFiles();
        if (p.activeRun) { busy(true, 'Task active on host', 'Connected to the current run. Missed streaming text is not replayed.'); $('requestText').textContent = p.activeRun.task; }
        else if (p.completion) busy(false, ({ done: 'Task finished', cancelled: 'Task cancelled', error: 'Task failed', plan_aborted: 'Plan not approved', tests_failed: 'Checks failed', limit_reached: 'Iteration limit reached' })[p.completion.status] || 'Task ended');
        else busy(false, 'Ready when you are');
        if (p.pending?.length) showConfirmation(p.pending[0]);
        else { state.pending = null; $('confirmation').close(); }
      });
      on('agent.started', p => {
        state.repo = p.repo; state.files = []; state.stream = null; state.tools.clear(); previewFiles(); $('filePreview').hidden = true;
        $('activityFeed').replaceChildren(); $('termList').replaceChildren(node('p', 'empty', 'No commands have run yet.'));
        $('requestText').textContent = p.task; $('workspaceName').textContent = p.repo.split('/').filter(Boolean).pop() || p.repo;
        busy(true, 'Understanding your task', p.model + ' · ' + p.provider); event('Task started', p.task, 'live'); go('activity');
      });
      on('agent.thinking', p => {
        busy(true, p.phase === 'planning' ? 'Planning the task' : 'Agent is working', 'Waiting for model output · iteration ' + p.iteration);
        state.stream = event(p.phase === 'planning' ? 'Creating a plan' : 'Model output', '', 'live').querySelector('.event-body');
      });
      on('agent.stream.delta', p => {
        if (!state.stream) state.stream = event('Model output', '', 'live').querySelector('.event-body');
        const text = state.stream.textContent + (p.delta || '');
        state.stream.textContent = text.length > 100000 ? '[Earlier output trimmed on device]\n' + text.slice(-90000) : text;
      });
      on('agent.tool.start', p => {
        state.stream = null;
        const label = ({ write_file: 'Creating a file', edit_file: 'Editing code', read_file: 'Reading a file', list_files: 'Inspecting files', search_code: 'Searching code', run_command: 'Running a command', git_status: 'Checking Git status' })[p.name] || p.name;
        busy(true, label); const card = event(label, '', 'live');
        const badge = node('span', 'badge', 'Running'); card.querySelector('.event-title').append(badge);
        const details = node('details'); details.append(node('summary', '', p.name + ' · details'), node('pre', '', typeof p.args === 'string' ? p.args : JSON.stringify(p.args, null, 2))); card.append(details);
        state.tools.set(p.id, { card, badge, details });
      });
      on('agent.tool.complete', p => {
        const tool = state.tools.get(p.id); if (!tool) return;
        tool.card.classList.remove('live'); tool.card.classList.add(p.status === 'ok' ? 'done' : 'error');
        tool.badge.textContent = ({ ok: 'Completed', rejected: 'Rejected', refused: 'Blocked', error: 'Failed' })[p.status] || p.status;
        tool.details.append(node('pre', '', p.result));
      });
      on('agent.confirmation.required', showConfirmation);
      on('agent.plan.ready', p => event('Plan ready for review', p.plan));
      on('agent.file.changed', p => { state.files = [p, ...state.files.filter(f => f.path !== p.path)]; previewFiles(); });
      on('agent.command.output', p => {
        $('termList').querySelector('.empty')?.remove(); const card = node('article', 'term-card');
        card.append(node('strong', '', '$ ' + p.cmd), node('p', 'helper', (p.timedOut ? 'Timed out' : 'Exit ' + p.exitCode) + ' · ' + p.durationMs + ' ms'), node('pre', '', p.result)); $('termList').append(card);
      });
      on('agent.test.complete', p => event(p.passed ? 'Checks passed' : 'Checks failed', p.cmd + ' · attempt ' + p.attempt, p.passed ? 'done' : 'error'));
      on('agent.completed', p => {
        state.stream = null;
        const title = ({ done: 'Task finished', cancelled: 'Task cancelled', plan_aborted: 'Plan not approved', tests_failed: 'Checks still failing', limit_reached: 'Iteration limit reached' })[p.status] || 'Task ended';
        busy(false, title, 'Review the timeline, file changes and terminal output.');
        event(title, p.finalAnswer || '', p.status === 'done' ? 'done' : 'error'); state.pending = null; $('confirmation').close();
      });
      on('agent.error', p => { state.stream = null; busy(false, 'Task failed', p.message); event('Task failed', p.message, 'error'); state.pending = null; $('confirmation').close(); });
      await client.connect(); await refreshProfiles(client);
    } catch (err) { if (generation === state.generation) { connection('Offline', 'error'); $('health').textContent = err.message; } }
    finally { if (generation === state.generation) $('connect').disabled = false; }
  }
  async function sessions() {
    $('sessionList').replaceChildren(node('p', 'empty', 'Loading sessions…'));
    try {
      if (!state.client) throw new Error('Connect the bridge first');
      const result = await state.client.listSessions(); $('sessionList').replaceChildren();
      for (const s of result.sessions.slice(0, 50)) {
        const card = node('article', 'session-row'); card.append(node('strong', '', s.task), node('p', '', s.repo));
        const button = node('button', 'secondary', 'Continue session'); button.onclick = () => { if (state.working) return toast('Finish the active task first'); state.resume = s.id; $('repo').value = s.repo; $('task').value = ''; $('task').placeholder = 'Describe your follow-up task…'; $('resumeNote').textContent = 'Continuing the selected session. New task clears this selection.'; go('home'); }; card.append(button); $('sessionList').append(card);
      }
      if (!result.sessions.length) $('sessionList').append(node('p', 'empty', 'No saved sessions yet.'));
    } catch (err) { $('sessionList').replaceChildren(node('p', 'empty', err.message)); }
  }
  $('taskForm').onsubmit = async e => {
    e.preventDefault(); if (state.working || state.submitting) return;
    if (!state.client?.isConnected()) { toast('Connect the bridge in Settings first'); return go('settings'); }
    state.submitting = true; $('send').disabled = true;
    const repo = $('repo').value.trim(), task = $('task').value.trim();
    try {
      if (!repo || !task) throw new Error('Project path and task are required');
      save('fj_repo', repo); save('fj_provider', $('provider').value); save('fj_model', $('model').value.trim());
      await state.client.run({ repo, task, mode: $('mode').value === 'auto' ? 'auto' : 'confirm', plan: $('mode').value === 'plan', providerId: $('provider').value || null, model: $('model').value.trim() || null, resumeSessionId: state.resume });
      go('activity');
    } catch (err) { toast(err.message); }
    finally { state.submitting = false; $('send').disabled = state.working; }
  };
  document.querySelectorAll('[data-go]').forEach(n => n.onclick = () => go(n.dataset.go));
  $('connect').onclick = connect;
  $('newTask').onclick = () => { if (state.working) return; state.resume = null; $('task').value = ''; $('resumeNote').textContent = 'The agent runs on your connected host, not inside this app.'; $('task').focus(); };
  $('cancel').onclick = async () => { $('cancel').disabled = true; try { await state.client.cancel(); $('currentAction').textContent = 'Stopping…'; $('runSubtitle').textContent = 'Waiting for the host. An executing command may take up to 30 seconds.'; } catch (err) { toast(err.message); $('cancel').disabled = !state.working; } };
  $('approve').onclick = () => resolveConfirmation(true); $('reject').onclick = () => resolveConfirmation(false);
  $('confirmation').addEventListener('cancel', e => { e.preventDefault(); resolveConfirmation(false); });
  $('closePreview').onclick = () => $('filePreview').hidden = true;
  $('undo').onclick = async () => {
    if (!state.client || state.working) return toast('Connect the bridge and finish the active run first');
    const repo = $('repo').value.trim(); if (!repo) return toast('Set a project path on Home first');
    if (!window.confirm('Undo recorded agent file changes in this project? Command effects are not reversible.')) return;
    try { const r = await state.client.undo(repo); toast(r.data.done ? 'Undo completed. Review your project.' : 'Undo refused: ' + (r.data.conflicts || []).join('; ')); state.files = []; previewFiles(); $('filePreview').hidden = true; } catch (err) { toast(err.message); }
  };
  $('bridgeUrl').value = read('fj_bridge', location.protocol.startsWith('http') && location.pathname.startsWith('/app/') ? location.origin : 'http://127.0.0.1:8787');
  $('repo').value = read('fj_repo'); $('model').value = read('fj_model');
  $('provider').onchange = () => { const p = state.profiles.find(p => p.id === $('provider').value); $('model').value = ''; $('model').placeholder = p?.model || 'Auto-routed'; };
  previewFiles(); $('termList').append(node('p', 'empty', 'No commands have run yet.'));
  window.addEventListener('pagehide', () => state.client?.close());
  window.addEventListener('pageshow', e => { if (e.persisted) connect(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.client && !state.client.isConnected()) connect(); });
  go(location.hash.slice(1) || 'home'); connect();
})();
