import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';

let srv;
let base;

const config = Object.freeze({
  apiKey: null, mock: true, port: 0, languages: ['English', 'Spanish'],
  sparkModel: 'muse-spark-1.3', asrModel: 'muse-voice-transcribe-1.0', dbPath: ':memory:', userName: 'Parth',
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

test('an API path nobody serves answers JSON, and the pages still come from static', async () => {
  const miss = await api('GET', '/api/nope');
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.body, { error: 'Not found' });
  assert.equal((await api('POST', '/api/conversations/x/nope', {})).status, 404);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
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

test('a recording nobody labelled is flagged needsLabel in the lists until a line is tapped', async () => {
  const { body: convo } = await api('POST', '/api/conversations', { tag: 'friend', otherName: 'Shruti', consentConfirmed: true });
  // Nothing recorded yet: nothing to label.
  assert.equal((await api('GET', '/api/conversations')).body.find(c => c.id === convo.id).needsLabel, false);

  await streamMockConversation(convo.id);
  const listed = (await api('GET', '/api/conversations')).body.find(c => c.id === convo.id);
  assert.equal(listed.needsLabel, true);
  const inMemory = (await api('GET', '/api/memory')).body.conversations.find(c => c.id === convo.id);
  assert.equal(inMemory.needsLabel, true);
  // Seeded conversations came labelled.
  assert.ok((await api('GET', '/api/memory')).body.conversations.filter(c => c.seeded).every(c => c.needsLabel === false));

  await api('POST', `/api/conversations/${convo.id}/user-label`, { label: 'A' });
  assert.equal((await api('GET', '/api/conversations')).body.find(c => c.id === convo.id).needsLabel, false);
  await api('DELETE', `/api/conversations/${convo.id}`);
});

test('two taps on Get coaching share one run', async () => {
  const { body: convo } = await api('POST', '/api/conversations', { tag: 'friend', otherName: 'Sam', consentConfirmed: true });
  await streamMockConversation(convo.id);
  await api('POST', `/api/conversations/${convo.id}/user-label`, { label: 'A' });
  const [a, b] = await Promise.all([
    api('POST', `/api/conversations/${convo.id}/process`, { reflection: '' }),
    api('POST', `/api/conversations/${convo.id}/process`, { reflection: '' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.note.text, b.body.note.text);
  const logs = (await api('GET', '/api/logs')).body.filter(l => l.agent === 'coach' && /drafted/.test(l.message));
  assert.ok(logs.length >= 1);
  await api('DELETE', `/api/conversations/${convo.id}`);
});

// ---- lip lock: the cues file lives next to the video ----

test('a video upload keeps the lip-lock cues; deleting the conversation removes them', async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createApp } = await import('../src/routes.js');
  const { openStore } = await import('../src/db.js');
  const { createLogger } = await import('../src/log.js');
  const { createLlm } = await import('../src/llm.js');
  const http = await import('node:http');

  const recordingsDir = mkdtempSync(join(tmpdir(), 'playback-cues-api-'));
  const store = openStore();
  const app = createApp({ store, llm: createLlm({ mock: true }), log: createLogger(store, { quiet: true }), config, recordingsDir });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const url = p => `http://localhost:${server.address().port}${p}`;
  try {
    const convo = store.createConversation({ tag: 'friend', otherName: 'Maya' });
    const cuesFile = join(recordingsDir, `${convo.id}.cues.json`);
    writeFileSync(cuesFile, '[]');
    const up = await fetch(url(`/api/conversations/${convo.id}/recording?offsetMs=0`), { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(64, 1) });
    assert.equal(up.status, 201);
    assert.ok(existsSync(cuesFile), 'cues survive the upload');
    assert.ok(existsSync(join(recordingsDir, `${convo.id}.webm`)));
    const del = await fetch(url(`/api/conversations/${convo.id}`), { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal(existsSync(cuesFile), false);
    assert.equal(existsSync(join(recordingsDir, `${convo.id}.webm`)), false);
  } finally {
    server.close();
  }
});

test('/api/me says who is holding the phone', async () => {
  const { status, body } = await api('GET', '/api/me');
  assert.equal(status, 200);
  assert.deepEqual(body, { name: 'Parth' });
});

test('a conversation can start without a name and be named later', async () => {
  const made = await api('POST', '/api/conversations', { tag: 'friend', consentConfirmed: true });
  assert.equal(made.status, 201);
  assert.equal(made.body.otherName, 'them');
  const id = made.body.id;

  const named = await api('PATCH', `/api/conversations/${id}`, { otherName: '  Priya Nair  ' });
  assert.equal(named.status, 200);
  assert.equal(named.body.otherName, 'Priya Nair');
  assert.equal(named.body.tag, 'friend');
  assert.equal((await api('GET', `/api/conversations/${id}`)).body.otherName, 'Priya Nair');

  const long = await api('PATCH', `/api/conversations/${id}`, { otherName: 'x'.repeat(100) });
  assert.equal(long.body.otherName.length, 80);
  // clearing it goes back to nobody in particular
  assert.equal((await api('PATCH', `/api/conversations/${id}`, { otherName: '   ' })).body.otherName, 'them');
  assert.equal((await api('PATCH', `/api/conversations/${id}`, {})).status, 400);
  assert.equal((await api('PATCH', `/api/conversations/${id}`, { otherName: 42 })).status, 400);
  await api('DELETE', `/api/conversations/${id}`);
});

test('a name heard in the mock stream is on the conversation when the stream ends', async () => {
  const { body: convo } = await api('POST', '/api/conversations', { tag: 'family', consentConfirmed: true });
  const msgs = await streamMockConversation(convo.id);
  const person = msgs.find(m => m.type === 'person');
  assert.equal(person?.name, 'Abuela');
  assert.equal(person.turnId, 1);
  assert.equal((await api('GET', `/api/conversations/${convo.id}`)).body.otherName, 'Abuela');
  await api('DELETE', `/api/conversations/${convo.id}`);
});

test('"Them" in any case is nobody, so the stream can still fill the name in', async () => {
  const made = await api('POST', '/api/conversations', { tag: 'friend', otherName: '  THEM ', consentConfirmed: true });
  assert.equal(made.body.otherName, 'them');
  assert.equal((await api('PATCH', `/api/conversations/${made.body.id}`, { otherName: 'Them' })).body.otherName, 'them');
  assert.equal((await api('PATCH', `/api/conversations/${made.body.id}`, { otherName: 'Thembi' })).body.otherName, 'Thembi');
  await api('DELETE', `/api/conversations/${made.body.id}`);
});

test('one voice only: no screen asks for a tap, and insight does not 409 where process succeeds', async () => {
  const { body: convo } = await api('POST', '/api/conversations', { tag: 'friend', otherName: 'Sam', consentConfirmed: true });
  await streamMockConversation(convo.id);
  const turns = srv.store.getConversation(convo.id).turns.map(t => ({ ...t, speaker: 'A' }));
  srv.store.updateConversation(convo.id, { turns });
  assert.equal((await api('GET', '/api/conversations')).body.find(c => c.id === convo.id).needsLabel, false);
  assert.equal((await api('POST', `/api/conversations/${convo.id}/insight`, {})).status, 200);
  assert.equal((await api('POST', `/api/conversations/${convo.id}/process`, { reflection: '' })).status, 200);
  await api('DELETE', `/api/conversations/${convo.id}`);
});

// A server on its own store, so a test can break the store or wire a fake stage.
async function scratchApp({ store, llm, stage } = {}) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createApp } = await import('../src/routes.js');
  const { openStore } = await import('../src/db.js');
  const { createLogger } = await import('../src/log.js');
  const { createLlm } = await import('../src/llm.js');
  const { createTurnAssembler } = await import('../src/transcribe/assemble.js');
  const { DEMO_EVENTS } = await import('../src/mock/demoConversation.js');
  const http = await import('node:http');
  const real = openStore();
  store = store ? store(real) : real;
  const recordingsDir = mkdtempSync(join(tmpdir(), 'playback-scratch-'));
  const app = createApp({ store, llm: llm ?? createLlm({ mock: true }), log: createLogger(real, { quiet: true }), config, stage, recordingsDir });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const call = async (method, path, body) => {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const asm = createTurnAssembler();
  for (const e of DEMO_EVENTS) asm.push(e);
  const frames = [];
  for (let t = 0; t <= 32500; t += 200) frames.push({ t, face: true, smile: 0.3, jawOpen: t % 400 ? 0.5 : 0.1, browUp: 0, yaw: 0, pitch: 0 });
  // raw body upload, for the video route
  const upload = async (path, body, headers = {}) => {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'video/mp4', ...headers }, body });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { store: real, call, upload, frames, turns: asm.flush(), recordingsDir, port: () => server.address().port, close: () => server.close() };
}

test('a conversation deleted while coaching runs answers 404 on every screen, not a crash or a null', async () => {
  const quick = (await import('../src/llm.js')).createLlm({ mock: true });
  const slow = { mock: true, json: async args => { await new Promise(r => setTimeout(r, 30)); return quick.json(args); } };
  const { store, call, frames, turns, close } = await scratchApp({ llm: slow });
  try {
    const convo = store.createConversation({ tag: 'friend', otherName: 'Sam' });
    store.updateConversation(convo.id, { turns, userLabel: 'A' });
    const process = call('POST', `/api/conversations/${convo.id}/process`, { reflection: '' });
    await new Promise(r => setTimeout(r, 10));
    const behavior = call('POST', `/api/conversations/${convo.id}/behavior`, { frames, fps: 5 });
    const insight = call('POST', `/api/conversations/${convo.id}/insight`, {});
    await new Promise(r => setTimeout(r, 10));
    assert.equal((await call('DELETE', `/api/conversations/${convo.id}`)).status, 204);
    const [p, b, i] = await Promise.all([process, behavior, insight]);
    for (const [name, r] of Object.entries({ p, b, i })) {
      assert.equal(r.status, 404, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'Conversation not found', name);
    }
    assert.equal(store.getConversation(convo.id), null);
    // and a tag change that loses its conversation mid-recoach is a 404 too, not a TypeError
    const again = store.createConversation({ tag: 'friend', otherName: 'Sam' });
    store.updateConversation(again.id, { turns, userLabel: 'A' });
    assert.equal((await call('POST', `/api/conversations/${again.id}/process`, { reflection: '' })).status, 200);
    const retag = call('PATCH', `/api/conversations/${again.id}`, { tag: 'family' });
    await new Promise(r => setTimeout(r, 10));
    store.deleteConversation(again.id);
    assert.equal((await retag).status, 404);
  } finally { close(); }
});

test('a coaching run that blows up is a JSON error on every screen and the next tap starts clean', async () => {
  let blow = 1;
  const published = [];
  const quick = (await import('../src/llm.js')).createLlm({ mock: true });
  // slow enough that the three requests really do share the run that fails
  const slow = { mock: true, json: async args => { await new Promise(r => setTimeout(r, 30)); return quick.json(args); } };
  const { store, call, frames, turns, close } = await scratchApp({
    llm: slow,
    stage: { publish: m => published.push(m), focus() {} },
    // the store falls over once, on the first write of the signals
    store: real => ({ ...real, updateConversation: (id, patch) => { if (patch.signals && blow-- > 0) throw new Error('disk full'); return real.updateConversation(id, patch); } }),
  });
  try {
    const convo = store.createConversation({ tag: 'friend', otherName: 'Sam' });
    store.updateConversation(convo.id, { turns, userLabel: 'A' });
    const process = call('POST', `/api/conversations/${convo.id}/process`, { reflection: '' });
    await new Promise(r => setTimeout(r, 10));
    const [p, b, i] = await Promise.all([
      process,
      call('POST', `/api/conversations/${convo.id}/behavior`, { frames, fps: 5 }),
      call('POST', `/api/conversations/${convo.id}/insight`, {}),
    ]);
    for (const [name, r] of Object.entries({ p, b, i })) {
      assert.equal(r.status, 500, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'Something went wrong on our side');
    }
    assert.equal(published.filter(m => m.type === 'processing' && m.failed).length, 1, 'one run, one failure for the screens');
    assert.equal(store.getConversation(convo.id).behavior, null, 'no cues were aligned to a note that never came');
    // the failed run is no longer "in flight": the next tap runs for real
    const retry = await call('POST', `/api/conversations/${convo.id}/process`, { reflection: '' });
    assert.equal(retry.status, 200);
    assert.ok(retry.body.note?.text);
    assert.equal(published.filter(m => m.type === 'memory').length, 1, 'a finished run refreshes memory');
  } finally { close(); }
});

test('one voice: the coach, the face alignment, the insight and the heatmap all call it yours', async () => {
  const published = [];
  const { store, call, frames, turns, close } = await scratchApp({ stage: { publish: m => published.push(m), focus() {} } });
  try {
    const convo = store.createConversation({ tag: 'friend', otherName: 'Sam' });
    store.updateConversation(convo.id, { turns: turns.map(t => ({ ...t, speaker: 'A' })) });
    // coaching started from the Mac's replay page, not the phone
    const b = await call('POST', `/api/conversations/${convo.id}/behavior`, { frames, fps: 5 });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.ok(b.body.behavior.turns.length >= 2);
    assert.ok(b.body.behavior.turns.every(t => t.speaker === 'you'), 'the one voice is the user, as the coach took it');
    const saved = store.getConversation(convo.id);
    assert.equal(saved.userLabel, null, 'nothing was guessed onto the record');
    assert.equal(saved.signals.userTurns, turns.length);
    assert.ok(published.some(m => m.type === 'memory'), 'coaching from the Mac refreshes the memory screens too');
    const heat = await call('GET', `/api/conversations/${convo.id}/heatmap`);
    assert.equal(heat.status, 200);
    assert.ok(heat.body.turns.every(t => t.speaker === 'you'), JSON.stringify(heat.body.turns?.[0]));
  } finally { close(); }
});

// ---- every route that coaches shares the one run ----

test('behavior, process, insight and a tag change landing together pay Muse once', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createApp } = await import('../src/routes.js');
  const { openStore } = await import('../src/db.js');
  const { createLogger } = await import('../src/log.js');
  const { createLlm } = await import('../src/llm.js');
  const { createTurnAssembler } = await import('../src/transcribe/assemble.js');
  const { DEMO_EVENTS } = await import('../src/mock/demoConversation.js');
  const http = await import('node:http');

  const calls = [];
  const quick = createLlm({ mock: true });
  // Slow enough that the second request arrives mid-run, the way the Mac's replay page does
  // while the phone is still on "get coaching".
  const slow = { mock: true, json: async args => { calls.push(args.name); await new Promise(r => setTimeout(r, 30)); return quick.json(args); } };
  const store = openStore();
  const app = createApp({ store, llm: slow, log: createLogger(store, { quiet: true }), config, recordingsDir: mkdtempSync(join(tmpdir(), 'playback-race-')) });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const url = p => `http://localhost:${server.address().port}${p}`;
  const call = async (method, path, body) => {
    const res = await fetch(url(path), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const asm = createTurnAssembler();
  for (const e of DEMO_EVENTS) asm.push(e);
  const turns = asm.flush();
  const frames = [];
  for (let t = 0; t <= 32500; t += 200) frames.push({ t, face: true, smile: 0.3, jawOpen: t % 400 ? 0.5 : 0.1, browUp: 0, yaw: 0, pitch: 0 });
  const later = ms => new Promise(r => setTimeout(r, ms));

  try {
    const convo = store.createConversation({ tag: 'friend', otherName: 'Sam' });
    store.updateConversation(convo.id, { turns, userLabel: 'A' });
    const behavior = call('POST', `/api/conversations/${convo.id}/behavior`, { frames, fps: 5 });
    await later(10);
    const process = call('POST', `/api/conversations/${convo.id}/process`, { reflection: '' });
    await later(10);
    const insight = call('POST', `/api/conversations/${convo.id}/insight`, {});
    const retag = call('PATCH', `/api/conversations/${convo.id}`, { tag: 'networking' });
    const [b, p, i, r] = await Promise.all([behavior, process, insight, retag]);
    assert.equal(b.status, 200);
    assert.equal(p.status, 200);
    assert.equal(i.status, 200);
    assert.equal(r.status, 409, 'the tag waits for coaching to finish, whichever screen started it');
    assert.equal(calls.filter(n => n === 'coach').length, 1);
    assert.equal(calls.filter(n => n === 'classify').length, 1);
    assert.ok(p.body.note?.text, 'the joined process call still gets the finished note');
    assert.ok(i.body.adviceCheck?.length, 'the insight waited for the note it checks');
    assert.equal(store.getConversation(convo.id).insight?.source, i.body.source);
  } finally {
    server.close();
  }
});

test('.env typos behave as the README says: MOCK=true is mock, a bad PORT falls back, blanks mean defaults', async () => {
  const { readConfig } = await import('../src/config.js');
  assert.equal(readConfig({ MODEL_API_KEY: 'k', MOCK: 'true' }).mock, true);
  assert.equal(readConfig({ MODEL_API_KEY: 'k', MOCK: '1' }).mock, true);
  assert.equal(readConfig({ MODEL_API_KEY: 'k', MOCK: '' }).mock, false);
  assert.equal(readConfig({ MODEL_API_KEY: 'k', MOCK: '0' }).mock, false);
  assert.equal(readConfig({ MODEL_API_KEY: '   ' }).mock, true, 'a blank key is no key');
  assert.equal(readConfig({ PORT: 'abc' }).port, 3000);
  assert.equal(readConfig({ PORT: '' }).port, 3000);
  assert.equal(readConfig({ PORT: '41873' }).port, 41873);
  const bare = readConfig({});
  assert.deepEqual(bare.languages, ['English', 'Spanish']);
  assert.equal(bare.userName, 'Parth');
  assert.equal(bare.dbPath, 'data/playback.db');
  assert.equal(bare.recordingsDir, 'data/recordings');
  assert.equal(readConfig({ USER_NAME: ' Priya ' }).userName, 'Priya');
  assert.deepEqual(readConfig({ DEMO_LANGUAGES: 'English, Hindi ,' }).languages, ['English', 'Hindi']);
});

// ---- deleted while a slower screen was still working on it ----

test('a conversation deleted while the follow-up drafts, the insight writes or the cues align answers 404 and writes nothing back', async () => {
  const { readdirSync } = await import('node:fs');
  const quick = (await import('../src/llm.js')).createLlm({ mock: true });
  const slow = { mock: true, json: async args => { await new Promise(r => setTimeout(r, 30)); return quick.json(args); } };
  const published = [];
  const { store, call, frames, turns, recordingsDir, close } = await scratchApp({ llm: slow, stage: { publish: m => published.push(m), focus() {} } });
  const later = ms => new Promise(r => setTimeout(r, ms));
  const coached = async () => {
    const convo = store.createConversation({ tag: 'friend', otherName: 'Sam' });
    store.updateConversation(convo.id, { turns, userLabel: 'A' });
    assert.equal((await call('POST', `/api/conversations/${convo.id}/process`, { reflection: '' })).status, 200);
    return convo;
  };
  try {
    for (const [name, start] of [
      ['follow-up', id => call('POST', `/api/conversations/${id}/follow-up`, { regenerate: true })],
      ['insight', id => call('POST', `/api/conversations/${id}/insight`, {})],
      ['behavior', id => call('POST', `/api/conversations/${id}/behavior`, { frames, fps: 5 })],
    ]) {
      const convo = await coached();
      const pending = start(convo.id);
      await later(10); // Muse is "thinking" when the delete lands
      assert.equal((await call('DELETE', `/api/conversations/${convo.id}`)).status, 204, name);
      const r = await pending;
      assert.equal(r.status, 404, `${name}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'Conversation not found', name);
      assert.equal(store.getConversation(convo.id), null, name);
      assert.ok(!readdirSync(recordingsDir).some(f => f.startsWith(convo.id)), `${name}: left ${readdirSync(recordingsDir)}`);
    }
    assert.ok(published.every(m => m.type !== 'conversation' || m.conversation), 'no screen was handed a null conversation');
  } finally { close(); }
});

test('an upload that finishes after its conversation was deleted is dropped, and two uploads racing leave one consistent file', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const http = await import('node:http');
  const { store, upload, recordingsDir, port, close } = await scratchApp();
  const files = id => readdirSync(recordingsDir).filter(f => f.startsWith(id));
  // streams `chunks` with a pause between them, so a delete (or another upload) can land mid-way
  const slowUpload = (id, chunks, { between, query = '' } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${port()}/api/conversations/${id}/recording${query}`, { method: 'POST', headers: { 'Content-Type': 'video/mp4', 'Content-Length': chunks.reduce((n, c) => n + c.length, 0) } }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    (async () => {
      for (const [i, c] of chunks.entries()) {
        req.write(c);
        if (i === 0) await between?.();
        await new Promise(r => setTimeout(r, 5));
      }
      req.end();
    })();
  });
  try {
    const gone = store.createConversation({ tag: 'friend', otherName: 'Sam' });
    const r = await slowUpload(gone.id, [Buffer.alloc(4096), Buffer.alloc(4096)], {
      between: async () => { store.deleteConversation(gone.id); },
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.deepEqual(files(gone.id), [], 'no video for a conversation that is gone');

    const convo = store.createConversation({ tag: 'friend', otherName: 'Sam' });
    let quick;
    const slow = slowUpload(convo.id, Array.from({ length: 4 }, () => Buffer.alloc(16384, 7)), {
      query: '?offsetMs=10',
      between: async () => { quick = await upload(`/api/conversations/${convo.id}/recording?offsetMs=20`, Buffer.alloc(1024, 9), { 'Content-Type': 'video/webm' }); },
    });
    const late = await slow;
    assert.equal(quick.status, 201);
    assert.equal(late.status, 201, JSON.stringify(late.body));
    const left = files(convo.id);
    const recording = store.getConversation(convo.id).recording;
    assert.deepEqual(left, [`${convo.id}.${recording.ext}`], 'exactly one video, the one on record');
    assert.equal(statSync(join(recordingsDir, left[0])).size, recording.bytes);
    assert.equal(recording.bytes, 4 * 16384, 'the upload that finished last is the one kept');
    assert.equal(recording.offsetMs, 10);
  } finally { close(); }
});

test('a phone that hangs up mid-upload leaves no temp file and is not logged as a server error', async () => {
  const { readdirSync } = await import('node:fs');
  const http = await import('node:http');
  const { store, recordingsDir, port, close } = await scratchApp();
  try {
    const convo = store.createConversation({ tag: 'friend', otherName: 'Sam' });
    await new Promise(resolve => {
      const req = http.request(`http://localhost:${port()}/api/conversations/${convo.id}/recording`, { method: 'POST', headers: { 'Content-Type': 'video/mp4', 'Content-Length': 100000 } });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.write(Buffer.alloc(10000));
      setTimeout(() => req.destroy(), 20);
    });
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(readdirSync(recordingsDir).filter(f => f.startsWith(convo.id)), []);
    assert.equal(store.getConversation(convo.id).recording, null);
    const logs = store.listLogs(50);
    assert.ok(!logs.some(l => l.level === 'error'), JSON.stringify(logs.filter(l => l.level === 'error')));
    assert.ok(logs.some(l => l.agent === 'video' && /dropped/.test(l.message)), 'the drop is noted, as a warning');
  } finally { close(); }
});
