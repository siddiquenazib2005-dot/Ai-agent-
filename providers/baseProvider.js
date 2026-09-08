/**
 * baseProvider.js — provider abstraction for my-agent (Part 6).
 *
 * The core agent NEVER talks to a specific vendor API directly: it calls
 * `provider.chat(...)` on a client created by providers/index.js. New vendor
 * support = one new module registered in providers/index.js. No SDKs —
 * providers use plain fetch against documented HTTP APIs.
 *
 * Error kinds (used by the key failover logic in llmConfig.js):
 *   auth         — key invalid/forbidden (401/403)  → failover allowed
 *   network      — could not connect                 → failover allowed
 *   server       — 5xx from provider                 → failover allowed
 *   timeout      — request exceeded LLM_TIMEOUT      → failover allowed
 *   rate_limited — 429. NO automatic key rotation: rotating keys to dodge
 *                  rate limits would circumvent provider policy. The error is
 *                  surfaced to the user instead.
 *   bad_request  — our request was malformed (4xx)   → not key-related, no failover
 */

/** Redacts an API key for logs/UI: `sk-1234...abcd`. Never prints full keys. */
export function redactKey(key) {
  if (typeof key !== 'string' || !key) return '(none)';
  if (key.length <= 11) return `${key.slice(0, 2)}...${key.slice(-2)}`;
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

/** Attaches .kind to an error so failover logic can decide what to do. */
export function kindError(kind, message, { status = null } = {}) {
  const err = new Error(message);
  err.kind = kind;
  if (status !== null) err.status = status;
  return err;
}

export class BaseProvider {
  constructor({ name = 'base', baseUrl = '', model = '', timeoutMs = 120_000 } = {}) {
    this.name = name;
    this.baseUrl = baseUrl;
    this.defaultModel = model;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One chat-completions call.
   * @param {Array} messages  OpenAI-style message list
   * @param {object} opts     { apiKey, model?, tools?, temperature?, onDelta?, signal? }
   * @returns {Promise<{message: object, usage: object|null, model: string, provider: string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async chat(messages, opts = {}) {
    throw new Error('BaseProvider.chat() is abstract — implement it in a subclass.');
  }
}
