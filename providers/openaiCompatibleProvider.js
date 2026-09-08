/**
 * openaiCompatibleProvider.js — fetch-based OpenAI-compatible chat client.
 * Works with any /v1/chat/completions endpoint (GLM, OpenAI, vLLM, Ollama, …).
 * Supports SSE streaming (with tool-call delta accumulation and usage in the
 * final chunk) and falls back to plain JSON if the server ignores stream:true.
 */
import { BaseProvider, kindError } from './baseProvider.js';

export class OpenAICompatibleProvider extends BaseProvider {
  async chat(messages, { apiKey, model, tools = null, temperature = 0.2, onDelta = null, signal = null } = {}) {
    if (!apiKey) {
      throw kindError('auth', 'API key is not set. Add LLM_API_KEY to my-agent/.env (see .env.example).');
    }
    const usedModel = model || this.defaultModel;
    const body = {
      model: usedModel,
      messages,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    // Hard request timeout (LLM_TIMEOUT) via AbortController — a stalled
    // server can no longer hang the agent loop forever.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const composed = signal ? AbortSignal.any([ac.signal, signal]) : ac.signal;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: composed,
      });
    } catch (err) {
      if (ac.signal.aborted && !signal?.aborted) {
        throw kindError('timeout', `LLM request timed out after ${this.timeoutMs}ms (${this.name})`);
      }
      throw kindError('network', `could not reach ${this.baseUrl}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      if (response.status === 401 || response.status === 403) {
        throw kindError('auth', `LLM API error ${response.status} (key rejected)${detail ? `: ${detail}` : ''}`, { status: response.status });
      }
      if (response.status === 429) {
        // Rate limited — deliberately NOT rotating keys (provider policy wins).
        throw kindError('rate_limited', `LLM API rate limited (429). Waiting is required — key rotation is not used to evade provider limits. ${detail}`, { status: 429 });
      }
      if (response.status >= 500) {
        throw kindError('server', `LLM API error ${response.status}: ${detail}`, { status: response.status });
      }
      throw kindError('bad_request', `LLM API error ${response.status}: ${detail}`, { status: response.status });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const data = await response.json(); // server ignored stream:true
      return {
        message: data.choices[0].message,
        usage: data.usage ?? null,
        model: data.model ?? usedModel,
        provider: this.name,
      };
    }

    // ---- SSE streaming (tool-call deltas accumulated by index) ----
    let content = '';
    const toolCalls = new Map();
    let usage = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          if (onDelta) onDelta(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const slot = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          toolCalls.set(tc.index, slot);
        }
      }
    }
    const message = { role: 'assistant', content: content || null };
    if (toolCalls.size > 0) {
      message.tool_calls = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, s]) => ({
          id: s.id || `call_${s.name}`,
          type: 'function',
          function: { name: s.name, arguments: s.args || '{}' },
        }));
    }
    return { message, usage, model: usedModel, provider: this.name };
  }
}
