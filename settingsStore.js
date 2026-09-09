/**
 * settingsStore.js — host-side provider credential storage for the mobile app.
 *
 * SECURITY MODEL (deliberate, and the reason keys are never accepted in chat):
 *   - API keys are written ONLY to my-agent/providers.json on the bridge host.
 *   - providers.json is gitignored, written atomically with mode 0600, so keys
 *     never reach the repository, the APK, CI logs, or commits.
 *   - Keys are NEVER returned by any read API. Callers only ever see
 *     `configured: true|false` plus a constant mask.
 *   - Every saved key is registered with commandPolicy so it is redacted from
 *     logs, streamed events and error messages.
 *
 * The file format is the same one llmConfig.loadProviderEntries() already
 * understands, so saving from the phone reuses the existing provider
 * abstraction instead of adding a second configuration path.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redactSecrets, registerSecrets } from './commandPolicy.js';
import { loadLlmConfig } from './llmConfig.js';

const FILE = fileURLToPath(new URL('./providers.json', import.meta.url));

/** Provider names the registry can actually construct (providers/index.js). */
export const PROVIDER_NAMES = ['openai-compatible'];

/** Hosts where plain HTTP is acceptable (loopback only). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Constant mask — intentionally carries no key material, not even length. */
export const KEY_MASK = '[configured…]';

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p === 'object') : [];
  } catch {
    return [];
  }
}

/** Atomic 0600 write so a crash cannot leave a half-written secrets file. */
function persist(list) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch { /* non-POSIX filesystem */ }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Throws a user-safe error (never echoes secret material). */
function fail(message) {
  throw new Error(message);
}

function validateBaseUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { fail('Enter a full base URL, for example https://api.openai.com/v1'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('Base URL must use http or https');
  if (url.username || url.password) fail('Do not put credentials in the base URL; use the API key field');
  if (url.search || url.hash) fail('Base URL must not contain a query string or fragment');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(host)) fail('Remote providers must use HTTPS so the key is not sent in clear text');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function validateApiKey(value) {
  const key = String(value).trim();
  if (key.length < 8) fail('That API key looks too short to be valid');
  if (key.length > 1000) fail('That API key is unexpectedly long; check for pasted extra text');
  if (/[\s\u0000-\u001f\u007f]/.test(key)) fail('API keys cannot contain spaces, tabs or line breaks');
  return key;
}

function publicShape(entry, index) {
  return {
    id: entry.id || `profile-${index + 1}`,
    label: entry.label || entry.id || `Profile ${index + 1}`,
    name: entry.name || 'openai-compatible',
    baseUrl: entry.baseUrl,
    model: entry.model || '',
    enabled: entry.enabled !== false,
    configured: Boolean(entry.apiKey || entry.apiKeyEnv || (Array.isArray(entry.keys) && entry.keys.length)),
    apiKey: undefined,
    keys: undefined,
    masked: entry.apiKey || entry.apiKeyEnv ? KEY_MASK : null,
  };
}

/** Registers stored keys for redaction; safe to call repeatedly. */
export function registerStoredSecrets() {
  for (const entry of readAll()) registerSecrets([entry.apiKey, ...(Array.isArray(entry.keys) ? entry.keys : [])]);
}

/** Saved profiles, WITHOUT key material. */
export function listProfiles() {
  return readAll().map((entry, i) => {
    const shape = publicShape(entry, i);
    delete shape.apiKey;
    delete shape.keys;
    return shape;
  });
}

/**
 * Creates or updates one provider profile.
 * Omitting `apiKey` on an existing profile keeps the stored key untouched, so
 * the app can edit the model or base URL without re-entering the secret.
 */
export function saveProfile(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid settings payload');
  const name = String(input.name || 'openai-compatible');
  if (!PROVIDER_NAMES.includes(name)) fail(`Unsupported provider type. Available: ${PROVIDER_NAMES.join(', ')}`);

  const label = String(input.label || '').trim().slice(0, 60);
  if (!label) fail('Give this profile a name, for example "OpenAI" or "Groq"');

  const baseUrl = validateBaseUrl(input.baseUrl);
  const model = String(input.model || '').trim();
  if (!model) fail('Enter the model name, for example gpt-4o-mini');
  if (model.length > 120 || !/^[\w./:@+-]+$/.test(model)) fail('That model name contains unsupported characters');

  const list = readAll();
  const id = slug(input.id || label) || `profile-${list.length + 1}`;
  const index = list.findIndex((p) => (p.id || '') === id);
  const existing = index >= 0 ? list[index] : null;

  let apiKey = existing?.apiKey ?? null;
  if (input.apiKey !== undefined && input.apiKey !== null && String(input.apiKey) !== '') {
    apiKey = validateApiKey(input.apiKey);
  }
  if (!apiKey && !existing) fail('Enter the API key for this new profile');

  const entry = {
    id,
    label,
    name,
    baseUrl,
    model,
    apiKey,
    enabled: input.enabled === undefined ? existing?.enabled !== false : input.enabled !== false,
    priority: Number.isFinite(existing?.priority) ? existing.priority : list.length,
  };

  // `makeDefault` moves this profile to the front; llmConfig picks the
  // lowest-priority enabled profile as primary.
  if (index >= 0) list[index] = entry; else list.push(entry);
  if (input.makeDefault) {
    const others = list.filter((p) => p.id !== id);
    entry.priority = 0;
    others.forEach((p, i) => { p.priority = i + 1; });
  }

  persist(list);
  registerSecrets([apiKey]);
  return { profile: publicShape(entry, index >= 0 ? index : list.length - 1), profiles: listProfiles() };
}

/** Deletes one profile and its stored key. */
export function forgetProfile(id) {
  const wanted = slug(id);
  const list = readAll();
  const next = list.filter((p) => slug(p.id || '') !== wanted);
  if (next.length === list.length) fail('That profile no longer exists');
  if (next.length) persist(next);
  else { try { fs.rmSync(FILE); } catch { /* already gone */ } }
  return { removed: wanted, profiles: listProfiles() };
}

/**
 * Makes ONE real request to the provider so "Test key" cannot report a false
 * success. Returns a user-safe, redacted message either way.
 */
export async function testProfile(id = null, env = process.env) {
  let config;
  try { config = loadLlmConfig(env, id || null); } catch { return { ok: false, message: 'That provider profile is unavailable. Save it again.' }; }
  if (!config.hasKey) return { ok: false, message: 'No API key is saved for this profile yet.' };
  const entry = config.keyManager.available()[0];
  if (!entry) return { ok: false, message: 'The saved key is cooling down after repeated failures. Try again shortly.' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const result = await config.provider.chat(
      [{ role: 'user', content: 'Reply with the single word OK.' }],
      { apiKey: entry.key, model: config.model, temperature: 0, signal: ac.signal },
    );
    config.keyManager.reportSuccess(entry.key);
    const replied = typeof result?.message?.content === 'string' && result.message.content.trim().length > 0;
    return {
      ok: true,
      message: `${config.providerName} responded using ${result?.model || config.model}.${replied ? '' : ' The reply was empty but authentication succeeded.'}`,
    };
  } catch (error) {
    config.keyManager.reportFailure(entry.key, error?.message);
    const kind = error?.kind ?? null;
    const friendly = kind === 'auth'
      ? 'The provider rejected this API key. Check the key and the base URL.'
      : kind === 'rate_limit'
        ? 'The provider is rate limiting this key right now. The key itself looks valid.'
        : kind === 'timeout'
          ? 'The provider did not respond in time. Check the base URL and your network.'
          : redactSecrets(String(error?.message || 'The provider request failed.'));
    return { ok: false, kind, message: friendly };
  } finally {
    clearTimeout(timer);
  }
}
