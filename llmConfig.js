/**
 * llmConfig.js — Part 2/6/7/8: unified LLM configuration, provider selection,
 * multi-key health management, and task-complexity routing for my-agent.
 *
 * CONFIGURATION (precedence: providers.json file > env vars > legacy GLM_* > defaults)
 *   LLM_PROVIDER   provider name (default: openai-compatible)
 *   LLM_BASE_URL   OpenAI-compatible base URL
 *   LLM_API_KEY    primary API key
 *   LLM_MODEL      primary/default model
 *   LLM_TIMEOUT    request timeout in ms (default 120000)
 *   LLM_KEYS       comma-separated ADDITIONAL authorized keys for the same
 *                  provider — for reliability/failover of keys you are
 *                  authorized to use. NOT a rate-limit evasion mechanism:
 *                  429 responses are never rotated around.
 *   FAST_MODEL / SMART_MODEL / COMPLEX_MODEL / PLANNING_MODEL  routing tiers
 *   Legacy GLM_API_KEY / GLM_BASE_URL / GLM_MODEL / FAST_MODEL still work.
 *   Optional structured file: my-agent/providers.json
 *     [{ "name", "baseUrl", "apiKey", "model", "timeout", "priority", "enabled", "keys": [] }]
 *
 * ROUTING (honest heuristic, documented in classifyTask — not "intelligent"):
 *   SIMPLE → fastModel, MEDIUM → smartModel, COMPLEX → complexModel,
 *   PLANNING → planningModel. Decisions are logged with the reason.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './config.js';
import { createProvider } from './providers/index.js';
import { redactKey } from './providers/baseProvider.js';

const MY_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_FILE = path.join(MY_DIR, 'providers.json');

export const TASK_CATEGORIES = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'PLANNING'];

// Documented heuristic keywords (kept intentionally simple and explainable).
const HINTS = {
  PLANNING: ['plan', 'design', 'architecture', 'roadmap', 'break down', 'split into', 'strategy', 'propose a structure'],
  COMPLEX: ['refactor', 'architect', 'migrat', 'rewrite', 'restructur', 'system-wide', 'repo-wide', 'whole project', 'multiple files', 'several files', 'large debugging', 'across the repo'],
  MEDIUM: ['implement', 'add feature', 'feature', 'test', 'tests', 'function', 'component', 'api', 'endpoint', 'bug', 'fix the', 'several', 'multiple'],
};

/**
 * Classifies a task as SIMPLE / MEDIUM / COMPLEX / PLANNING.
 * Heuristic only: keyword matches (checked PLANNING → COMPLEX → MEDIUM),
 * then task length (PLANNING/COMPLEX >240 chars, MEDIUM >80). First match wins.
 */
export function classifyTask(task) {
  const t = String(task).toLowerCase();
  for (const cat of ['PLANNING', 'COMPLEX', 'MEDIUM']) {
    const hit = HINTS[cat].find((h) => t.includes(h));
    if (hit) return { category: cat, reason: `matches "${hit}"` };
  }
  if (t.length > 240) return { category: 'COMPLEX', reason: 'task description is long (>240 chars)' };
  if (t.length > 80) return { category: 'MEDIUM', reason: 'task description is moderately detailed (>80 chars)' };
  return { category: 'SIMPLE', reason: 'short, single-file-looking task' };
}

// ---------------------------------------------------------------------------
// Multi-key management (Part 7): authorized keys, health tracking, failover.
// ---------------------------------------------------------------------------

const KEY_FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // temporary disable after repeated failures
const KEY_MAX_CONSECUTIVE_FAILURES = 3;

export class KeyManager {
  /** @param {string[]} keys authorized API keys for one provider */
  constructor(keys = []) {
    this.entries = keys.filter((k) => typeof k === 'string' && k.trim()).map((key) => ({
      key: key.trim(),
      failures: 0,
      disabledUntil: 0,
      lastError: null,
    }));
  }

  /** Keys currently usable (enabled and not in cooldown). */
  available() {
    return this.entries.filter((e) => e.disabledUntil <= Date.now());
  }

  reportSuccess(key) {
    const e = this.entries.find((x) => x.key === key);
    if (e) { e.failures = 0; e.lastError = null; e.disabledUntil = 0; }
  }

  /** Consecutive failures ≥3 → temporary cooldown. Rate limits are NOT failures here. */
  reportFailure(key, message) {
    const e = this.entries.find((x) => x.key === key);
    if (!e) return;
    e.failures += 1;
    e.lastError = String(message ?? 'unknown error');
    if (e.failures >= KEY_MAX_CONSECUTIVE_FAILURES) {
      e.disabledUntil = Date.now() + KEY_FAILURE_COOLDOWN_MS;
    }
  }

  /** Redacted health snapshot — safe for logs and UIs (never full keys). */
  snapshot() {
    return this.entries.map((e) => ({
      key: redactKey(e.key),
      failures: e.failures,
      coolingDown: e.disabledUntil > Date.now(),
      lastError: e.lastError,
    }));
  }
}

// ---------------------------------------------------------------------------
// Configuration loading
// ---------------------------------------------------------------------------

/** Reads providers.json (structured multi-provider config) if present. */
function loadProviderFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((p) => p && typeof p === 'object' && p.baseUrl);
  } catch {
    return []; // missing/corrupt file → env config only (corrupt file warns at load)
  }
}

/** Builds normalized provider entries from env vars and providers.json. */
export function loadProviderEntries(env = {}) {
  const fileEntries = loadProviderFile();
  const envEntry = {
    name: env.LLM_PROVIDER || 'openai-compatible',
    baseUrl: env.LLM_BASE_URL || env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    model: env.LLM_MODEL || env.GLM_MODEL || 'glm-5.3',
    apiKey: env.LLM_API_KEY || env.GLM_API_KEY || null,
    keys: String(env.LLM_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean),
    timeoutMs: Number(env.LLM_TIMEOUT) > 0 ? Number(env.LLM_TIMEOUT) : 120_000,
    priority: 0,
    enabled: true,
  };
  return [...fileEntries.map((p, i) => ({
    name: p.name || 'openai-compatible',
    baseUrl: p.baseUrl,
    model: p.model || 'glm-5.3',
    apiKey: p.apiKey || null,
    keys: Array.isArray(p.keys) ? p.keys : [],
    timeoutMs: Number(p.timeout) > 0 ? Number(p.timeout) : 120_000,
    priority: Number.isFinite(p.priority) ? p.priority : i,
    enabled: p.enabled !== false,
  })), envEntry];
}

/**
 * Loads the effective LLM configuration. Returns a superset of the legacy
 * loadConfig() shape (apiKey/model/baseURL/fastModel/fastBaseURL) plus the
 * provider client, key manager, timeout and routing tiers.
 */
export function loadLlmConfig(env = {}) {
  const fileVars = parseEnvFile(path.join(MY_DIR, '.env'));
  const e = {};
  for (const k of new Set([...Object.keys(fileVars), ...Object.keys(env)])) {
    e[k] = fileVars[k] ?? env[k];
  }

  const entries = loadProviderEntries(e).sort((a, b) => a.priority - b.priority);
  const primary = entries.find((p) => p.enabled) ?? entries[entries.length - 1];
  const corruptFile = (() => {
    if (!fs.existsSync(PROVIDERS_FILE)) return false;
    try { JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')); return false; } catch { return true; }
  })();

  const allKeys = [primary.apiKey, ...primary.keys].filter(Boolean);
  const keyManager = new KeyManager(allKeys);
  const provider = createProvider(primary.name, {
    baseUrl: primary.baseUrl,
    model: primary.model,
    timeoutMs: primary.timeoutMs,
  });

  const config = {
    // legacy-compatible fields (existing CLI/tests keep working)
    apiKey: allKeys[0] ?? null,
    model: primary.model,
    baseURL: primary.baseUrl,
    fastModel: e.FAST_MODEL || primary.model,
    fastBaseURL: primary.baseUrl,
    // new fields
    providerName: primary.name,
    provider,
    keyManager,
    timeoutMs: primary.timeoutMs,
    smartModel: e.SMART_MODEL || primary.model,
    complexModel: e.COMPLEX_MODEL || primary.model,
    planningModel: e.PLANNING_MODEL || primary.model,
    hasKey: allKeys.length > 0,
    warning: corruptFile ? 'providers.json is corrupt/invalid JSON — using env configuration' : null,
  };
  return config;
}

// ---------------------------------------------------------------------------
// Routing (Part 8)
// ---------------------------------------------------------------------------

/**
 * Full routing decision. `overrideModel` (--model) always wins.
 * Returns { category, model, baseURL, providerName, reason }.
 */
export function routeTask(task, config, overrideModel = null) {
  const { category, reason } = classifyTask(task);
  if (overrideModel) {
    return { category, model: overrideModel, baseURL: config.baseURL, providerName: config.providerName, reason: '--model override wins' };
  }
  const tier = {
    SIMPLE: { model: config.fastModel, baseURL: config.fastBaseURL || config.baseURL, why: 'SIMPLE → fast model' },
    MEDIUM: { model: config.smartModel ?? config.model, baseURL: config.baseURL, why: 'MEDIUM → smart model' },
    COMPLEX: { model: config.complexModel ?? config.model, baseURL: config.baseURL, why: 'COMPLEX → complex model' },
    PLANNING: { model: config.planningModel ?? config.model, baseURL: config.baseURL, why: 'PLANNING → planning model' },
  }[category];
  return { category, model: tier.model, baseURL: tier.baseURL, providerName: config.providerName, reason: `${tier.why} (${reason})` };
}

/**
 * Legacy-compatible routing entry point (used by tests and older callers):
 * returns only { model, baseURL, reason }.
 */
export function chooseModel(task, config, overrideModel = null) {
  const r = routeTask(task, config, overrideModel);
  return { model: r.model, baseURL: r.baseURL, reason: r.reason };
}
