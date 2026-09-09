'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const store = { get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const state = {
    client: null, connected: false, busy: false, submitting: false, pendingId: null,
    tasks: [], repos: [], profiles: [], repo: store.get('jarvis.repo'), dir: '', filter: 'all',
    task: null, tools: new Map(), output: '', outputExpanded: false, startedAt: 0,
    steps: [
      ['understand', 'Understanding task'], ['plan', 'Planning'], ['inspect', 'Reading project files'],
      ['code', 'Writing code'], ['checks', 'Running checks'], ['finish', 'Finalizing changes']
    ].map(([id, label]) => ({ id, label, status: 'pending', at: null }))
  };
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  let toastTimer;
  function toast(message) { $('toast').textContent = friendly(message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3600); }
  function friendly(error) {
    const text = String(error?.message || error || 'Something went wrong');
    if (/fetch|network|connect|abort|stream/i.test(text)) return 'Jarvis could not reach the agent bridge. Open Settings to retry.';
    if (/repository/i.test(text)) return 'That project is not available on the connected host.';
    if (/provider|credential|key/i.test(text)) return 'The selected AI provider is not configured on the host.';
    return 'Jarvis could not complete that action. Open diagnostics for technical details.';
  }
  function diagnostics(error) { $('diagnosticsText').textContent = String(error?.stack || error?.message || error || 'No diagnostics.'); }
  function setConnection(connected, running = false) {
    state.connected = connected;
    $('avatarStatus').parentElement.className = 'avatar ' + (running ? 'running' : connected ? 'ready' : '');
    $('disconnectBanner').hidden = connected;
    $('diagnosticsText').textContent = connected ? 'Agent bridge connected. Repository and task data are live.' : $('diagnosticsText').textContent;
  }
  function go(name) {
    if (!$('screen-' + name)) name = 'home';
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    document.querySelectorAll('.bottom-nav [data-go]').forEach(b => b.classList.toggle('active', b.dataset.go === name));
    if (name === 'tasks') { $('tasksListView').hidden = false; $('taskDetailView').hidden = true; renderTasks(); }
    if (name === 'files') loadFiles();
    history.replaceState(null, '', '#' + name); window.scrollTo(0, 0);
  }
  function relativeTime(value) {
    const ms = Date.now() - new Date(value || 0).getTime(); if (!Number.isFinite(ms) || ms < 0) return 'now';
    const m = Math.floor(ms / 60000); if (m < 1) return 'now'; if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; return Math.floor(h / 24) + 'd ago';
  }
  function normalizedStatus(status) {
    if (status === 'done' || status === 'completed') return 'completed';
    if (status === 'error' || status === 'tests_failed' || status === 'failed' || status === 'limit_reached') return 'failed';
    if (status === 'running') return 'running'; return 'pending';
  }
  function taskCard(task) {
    const button = node('button', 'task-card'); button.type = 'button';
    const main = node('span', 'task-card-main'); main.append(node('strong', '', task.task || 'Untitled task'));
    const meta = node('span', 'task-meta', '⌘ ' + ((task.repo || '').split('/').filter(Boolean).pop() || 'Repository')); main.append(meta);
    const status = normalizedStatus(task.status);
    const time = node('span', 'status-time'); time.append(node('i', 'status-dot ' + status, status === 'completed' ? '✓' : status === 'failed' ? '×' : status === 'running' ? '•' : '')); time.append(document.createTextNode(relativeTime(task.updatedAt || task.createdAt)));
    const more = node('span', 'more-button', '⋮'); button.append(main, time, more);
    button.onclick = () => openTask(task); return button;
  }
  function renderTasks() {
    const active = state.task && state.busy ? [{ ...state.task, status: 'running', updatedAt: new Date().toISOString() }] : [];
    const merged = [...active, ...state.tasks.filter(t => !active.some(a => a.id && a.id === t.id))];
    const recent = $('recentTasks'); recent.replaceChildren(); merged.slice(0, 3).forEach(t => recent.append(taskCard(t)));
    if (!merged.length) recent.append(node('div', 'empty-state', state.connected ? 'No tasks yet. Describe your first task above.' : 'Task history lives on your computer. Start the bridge with npm run bridge, then connect in Settings.'));
    const list = $('allTasks'); list.replaceChildren(); const filtered = merged.filter(t => state.filter === 'all' || normalizedStatus(t.status) === state.filter);
    filtered.forEach(t => list.append(taskCard(t))); if (!filtered.length) list.append(node('div', 'empty-state', 'No ' + (state.filter === 'all' ? '' : state.filter + ' ') + 'tasks.'));
  }
  async function refreshData() {
    if (!state.client) return;
    try {
      const [sessions, repos, providers, health] = await Promise.all([state.client.listSessions(), state.client.repositories(), state.client.providers(), state.client.health()]);
      state.tasks = sessions.sessions || []; state.repos = repos.repositories || []; state.profiles = providers.providers || [];
      if (state.repo && !state.repos.some(r => r.path === state.repo)) state.repos.unshift({ path: state.repo, name: state.repo.split('/').filter(Boolean).pop() || state.repo });
      renderRepos(); renderTasks(); await loadSavedProfiles(); renderProviderSettings(health); setConnection(true, Boolean(health.activeRun));
    } catch (error) { diagnostics(error); setConnection(false); toast(error); }
  }
  function renderRepos() {
    const select = $('repoSelect'); select.replaceChildren();
    if (!state.repos.length) select.append(new Option('Repository', ''));
    for (const repo of state.repos) select.append(new Option(repo.name, repo.path));
    if (state.repo && [...select.options].some(o => o.value === state.repo)) select.value = state.repo;
    $('repoPathInput').value = state.repo;
  }
  // --- provider credentials -------------------------------------------------
  // Keys are entered here but stored ONLY on the bridge host (settingsStore.js).
  let savedProfiles = [], providerTypes = ['openai-compatible'], lastHealth = null;
  let reconnectTimer = null, reconnectDelay = 4000;
  const PRESETS = [
    { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
    { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { label: 'Gemini (OpenAI-compatible)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
    { label: 'GLM / BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
    { label: 'Local (Ollama / LM Studio)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder' },
  ];
  function settingsStatus(message, ok = null) {
    const el = $('providerStatus'); el.textContent = message;
    el.className = 'status-text' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
  }
  function renderProviderSettings(health = null) {
    if (health) lastHealth = health; else health = lastHealth;
    const id = store.get('jarvis.provider', '');
    const saved = savedProfiles.find(p => p.id === id) || savedProfiles[0];
    const profile = state.profiles.find(p => p.id === id) || state.profiles[0];
    $('providerValue').textContent = saved?.label || profile?.name || health?.config?.provider || 'Not configured';
    $('modelValue').textContent = store.get('jarvis.model') || saved?.model || profile?.model || health?.config?.model || 'Auto';
    const configured = savedProfiles.some(p => p.configured) || Boolean(health?.config?.keys?.length);
    $('keyValue').textContent = configured ? 'Saved on host' : 'Not configured';
  }
  function fillProviderForm(p) {
    $('profileLabel').value = p.label || ''; $('providerBaseUrl').value = p.baseUrl || ''; $('providerModel').value = p.model || '';
    $('providerKey').value = ''; $('providerKey').placeholder = p.configured ? 'Key already saved — leave blank to keep it' : 'Paste key — saved on the host only';
    settingsStatus('Editing ' + (p.label || p.id) + '. Leave the key blank to keep the saved one.');
  }
  function renderProfileList() {
    const box = $('profileList'); box.replaceChildren();
    if (!savedProfiles.length) {
      box.append(node('div', 'empty-state', state.connected ? 'No API keys saved yet. Add one above.' : 'Connect to the bridge to load saved keys.'));
      return;
    }
    const activeId = store.get('jarvis.provider', '');
    for (const p of savedProfiles) {
      const row = node('div', 'profile-row' + (p.id === activeId ? ' active' : ''));
      const main = node('div', 'profile-main');
      main.append(node('strong', '', p.label), node('span', 'profile-meta', [p.model, p.configured ? 'key saved' : 'no key', p.id === activeId ? 'active' : ''].filter(Boolean).join(' · ')));
      const use = node('button', 'link-button', 'Use'); use.type = 'button';
      use.onclick = () => { store.set('jarvis.provider', p.id); store.set('jarvis.model', ''); renderProfileList(); renderProviderSettings(); settingsStatus((p.label || p.id) + ' is now the active provider.', true); };
      const edit = node('button', 'link-button', 'Edit'); edit.type = 'button'; edit.onclick = () => fillProviderForm(p);
      const remove = node('button', 'link-button danger', 'Remove'); remove.type = 'button'; remove.onclick = () => forgetProfileRow(p);
      row.append(main, use, edit, remove); box.append(row);
    }
  }
  async function loadSavedProfiles() {
    if (!state.client) return;
    try {
      const data = await state.client.settings();
      savedProfiles = data.profiles || []; providerTypes = data.providerNames?.length ? data.providerNames : providerTypes;
    } catch (error) { diagnostics(error); savedProfiles = []; }
    const select = $('providerType'); const current = select.value; select.replaceChildren();
    for (const name of providerTypes) select.append(new Option(name, name));
    if (current && providerTypes.includes(current)) select.value = current;
    if (!store.get('jarvis.provider') && savedProfiles[0]) store.set('jarvis.provider', savedProfiles[0].id);
    renderProfileList();
  }
  async function saveProviderSettings() {
    if (!state.connected || !state.client) { settingsStatus('Connect to the agent bridge first — keys are saved on the host, not inside the app.', false); return; }
    const payload = {
      label: $('profileLabel').value.trim(), name: $('providerType').value || 'openai-compatible',
      baseUrl: $('providerBaseUrl').value.trim(), model: $('providerModel').value.trim(), makeDefault: true,
    };
    const key = $('providerKey').value; if (key) payload.apiKey = key;
    $('saveProvider').disabled = true; settingsStatus('Saving on the host…');
    try {
      const data = await state.client.saveSettings(payload);
      savedProfiles = data.profiles || []; $('providerKey').value = '';
      if (data.profile?.id) store.set('jarvis.provider', data.profile.id);
      renderProfileList(); renderProviderSettings();
      settingsStatus('Saved. ' + (data.profile?.label || 'Profile') + ' is now the active provider.', true);
      await refreshData();
    } catch (error) { diagnostics(error); settingsStatus(String(error?.message || 'Could not save these settings.'), false); }
    finally { $('saveProvider').disabled = false; }
  }
  async function testProviderKey() {
    if (!state.connected || !state.client) { settingsStatus('Connect to the agent bridge first.', false); return; }
    $('testProvider').disabled = true; settingsStatus('Sending one real request to the provider…');
    try {
      const result = await state.client.testSettings(store.get('jarvis.provider') || '');
      settingsStatus(result.message || (result.ok ? 'Provider responded.' : 'Provider test failed.'), Boolean(result.ok));
    } catch (error) { diagnostics(error); settingsStatus(String(error?.message || 'Could not reach the provider.'), false); }
    finally { $('testProvider').disabled = false; }
  }
  async function forgetProfileRow(p) {
    if (!state.connected || !state.client) { settingsStatus('Connect to the agent bridge first.', false); return; }
    try {
      const data = await state.client.forgetSettings(p.id);
      savedProfiles = data.profiles || [];
      if (store.get('jarvis.provider') === p.id) store.set('jarvis.provider', savedProfiles[0]?.id || '');
      renderProfileList(); renderProviderSettings();
      settingsStatus('Removed ' + (p.label || p.id) + ' and its saved key from the host.', true);
      await refreshData();
    } catch (error) { diagnostics(error); settingsStatus(String(error?.message || 'Could not remove that profile.'), false); }
  }
  // Retries with backoff so the app connects on its own once the host bridge is
  // reachable (for example after `adb reverse tcp:8787 tcp:8787`).
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    $('reconnectHint').textContent = 'Retrying automatically in ' + Math.round(reconnectDelay / 1000) + 's…';
    reconnectTimer = setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 2, 60000); connect(); }, reconnectDelay);
  }
  function resetSteps() { state.steps.forEach(s => { s.status = 'pending'; s.at = null; }); renderSteps(); }
  function activateStep(id) {
    const target = state.steps.findIndex(s => s.id === id); if (target < 0) return;
    state.steps.forEach((s, i) => { if (i < target && s.status !== 'done') s.status = 'done'; if (i === target) { s.status = 'active'; s.at ||= Date.now(); } }); renderSteps();
  }
  function completeSteps(failed = false) { state.steps.forEach(s => s.status = 'done'); if (failed) state.steps.at(-1).status = 'failed'; renderSteps(); }
  function renderSteps() {
    const box = $('stepTimeline'); box.replaceChildren();
    for (const step of state.steps) {
      const row = node('div', 'step-row ' + step.status); const icon = node('span', 'step-icon', step.status === 'done' ? '✓' : step.status === 'active' ? '•' : step.status === 'failed' ? '×' : '');
      const elapsed = step.at ? Math.max(1, Math.round((Date.now() - step.at) / 1000)) + 's' : step.status === 'pending' ? 'Pending' : '';
      row.append(icon, node('strong', '', step.label), node('time', '', elapsed)); box.append(row);
    }
  }
  function appendOutput(text, kind = '') {
    const out = $('liveOutput'); out.querySelector('.muted-output')?.remove(); const span = node('span', 'output-line ' + kind, text); out.append(span); state.output += text; out.scrollTop = out.scrollHeight;
  }
  function openTask(task) {
    state.task = task; $('tasksListView').hidden = true; $('taskDetailView').hidden = false; $('detailTaskName').textContent = task.task || 'Task';
    if (state.busy) { $('agentStatusTitle').textContent = 'Jarvis is working…'; $('agentStatusText').textContent = 'Following live activity from the connected agent.'; }
    else { $('agentStatusTitle').textContent = normalizedStatus(task.status) === 'failed' ? 'Task failed' : 'Task completed'; $('agentStatusText').textContent = 'Open a new task to continue working.'; }
    goTaskDetail();
  }
  function goTaskDetail() { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-tasks')); document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.go === 'tasks')); $('tasksListView').hidden = true; $('taskDetailView').hidden = false; window.scrollTo(0, 0); }
  function setAgentBusy(value, title, text) {
    state.busy = value; $('progressRing').className = 'progress-ring ' + (value ? 'running' : 'done'); $('stopButton').disabled = !value; $('sendButton').disabled = value || state.submitting; setConnection(state.connected, value);
    if (title) $('agentStatusTitle').textContent = title; if (text) $('agentStatusText').textContent = text; renderTasks();
  }
  function showConfirm(payload) {
    state.pendingId = payload.id; $('confirmationTitle').textContent = payload.label || 'Review action'; $('confirmationPreview').textContent = payload.preview || ''; $('confirmationError').textContent = '';
    if (!$('confirmationDialog').open) $('confirmationDialog').showModal();
  }
  async function resolveConfirm(approved) {
    const id = state.pendingId; if (!id) return;
    try { await state.client.confirm(id, approved); if (state.pendingId === id) { state.pendingId = null; $('confirmationDialog').close(); } }
    catch (error) { $('confirmationError').textContent = friendly(error); diagnostics(error); }
  }
  function bindEvents(client) {
    const on = (name, fn) => client.on(name, p => { if (state.client === client) fn(p); });
    on('connection.error', error => { diagnostics(error); setConnection(false); scheduleReconnect(); });
    on('agent.snapshot', p => {
      if (p.activeRun) { state.task = { ...p.activeRun, status: 'running' }; setAgentBusy(true, 'Jarvis is working…', 'Reconnected to the active task.'); }
      else if (p.completion) setAgentBusy(false, normalizedStatus(p.completion.status) === 'failed' ? 'Task failed' : 'Task completed', 'Review the real output and project files.');
      if (p.pending?.length) showConfirm(p.pending[0]); refreshData();
    });
    on('agent.started', p => {
      state.startedAt = Date.now(); state.task = { id: p.sessionId, task: p.task, repo: p.repo, status: 'running', updatedAt: new Date().toISOString() }; state.repo = p.repo; store.set('jarvis.repo', p.repo); renderRepos();
      $('detailTaskName').textContent = p.task; $('liveOutput').replaceChildren(); state.output = ''; resetSteps(); activateStep('understand'); appendOutput('> Jarvis started task\n', 'tool');
      setAgentBusy(true, 'Jarvis is working…', 'Understanding your request.'); goTaskDetail();
    });
    on('agent.thinking', p => { activateStep(p.phase === 'planning' ? 'plan' : 'understand'); $('agentStatusText').textContent = p.phase === 'planning' ? 'Creating an execution plan.' : 'Reasoning with ' + (p.model || 'the selected model') + '.'; });
    on('agent.stream.delta', p => appendOutput(p.delta || ''));
    on('agent.plan.ready', p => { activateStep('plan'); appendOutput('\n> Plan ready for review\n' + p.plan + '\n', 'tool'); });
    on('agent.tool.start', p => {
      const group = ['read_file','list_files','search_code','git_status','git_diff'].includes(p.name) ? 'inspect' : ['write_file','edit_file'].includes(p.name) ? 'code' : p.name === 'run_command' ? 'checks' : 'code'; activateStep(group);
      const line = '> ' + p.name + ' ' + (typeof p.args === 'string' ? p.args : JSON.stringify(p.args)) + '\n'; appendOutput(line, 'tool'); state.tools.set(p.id, p);
      $('agentStatusText').textContent = ({ inspect: 'Reading and analyzing project files.', code: 'Creating and updating project files.', checks: 'Running project commands and checks.' })[group];
    });
    on('agent.command.output.delta', p => appendOutput(p.delta || '', p.stream === 'stderr' ? 'stderr' : ''));
    on('agent.command.output', p => appendOutput('\n> Command finished · ' + (p.timedOut ? 'timed out' : 'exit ' + p.exitCode) + ' · ' + p.durationMs + 'ms\n', p.exitCode === 0 ? 'tool' : 'stderr'));
    on('agent.tool.complete', p => { if (p.status !== 'ok') appendOutput('> ' + p.name + ' ' + p.status + ': ' + p.result + '\n', 'stderr'); });
    on('agent.confirmation.required', showConfirm);
    on('agent.test.complete', p => { activateStep('checks'); appendOutput('> Checks ' + (p.passed ? 'passed' : 'failed') + ': ' + p.cmd + '\n', p.passed ? 'tool' : 'stderr'); });
    on('agent.file.changed', () => { if (location.hash === '#files') loadFiles(); });
    on('agent.completed', p => {
      activateStep('finish'); completeSteps(normalizedStatus(p.status) === 'failed'); if (!p.finalAnswer || !state.output.includes(p.finalAnswer)) appendOutput('\n> ' + (p.finalAnswer || 'Task finished') + '\n', normalizedStatus(p.status) === 'failed' ? 'stderr' : 'tool');
      setAgentBusy(false, normalizedStatus(p.status) === 'failed' ? 'Task failed' : p.status === 'cancelled' ? 'Task stopped' : 'Task completed', 'Finished in ' + Math.max(1, Math.round((Date.now() - state.startedAt) / 1000)) + ' seconds.'); state.pendingId = null; $('confirmationDialog').close(); refreshData();
    });
    on('agent.error', p => { completeSteps(true); appendOutput('\n> ' + friendly(p.message) + '\n', 'stderr'); diagnostics(p.message); setAgentBusy(false, 'Task failed', 'Open diagnostics for technical details.'); });
  }
  async function connect() {
    state.client?.close(); setConnection(false); $('diagnosticsText').textContent = 'Connecting…';
    try {
      const client = createAgentClient($('bridgeUrl').value.trim(), { token: $('bridgeToken').value }); state.client = client; store.set('jarvis.bridge', client.baseUrl); bindEvents(client); await client.connect(); setConnection(true); clearTimeout(reconnectTimer); reconnectDelay = 4000; $('reconnectHint').textContent = ''; await refreshData();
    } catch (error) { diagnostics(error); setConnection(false); scheduleReconnect(); }
  }
  async function loadFiles(dir = state.dir) {
    const box = $('fileList'); $('filePreview').hidden = true;
    if (!state.connected || !state.repo) { box.replaceChildren(node('div', 'empty-state', state.connected ? 'Choose a repository in Settings.' : 'Connect Jarvis in Settings to browse files.')); renderBreadcrumb(); return; }
    box.replaceChildren(node('div', 'empty-state', 'Loading real project files…'));
    try { const data = await state.client.files(state.repo, dir); state.dir = data.dir || ''; state.fileEntries = data.entries || []; renderBreadcrumb(); renderFiles(); }
    catch (error) { diagnostics(error); box.replaceChildren(node('div', 'empty-state', friendly(error))); }
  }
  function renderBreadcrumb() {
    const nav = $('fileBreadcrumb'); nav.replaceChildren(); const name = state.repo.split('/').filter(Boolean).pop() || 'Repository'; const parts = state.dir.split('/').filter(Boolean);
    const root = node('button', '', name); root.onclick = () => loadFiles(''); nav.append(root);
    parts.forEach((part, i) => { nav.append(document.createTextNode('›')); const b = node('button', '', part); b.onclick = () => loadFiles(parts.slice(0, i + 1).join('/')); nav.append(b); });
  }
  function fileIcon(entry) {
    if (entry.type === 'folder') return '▰'; const ext = entry.name.split('.').pop().toLowerCase();
    return ['js','ts','jsx','tsx','java','kt','py'].includes(ext) ? '▤' : ['json','yml','yaml','xml','gradle'].includes(ext) ? '▧' : '▱';
  }
  function renderFiles() {
    const term = $('fileSearchInput').value.trim().toLowerCase(); const entries = (state.fileEntries || []).filter(e => !term || e.name.toLowerCase().includes(term)); const box = $('fileList'); box.replaceChildren();
    for (const entry of entries) {
      const row = node('button', 'file-row'); row.append(node('span', 'file-icon', fileIcon(entry)), node('span', 'file-name', entry.name), node('span', 'more-button', '⋮'));
      row.onclick = () => entry.type === 'folder' ? loadFiles(entry.path) : previewFile(entry); box.append(row);
    }
    if (!entries.length) box.append(node('div', 'empty-state', term ? 'No matching files in this folder.' : 'This folder is empty.'));
  }
  async function previewFile(entry) {
    try { const data = await state.client.browseFile(state.repo, entry.path); $('previewTitle').textContent = data.path; $('previewContent').textContent = data.content; $('filePreview').hidden = false; $('filePreview').scrollIntoView({ behavior: 'smooth' }); }
    catch (error) { diagnostics(error); toast(error); }
  }
  function openChoice(title, options, selected, apply) {
    $('choiceTitle').textContent = title; const list = $('choiceList'); list.replaceChildren();
    options.forEach(o => { const b = node('button', 'choice-option', (o.value === selected ? '✓ ' : '') + o.label); b.onclick = () => { apply(o.value); $('choiceDialog').close(); }; list.append(b); }); $('choiceDialog').showModal();
  }
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  document.querySelectorAll('[data-prompt]').forEach(b => b.onclick = () => { $('taskInput').value = b.dataset.prompt; $('taskInput').focus(); $('sendButton').classList.toggle('ready', Boolean(b.dataset.prompt)); });
  document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { state.filter = b.dataset.filter; document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('active', x === b)); renderTasks(); });
  $('taskInput').oninput = () => $('sendButton').classList.toggle('ready', Boolean($('taskInput').value.trim()));
  $('repoSelect').onchange = () => { state.repo = $('repoSelect').value; store.set('jarvis.repo', state.repo); $('repoPathInput').value = state.repo; state.dir = ''; };
  $('taskForm').onsubmit = async e => {
    e.preventDefault(); if (state.busy || state.submitting) return;
    if (!state.connected) { toast('Agent bridge is disconnected'); return go('settings'); }
    const task = $('taskInput').value.trim(); if (!task) return; if (!state.repo) { toast('Choose a repository in Settings first'); return go('settings'); }
    state.submitting = true; $('sendButton').disabled = true;
    const mode = $('autoApprove').checked ? 'auto' : $('modeSelect').value;
    try { await state.client.run({ repo: state.repo, task, mode: mode === 'auto' ? 'auto' : 'confirm', plan: mode === 'plan', providerId: store.get('jarvis.provider') || null, model: store.get('jarvis.model') || null, allowTerminal: $('terminalAccess').checked }); }
    catch (error) { diagnostics(error); toast(error); }
    finally { state.submitting = false; $('sendButton').disabled = state.busy; }
  };
  $('backToTasks').onclick = () => go('tasks'); $('stopButton').onclick = async () => { try { await state.client.cancel(); $('agentStatusText').textContent = 'Stopping safely…'; } catch (e) { diagnostics(e); toast(e); } };
  $('expandOutput').onclick = () => { state.outputExpanded = !state.outputExpanded; $('liveOutput').classList.toggle('expanded', state.outputExpanded); $('expandOutput').textContent = state.outputExpanded ? 'Collapse terminal ↙' : 'Open in terminal ↗'; };
  $('approveAction').onclick = () => resolveConfirm(true); $('rejectAction').onclick = () => resolveConfirm(false); $('confirmationDialog').oncancel = e => { e.preventDefault(); resolveConfirm(false); };
  $('fileRootButton').onclick = () => loadFiles(''); $('fileSearchButton').onclick = () => { $('fileSearch').hidden = false; $('fileSearchInput').focus(); }; $('closeFileSearch').onclick = () => { $('fileSearch').hidden = true; $('fileSearchInput').value = ''; renderFiles(); }; $('fileSearchInput').oninput = renderFiles; $('closePreview').onclick = () => $('filePreview').hidden = true;
  $('providerRow').onclick = () => { const options = (savedProfiles.length ? savedProfiles.map(p => ({ value: p.id, label: p.label + ' · ' + p.model })) : state.profiles.map(p => ({ value: p.id, label: p.name + ' · ' + p.model }))); if (!options.length) { settingsStatus('Save an API key first.', false); return; } openChoice('Active profile', options, store.get('jarvis.provider'), v => { store.set('jarvis.provider', v); store.set('jarvis.model', ''); renderProfileList(); renderProviderSettings(); }); };
  $('modelRow').onclick = () => { const models = [...new Set([...savedProfiles.map(p => p.model), ...state.profiles.map(p => p.model)].filter(Boolean))]; openChoice('Model', [{ value: '', label: 'Auto (profile default)' }, ...models.map(v => ({ value: v, label: v }))], store.get('jarvis.model'), v => { store.set('jarvis.model', v); renderProviderSettings(); }); };
  $('providerForm').onsubmit = e => { e.preventDefault(); saveProviderSettings(); };
  $('testProvider').onclick = () => testProviderKey();
  $('presetProvider').onclick = () => openChoice('Provider presets', PRESETS.map((p, i) => ({ value: String(i), label: p.label })), '', v => {
    const preset = PRESETS[Number(v)]; if (!preset) return;
    if (!$('profileLabel').value.trim()) $('profileLabel').value = preset.label;
    $('providerBaseUrl').value = preset.baseUrl; $('providerModel').value = preset.model;
    settingsStatus('Preset filled. Paste your ' + preset.label + ' key, then tap Save key.');
  });
  $('repoPathInput').onchange = () => { state.repo = $('repoPathInput').value.trim(); store.set('jarvis.repo', state.repo); if (state.repo && !state.repos.some(r => r.path === state.repo)) state.repos.unshift({ path: state.repo, name: state.repo.split('/').filter(Boolean).pop() || state.repo }); renderRepos(); };
  $('autoApprove').checked = store.get('jarvis.auto') === '1'; $('autoApprove').onchange = () => store.set('jarvis.auto', $('autoApprove').checked ? '1' : '0');
  $('terminalAccess').checked = store.get('jarvis.terminal', '1') === '1'; $('terminalAccess').onchange = () => store.set('jarvis.terminal', $('terminalAccess').checked ? '1' : '0');
  $('attachButton').onclick = () => toast('File attachments need a backend upload API and are out of scope for this pass.');
  $('retryConnection').onclick = connect; $('bannerConnect').onclick = connect; $('disconnectButton').onclick = () => { state.client?.close(); state.client = null; setConnection(false); $('diagnosticsText').textContent = 'Disconnected by user.'; };
  $('closeChoice').onclick = () => $('choiceDialog').close();
  $('bridgeUrl').value = store.get('jarvis.bridge', location.protocol.startsWith('http') && location.pathname.startsWith('/app/') ? location.origin : 'http://127.0.0.1:8787');
  renderRepos(); renderTasks(); resetSteps(); setConnection(false); go(location.hash.slice(1) || 'home'); connect();
  window.addEventListener('pagehide', () => state.client?.close());
})();
