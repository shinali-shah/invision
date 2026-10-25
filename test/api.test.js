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

test('compare, follow-up and brief: the loop from one conversation to the next', async () => {
  const { body: convo } = await api('POST', '/api/conversations', { tag: 'family', otherName: 'Abuela', consentConfirmed: true });
  assert.equal((await api('POST', `/api/conversations/${convo.id}/follow-up`, {})).status, 400); // nothing to ground it on yet
  assert.equal((await api('GET', `/api/conversations/${convo.id}/compare`)).body.previousId, null);

  await streamMockConversation(convo.id);
  await api('POST', `/api/conversations/${convo.id}/user-label`, { label: 'A' });
  const processed = (await api('POST', `/api/conversations/${convo.id}/process`, { reflection: '' })).body;
  assert.ok(processed.hooks.topics.length > 0);
  assert.equal(processed.followUp.status, 'draft');
  assert.ok(processed.followUp.text.length > 0);

  const cmp = (await api('GET', `/api/conversations/${convo.id}/compare`)).body;
  assert.equal(cmp.samePerson, true);
  const followUps = cmp.metrics.find(m => m.key === 'followUps');
  assert.deepEqual([followUps.before, followUps.after, followUps.better], [2, 3, true]); // second seeded call had 2

  // Asking again returns the saved draft; regenerate makes a fresh one; text saves an edit
  const again = await api('POST', `/api/conversations/${convo.id}/follow-up`, {});
  assert.equal(again.body.text, processed.followUp.text);
  assert.equal((await api('POST', `/api/conversations/${convo.id}/follow-up`, { regenerate: true })).body.status, 'draft');
  assert.equal((await api('POST', `/api/conversations/${convo.id}/follow-up`, { text: '   ' })).status, 400);
  const edited = await api('POST', `/api/conversations/${convo.id}/follow-up`, { text: ' Te quiero, Abuela ' });
  assert.equal(edited.body.text, 'Te quiero, Abuela');

  const sent = await api('POST', `/api/conversations/${convo.id}/follow-up/sent`, { text: 'Te quiero mucho, Abuela' });
  assert.equal(sent.body.status, 'sent');
  assert.equal(sent.body.text, 'Te quiero mucho, Abuela'); // what was shared, even if the edit save was lost
  assert.ok(sent.body.sentAt);

  const { brief } = (await api('GET', '/api/brief?name=abuela')).body;
  assert.equal(brief.conversations, 3);
  assert.ok(brief.items.length > 0 && brief.items.length <= 4);
  assert.deepEqual((await api('GET', '/api/brief?name=Nobody')).body, { brief: null });
  assert.equal((await api('GET', '/api/brief')).status, 400);

  await api('DELETE', `/api/conversations/${convo.id}`);
});

test('the seeded promise to call her sister shows up in the brief', async () => {
  const { brief } = (await api('GET', '/api/brief?name=Abuela')).body;
  assert.equal(brief.items[0].kind, 'commitment');
  assert.match(brief.items[0].text, /call you Sunday/);
});

test('a mic test does not become the baseline or wipe the brief, and names match loosely', async () => {
  const { body: mic } = await api('POST', '/api/conversations', { tag: 'family', otherName: '  abuela ', consentConfirmed: true });
  await api('POST', `/api/conversations/${mic.id}/process`, { reflection: '' }); // no turns: too short
  const { brief } = (await api('GET', '/api/brief?name=ABUELA')).body;
  assert.equal(brief.items[0].kind, 'commitment'); // still from the last real call

  const { body: convo } = await api('POST', '/api/conversations', { tag: 'family', otherName: 'Abuela', consentConfirmed: true });
  await streamMockConversation(convo.id);
  await api('POST', `/api/conversations/${convo.id}/user-label`, { label: 'A' });
  await api('POST', `/api/conversations/${convo.id}/process`, { reflection: '' });
  const cmp = (await api('GET', `/api/conversations/${convo.id}/compare`)).body;
  assert.notEqual(cmp.previousId, mic.id);
  assert.equal(cmp.samePerson, true);
  assert.equal(cmp.suggestion.followed, true); // last note said ask about Oaxaca, and they did

  // Sent stays sent through a reprocess; an edit that changes the text goes back to draft
  await api('POST', `/api/conversations/${convo.id}/follow-up/sent`, { text: 'Te quiero, Abuela' });
  const again = (await api('POST', `/api/conversations/${convo.id}/process`, { reflection: '' })).body;
  assert.equal(again.followUp.status, 'sent');
  assert.equal(again.followUp.text, 'Te quiero, Abuela');
  const edited = (await api('POST', `/api/conversations/${convo.id}/follow-up`, { text: 'Hablamos el domingo, Abuela. Oaxaca!' })).body;
  assert.equal(edited.status, 'draft');
  assert.equal(edited.source, 'edited');
  assert.ok(edited.hooksUsed.includes('Oaxaca'));

  await api('DELETE', `/api/conversations/${mic.id}`);
  await api('DELETE', `/api/conversations/${convo.id}`);
});

test('unnamed conversations are never "the same person"', async () => {
  const { samePerson, normName } = await import('../src/names.js');
  assert.equal(samePerson('them', 'them'), false);
  assert.equal(samePerson('María  José', 'maria jose'), true);
  assert.equal(normName('  Priya   Shah '), 'priya shah');
});
