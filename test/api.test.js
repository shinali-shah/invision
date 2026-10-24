import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';

let srv;
let base;

const config = Object.freeze({
  apiKey: null, mock: true, port: 0, languages: ['English', 'Spanish'],
  sparkModel: 'muse-spark-1.3', asrModel: 'muse-voice-transcribe-1.0', dbPath: ':memory:',
});

before(async () => {
  srv = createServer({ config, quiet: true, mockSpeed: 1000 });
  await new Promise(resolve => srv.server.listen(0, resolve));
  base = `http://localhost:${srv.server.address().port}`;
});

after(() => srv.close());

const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

function streamMockConversation(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/transcribe?conversationId=${id}`);
    const seen = [];
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg);
      if (msg.type === 'ready') {
        for (let i = 0; i < 10; i++) ws.send(Buffer.alloc(3840));
        ws.send(JSON.stringify({ type: 'end' }));
      }
      if (msg.type === 'done') { ws.close(); resolve(seen); }
      if (msg.type === 'error') reject(new Error(msg.message));
    });
    ws.on('error', reject);
  });
}

test('health reports mock mode', async () => {
  const { status, body } = await api('GET', '/api/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, mock: true });
});

test('creating a conversation needs consent and a known tag', async () => {
  assert.equal((await api('POST', '/api/conversations', { tag: 'family', otherName: 'Abuela' })).status, 400);
  assert.equal((await api('POST', '/api/conversations', { tag: 'work', otherName: 'x', consentConfirmed: true })).status, 400);
  const ok = await api('POST', '/api/conversations', { tag: 'family', otherName: 'Abuela', consentConfirmed: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.otherName, 'Abuela');
  assert.equal((await api('DELETE', `/api/conversations/${ok.body.id}`)).status, 204);
});

test('unknown ids 404', async () => {
  assert.equal((await api('GET', '/api/conversations/nope')).status, 404);
  assert.equal((await api('POST', '/api/conversations/nope/process', { reflection: '' })).status, 404);
  assert.equal((await api('DELETE', '/api/conversations/nope')).status, 404);
});

test('full flow: stream, label, process, retag, memory, next step, logs, delete', async () => {
  const { body: convo } = await api('POST', '/api/conversations', { tag: 'family', otherName: 'Abuela', consentConfirmed: true });

  const msgs = await streamMockConversation(convo.id);
  assert.equal(msgs[0].type, 'ready');
  assert.equal(msgs[0].mock, true);
  assert.ok(msgs.some(m => m.type === 'turn'));
  const done = msgs.at(-1);
  assert.equal(done.turns.length, 8);
  assert.equal((await api('GET', `/api/conversations/${convo.id}`)).body.turns.length, 8);

  assert.equal((await api('POST', `/api/conversations/${convo.id}/user-label`, { label: 'Z' })).status, 400);
  const labeled = await api('POST', `/api/conversations/${convo.id}/user-label`, { label: 'A' });
  assert.equal(labeled.body.userLabel, 'A');

  const processed = await api('POST', `/api/conversations/${convo.id}/process`, { reflection: 'felt rushed' });
  assert.equal(processed.status, 200);
  assert.equal(processed.body.signals.followUps, 3);
  assert.match(processed.body.note.text, /^You/);

  const retagged = await api('PATCH', `/api/conversations/${convo.id}`, { tag: 'networking' });
  assert.equal(retagged.body.tag, 'networking');
  assert.match(retagged.body.note.suggestion, /follow-up message/i);

  const memory = await api('GET', '/api/memory');
  assert.equal(memory.body.conversations.length, 3); // two seeded + this one
  assert.deepEqual(memory.body.pattern.counts, [1, 2, 3]);
  assert.equal(memory.body.signalTable.length, 3);
  assert.equal(memory.body.nextStep.status, 'proposed');

  const accepted = await api('POST', `/api/next-step/${memory.body.nextStep.id}`, { action: 'accept' });
  assert.equal(accepted.body.status, 'accepted');
  const changed = await api('POST', `/api/next-step/${memory.body.nextStep.id}`, { action: 'change', text: 'Call twice this week' });
  assert.equal(changed.body.status, 'changed');
  assert.equal(changed.body.text, 'Call twice this week');
  assert.equal((await api('POST', `/api/next-step/${memory.body.nextStep.id}`, { action: 'explode' })).status, 400);

  const logs = await api('GET', '/api/logs');
  assert.ok(logs.body.length > 0);

  assert.equal((await api('DELETE', `/api/conversations/${convo.id}`)).status, 204);
  const after = await api('GET', '/api/memory');
  assert.equal(after.body.conversations.length, 2);
  assert.equal(after.body.pattern, null);
});

test('a one-turn conversation processes with a too_short note', async () => {
  const { body: convo } = await api('POST', '/api/conversations', { tag: 'friend', otherName: 'Sam', consentConfirmed: true });
  const res = await api('POST', `/api/conversations/${convo.id}/process`, { reflection: '' });
  assert.equal(res.status, 200);
  assert.equal(res.body.note.reason, 'too_short');
  await api('DELETE', `/api/conversations/${convo.id}`);
});

test('malformed JSON body is a 400, not a 500', async () => {
  const res = await fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
});
