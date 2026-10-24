import defaultResponders from './mock/responders.js';

const CHAT_URL = 'https://api.meta.ai/v1/chat/completions';

export class LlmError extends Error {
  constructor(message, { cause, status } = {}) {
    super(message, { cause });
    this.name = 'LlmError';
    this.status = status;
  }
}

// Thin Muse Spark client. Every agent asks for strict JSON, so that's the only call shape we expose.
export function createLlm({ apiKey, mock, model, fetchImpl = fetch, timeoutMs = 20000, responders = defaultResponders }) {
  async function realJson({ name, schema, system, user, effort, maxTokens }) {
    let res;
    try {
      res = await fetchImpl(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'developer', content: system },
            { role: 'user', content: JSON.stringify(user) },
          ],
          reasoning_effort: effort,
          max_completion_tokens: maxTokens,
          response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LlmError(`${name}: request failed (${err.name})`, { cause: err });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LlmError(`${name}: HTTP ${res.status} ${detail.slice(0, 200)}`, { status: res.status });
    }

    let content;
    try {
      content = (await res.json()).choices?.[0]?.message?.content;
      return JSON.parse(content);
    } catch (err) {
      throw new LlmError(`${name}: response was not JSON`, { cause: err });
    }
  }

  async function mockJson({ name, user }) {
    const responder = responders[name];
    if (!responder) throw new LlmError(`${name}: no mock responder`);
    return responder(user);
  }

  return {
    mock: !!mock,
    json({ name, schema, system, user, effort = 'low', maxTokens = 800 }) {
      return mock ? mockJson({ name, user }) : realJson({ name, schema, system, user, effort, maxTokens });
    },
  };
}
