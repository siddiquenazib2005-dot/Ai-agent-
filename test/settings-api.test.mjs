// Settings API tests — provider credential storage + bridge routes.
// Asserts that keys are persisted host-side with 0600 permissions, are NEVER
// returned by any read API, survive edits, and that validation rejects unsafe
// input. Uses a temporary HOME-like module file path via direct store calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../bridge/server.js';
import { saveProfile, forgetProfile, listProfiles, PROVIDER_NAMES } from '../settingsStore.js';

let passed = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}`); }
};

const FILE = fileURLToPath(new URL('../providers.json', import.meta.url));
const BACKUP = FILE + '.test-backup';
const hadFile = fs.existsSync(FILE);
if (hadFile) fs.copyFileSync(FILE, BACKUP);
fs.rmSync(FILE, { force: true });

const SECRET = 'sk-settings-test-0123456789abcdef';
const post = (base, route, body) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, data: await r.json() }));

try {
  // --- store-level behaviour ------------------------------------------------
  const saved = saveProfile({ label: 'Test OpenAI', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-4o-mini', apiKey: SECRET });
  check('saveProfile stores a normalized profile', saved.profile.id === 'test-openai' && saved.profile.baseUrl === 'https://api.openai.com/v1');
  check('saveProfile reports configured without exposing the key', saved.profile.configured === true && saved.profile.apiKey === undefined);
  check('listProfiles never returns key material', JSON.stringify(listProfiles()).includes(SECRET) === false);
  check('providers.json actually holds the key for the agent', fs.readFileSync(FILE, 'utf8').includes(SECRET));
  if (process.platform !== 'win32') {
    check('providers.json is written with 0600 permissions', (fs.statSync(FILE).mode & 0o777) === 0o600);
  } else { passed++; console.log('PASS  permission check skipped on win32'); }

  const edited = saveProfile({ label: 'Test OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
  check('editing without a key keeps the stored key', edited.profile.model === 'gpt-4o' && fs.readFileSync(FILE, 'utf8').includes(SECRET));

  const rejects = (input, why) => {
    try { saveProfile(input); return false; } catch { return true; }
  };
  check('rejects http for remote providers', rejects({ label: 'x', baseUrl: 'http://api.example.com/v1', model: 'm', apiKey: SECRET }));
  check('allows http for loopback providers', (() => {
    try { saveProfile({ label: 'Local LM', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder', apiKey: SECRET }); return true; } catch { return false; }
  })());
  check('rejects credentials embedded in the base URL', rejects({ label: 'x', baseUrl: 'https://user:pw@api.example.com/v1', model: 'm', apiKey: SECRET }));
  check('rejects unknown provider types', rejects({ label: 'x', name: 'not-a-provider', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: SECRET }));
  check('rejects keys containing whitespace', rejects({ label: 'y', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-bad key with spaces' }));
  check('rejects a new profile with no key', rejects({ label: 'No Key Profile', baseUrl: 'https://api.example.com/v1', model: 'm' }));
  check('rejects a missing profile name', rejects({ label: '', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: SECRET }));
  check('only registry-backed provider types are offered', PROVIDER_NAMES.includes('openai-compatible'));

  // --- bridge routes -------------------------------------------------------
  const bridge = await startBridge({ port: 0 });
  try {
    const list = await fetch(bridge.baseUrl + '/settings').then(r => r.json());
    check('GET /settings lists saved profiles', Array.isArray(list.profiles) && list.profiles.length >= 2);
    check('GET /settings never leaks a key over the wire', JSON.stringify(list).includes(SECRET) === false);

    const created = await post(bridge.baseUrl, '/settings', { label: 'Bridge Saved', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: SECRET });
    check('POST /settings saves from the app', created.status === 200 && created.data.profile.id === 'bridge-saved');
    check('POST /settings response contains no key', JSON.stringify(created.data).includes(SECRET) === false);

    const invalid = await post(bridge.baseUrl, '/settings', { label: 'Bad', baseUrl: 'ftp://nope', model: 'm', apiKey: SECRET });
    check('POST /settings rejects invalid input with a clear error', invalid.status === 400 && typeof invalid.data.error === 'string');

    const removed = await post(bridge.baseUrl, '/settings/forget', { id: 'bridge-saved' });
    check('POST /settings/forget deletes the profile', removed.status === 200 && !removed.data.profiles.some(p => p.id === 'bridge-saved'));

    const missing = await post(bridge.baseUrl, '/settings/forget', { id: 'does-not-exist' });
    check('POST /settings/forget reports unknown profiles', missing.status === 400);

    const tested = await post(bridge.baseUrl, '/settings/test', { id: 'local-lm' });
    check('POST /settings/test performs a real request and reports honestly', tested.status === 200 && tested.data.ok === false && typeof tested.data.message === 'string');
    check('POST /settings/test never echoes the key', JSON.stringify(tested.data).includes(SECRET) === false);
  } finally {
    await bridge.close();
  }

  check('forgetProfile removes stored credentials', (() => {
    forgetProfile('test-openai');
    return !listProfiles().some(p => p.id === 'test-openai');
  })());
} finally {
  fs.rmSync(FILE, { force: true });
  if (hadFile) { fs.copyFileSync(BACKUP, FILE); fs.rmSync(BACKUP, { force: true }); }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error('Failing checks:\n- ' + failures.join('\n- ')); process.exitCode = 1; }
