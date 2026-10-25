import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';
import { createStageHub } from '../src/stage.js';

let srv;
let base;

before(async () => {
  const config = Object.freeze({
    apiKey: null, mock: true, port: 0, languages: ['English', 'Spanish'],
    sparkModel: 'muse-spark-1.3', asrModel: 'muse-voice-transcribe-1.0', dbPath: ':memory:',
  });
  srv = createServer({ config, quiet: true, mockSpeed: 1000 });
  await new Promise(resolve => srv.server.listen(0, resolve));
  base = `http://localhost:${srv.server.address().port}`;
});

after(() => srv.close());

const post = (path, body, method = 'POST') => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
});

// Collects stage messages; waitFor resolves once a matching one has arrived.
function openStage() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/stage`);
    const msgs = [];
    const waiters = [];
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      msgs.push(msg);
      for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    });
    const waitFor = (match, ms = 3000) => {
      const found = msgs.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((res, rej) => {
        const w = { match, resolve: res };
        waiters.push(w);
        setTimeout(() => rej(new Error('stage message never arrived')), ms);
      });
    };
    ws.on('open', () => resolve({ ws, msgs, waitFor }));
    ws.on('error', reject);
  });
}

test('hub sends hello with the last focus and fans out to every subscriber', () => {
  const hub = createStageHub({ mock: true });
  const sent = [[], [], []];
  const fake = i => ({ readyState: 1, OPEN: 1, send: s => sent[i].push(JSON.parse(s)), on() {} });
  hub.subscribe(fake(0));
  hub.focus({ view: 'recording', conversationId: 'c1' });
  hub.subscribe(fake(1));
  hub.publish({ type: 'memory' });

  assert.deepEqual(sent[0][0], { type: 'hello', mock: true, focus: null });
  const remembered = sent[1][0];
  assert.ok(Number.isFinite(remembered.focus.at));
  delete remembered.focus.at;
  assert.deepEqual(remembered, { type: 'hello', mock: true, focus: { view: 'recording', conversationId: 'c1', otherName: null } });

  assert.deepEqual(sent[0].at(-1), { type: 'memory' });
  assert.deepEqual(sent[1].at(-1), { type: 'memory' });

  // The stream ending demotes a remembered "recording" focus, so late joiners don't see a ghost recording
  hub.publish({ type: 'done', conversationId: 'c1', turns: [] });
  hub.subscribe(fake(2));
  assert.equal(sent[2][0].focus.view, 'label');
});

test('hub replays the lines of a recording still going to a late joiner', () => {
  const hub = createStageHub({ mock: true });
  const sent = [];
  const fake = () => ({ readyState: 1, OPEN: 1, send: s => sent.push(JSON.parse(s)), on() {} });
  hub.focus({ view: 'recording', conversationId: 'c1' });
  // Finished turns, out of order, with a partial for the open one and a stale partial for a closed one
  hub.publish({ type: 'turn', conversationId: 'c1', turn: { turnId: 2, speaker: 'B', text: 'two', startMs: 3000, endMs: 5000 } });
  hub.publish({ type: 'partial', conversationId: 'c1', turnId: 1, text: 'on', speaker: 'unknown' });
  hub.publish({ type: 'turn', conversationId: 'c1', turn: { turnId: 1, speaker: 'A', text: 'one', startMs: 0, endMs: 2000 } });
  hub.publish({ type: 'partial', conversationId: 'c1', turnId: 3, text: 'thr', speaker: 'unknown' });
  hub.publish({ type: 'partial', conversationId: 'c1', turnId: 3, text: 'three so', speaker: 'A' });

  hub.subscribe(fake());
  assert.equal(sent[0].type, 'hello');
  assert.deepEqual(sent.slice(1).map(m => [m.type, m.turnId ?? m.turn.turnId, m.text ?? m.turn.text]), [
    ['turn', 1, 'one'], ['turn', 2, 'two'], ['partial', 3, 'three so'],
  ]);

  // Once the recording is over the store has the turns; nothing to replay
  hub.publish({ type: 'done', conversationId: 'c1', turns: [] });
  sent.length = 0;
  hub.subscribe(fake());
  assert.deepEqual(sent.map(m => m.type), ['hello']);
});

test('hub forgets a deleted conversation, including when it was the one in focus', () => {
  const hub = createStageHub({ mock: true });
  const sent = [];
  const fake = () => ({ readyState: 1, OPEN: 1, send: s => sent.push(JSON.parse(s)), on() {} });
  hub.focus({ view: 'coaching', conversationId: 'c1', otherName: 'Abuela' });
  hub.publish({ type: 'turn', conversationId: 'c1', turn: { turnId: 1, speaker: 'A', text: 'one' } });
  hub.publish({ type: 'deleted', conversationId: 'c1' });
  hub.subscribe(fake());
  assert.deepEqual(sent.map(m => m.type), ['hello']);
  assert.equal(sent[0].focus.view, 'start');
  assert.equal(sent[0].focus.conversationId, null);

  // Memory stays memory: that screen doesn't depend on the deleted one
  hub.focus({ view: 'memory', conversationId: 'c2' });
  hub.publish({ type: 'deleted', conversationId: 'c2' });
  sent.length = 0;
  hub.subscribe(fake());
  assert.equal(sent[0].focus.view, 'memory');
  assert.equal(sent[0].focus.conversationId, null);

  // Deleting something else leaves the focus alone
  hub.focus({ view: 'coaching', conversationId: 'c3' });
  hub.publish({ type: 'deleted', conversationId: 'c4' });
  sent.length = 0;
  hub.subscribe(fake());
  assert.equal(sent[0].focus.conversationId, 'c3');
});

test('hub skips closed sockets and cuts off one that stopped reading', () => {
  const hub = createStageHub({ mock: true });
  const sent = [];
  let terminated = 0;
  const listeners = {};
  const closed = { readyState: 3, OPEN: 1, send: () => { throw new Error('send on a closed socket'); }, on() {} };
  const stuck = { readyState: 1, OPEN: 1, bufferedAmount: 2 << 20, send: s => sent.push(s), on() {}, terminate: () => { terminated++; } };
  const fine = { readyState: 1, OPEN: 1, send: s => sent.push(JSON.parse(s)), on: (ev, fn) => { listeners[ev] = fn; } };
  hub.subscribe(closed);
  hub.subscribe(stuck);
  hub.subscribe(fine);
  assert.equal(terminated, 1);
  hub.publish({ type: 'memory' });
  assert.equal(terminated, 2);
  assert.deepEqual(sent.map(m => m.type), ['hello', 'memory']);
  // a client that sends garbage emits 'error'; without a listener that would crash the process
  assert.equal(typeof listeners.error, 'function');
  assert.doesNotThrow(() => listeners.error(new Error('invalid frame')));
});

test('focus endpoint validates the view and broadcasts it', async () => {
  const stage = await openStage();
  await stage.waitFor(m => m.type === 'hello');
  assert.equal((await post('/api/stage/focus', { view: 'nope' })).status, 400);
  assert.equal((await post('/api/stage/focus', { view: 'memory', conversationId: null })).status, 204);
  const focus = await stage.waitFor(m => m.type === 'focus');
  assert.ok(Number.isFinite(focus.at));
  delete focus.at;
  assert.deepEqual(focus, { type: 'focus', view: 'memory', conversationId: null, otherName: null });
  stage.ws.close();
});

test('stage follows a whole conversation from the phone', async () => {
  const stage = await openStage();
  const created = await (await post('/api/conversations', { tag: 'family', otherName: 'Abuela', consentConfirmed: true })).json();
  const id = created.id;
  await stage.waitFor(m => m.type === 'conversation' && m.conversation.id === id);

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/transcribe?conversationId=${id}`);
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') {
        for (let i = 0; i < 5; i++) ws.send(Buffer.alloc(3840));
        ws.send(JSON.stringify({ type: 'end' }));
      }
      if (msg.type === 'done') { ws.close(); resolve(); }
    });
    ws.on('error', reject);
  });
  await stage.waitFor(m => m.type === 'turn' && m.conversationId === id);
  const done = await stage.waitFor(m => m.type === 'done' && m.conversationId === id);
  assert.equal(done.turns.length, 8);

  await post(`/api/conversations/${id}/user-label`, { label: 'A' });
  await stage.waitFor(m => m.type === 'conversation' && m.conversation.userLabel === 'A');

  await post(`/api/conversations/${id}/process`, { reflection: '' });
  await stage.waitFor(m => m.type === 'processing' && m.conversationId === id);
  await stage.waitFor(m => m.type === 'conversation' && m.conversation.note?.text);
  await stage.waitFor(m => m.type === 'memory');

  await post(`/api/conversations/${id}`, { tag: 'networking' }, 'PATCH');
  await stage.waitFor(m => m.type === 'conversation' && m.conversation.tag === 'networking');

  await post(`/api/conversations/${id}`, null, 'DELETE');
  await stage.waitFor(m => m.type === 'deleted' && m.conversationId === id);
  stage.ws.close();
});
