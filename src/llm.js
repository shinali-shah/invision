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
export function createLlm({ apiKey, mock, model, fetchImpl = fetch, timeoutMs = 45000, responders = defaultResponders }) {
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

    let choice;
    try {
      choice = (await res.json()).choices?.[0];
    } catch (err) {
      throw new LlmError(`${name}: response was not JSON`, { cause: err });
    }
    // Muse Spark always reasons, and those tokens come out of max_completion_tokens.
    // When they eat the whole budget we get finish_reason "length" and no content at all.
    if (choice?.finish_reason === 'length') {
      throw new LlmError(`${name}: ran out of tokens while reasoning (max_completion_tokens ${maxTokens})`);
    }
    try {
      return JSON.parse(choice?.message?.content);
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
    json({ name, schema, system, user, effort = 'low', maxTokens = 8000 }) {
      return mock ? mockJson({ name, user }) : realJson({ name, schema, system, user, effort, maxTokens });
    },
  };
}
