/**
 * futureProviders.js — template for adding a new provider.
 *
 * my-agent intentionally ships no vendor SDKs. To support a proprietary API:
 *   1. Copy this file, extend BaseProvider, implement chat() with plain fetch.
 *   2. Map provider-specific errors onto the shared error kinds from
 *      baseProvider.js (auth / network / server / timeout / rate_limited /
 *      bad_request) so the key-health and failover logic keeps working.
 *   3. Register the class in providers/index.js under its provider name
 *      (LLM_PROVIDER=<name> or "name" in providers.json).
 *   4. Add unit tests against a local mock server (see test/providers.test.mjs).
 *
 * Nothing in this file is registered or executed — it is documentation-as-code.
 */
import { BaseProvider } from './baseProvider.js';

export class ExampleProvider extends BaseProvider {
  // async chat(messages, { apiKey, model, tools, onDelta, signal } = {}) {
  //   ...fetch against the vendor endpoint, normalize the response to
  //   { message, usage, model, provider } and throw kindError(...) on failures.
  // }
}
