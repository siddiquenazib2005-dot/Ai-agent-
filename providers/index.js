/**
 * index.js — provider registry. Maps a provider NAME (from LLM_PROVIDER or
 * providers.json) to its client class. The core agent only ever sees the
 * BaseProvider interface, so vendors stay swappable.
 */
import { BaseProvider } from './baseProvider.js';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider.js';

const REGISTRY = {
  'openai-compatible': OpenAICompatibleProvider, // default: any /v1/chat/completions API
};

/** Creates a provider client by name. Throws a clear error for unknown names. */
export function createProvider(name, { baseUrl, model, timeoutMs } = {}) {
  const Cls = REGISTRY[name];
  if (!Cls) {
    const known = Object.keys(REGISTRY).join(', ');
    throw new Error(`Unknown provider "${name}". Available providers: ${known}. Add new ones in my-agent/providers/.`);
  }
  return new Cls({ name, baseUrl, model, timeoutMs });
}

export { BaseProvider, OpenAICompatibleProvider };
