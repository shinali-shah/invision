import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlm, LlmError } from '../src/llm.js';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

function fakeFetch(status, content, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status });
  };
}

test('real mode sends a strict json_schema chat completion to Muse Spark', async () => {
  const calls = [];
  const llm = createLlm({ apiKey: 'k', mock: false, model: 'muse-spark-1.3', fetchImpl: fakeFetch(200, '{"ok":true}', calls) });
  const out = await llm.json({ name: 'check', schema, system: 'sys', user: { a: 1 } });
  assert.deepEqual(out, { ok: true });

  const { url, init } = calls[0];
  assert.equal(url, 'https://api.meta.ai/v1/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'muse-spark-1.3');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.name, 'check');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.messages[0].role, 'developer');
  assert.deepEqual(JSON.parse(body.messages[1].content), { a: 1 });
  assert.equal('stop' in body, false);
  assert.equal('temperature' in body, false);
});

test('non-2xx rejects with LlmError', async () => {
  const llm = createLlm({ apiKey: 'k', mock: false, model: 'm', fetchImpl: fakeFetch(500, 'boom') });
  await assert.rejects(llm.json({ name: 'x', schema, system: '', user: {} }), LlmError);
});

test('unparsable content rejects with LlmError', async () => {
  const llm = createLlm({ apiKey: 'k', mock: false, model: 'm', fetchImpl: fakeFetch(200, 'not json') });
  await assert.rejects(llm.json({ name: 'x', schema, system: '', user: {} }), LlmError);
});

test('running out of tokens mid-reasoning rejects with a clear LlmError', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null } }] }), { status: 200 });
  const llm = createLlm({ apiKey: 'k', mock: false, model: 'm', fetchImpl });
  await assert.rejects(llm.json({ name: 'coach', schema, system: '', user: {} }), /ran out of tokens/);
});

test('default output budget leaves room for reasoning', async () => {
  const calls = [];
  const llm = createLlm({ apiKey: 'k', mock: false, model: 'm', fetchImpl: fakeFetch(200, '{"ok":true}', calls) });
  await llm.json({ name: 'x', schema, system: '', user: {} });
  assert.ok(JSON.parse(calls[0].init.body).max_completion_tokens >= 8000);
});

test('timeout rejects with LlmError', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const llm = createLlm({ apiKey: 'k', mock: false, model: 'm', fetchImpl: hang, timeoutMs: 20 });
  await assert.rejects(llm.json({ name: 'x', schema, system: '', user: {} }), LlmError);
});

test('mock mode dispatches to responders by name', async () => {
  const llm = createLlm({ mock: true, responders: { echo: u => ({ ...u, mocked: true }) } });
  assert.deepEqual(await llm.json({ name: 'echo', schema, system: '', user: { a: 1 } }), { a: 1, mocked: true });
  await assert.rejects(llm.json({ name: 'missing', schema, system: '', user: {} }), LlmError);
});
