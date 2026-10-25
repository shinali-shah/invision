import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTurnAssembler } from '../src/transcribe/assemble.js';
import { openMuseStream } from '../src/transcribe/realtime.js';
import { openMockStream } from '../src/transcribe/mockStream.js';
import { transcribeWav } from '../src/transcribe/file.js';
import { DEMO_EVENTS, SEED_CONVERSATIONS } from '../src/mock/demoConversation.js';

function assembleAll(events) {
  const a = createTurnAssembler();
  for (const e of events) a.push(e);
  return a.flush();
}

test('assembler turns DEMO_EVENTS into 8 diarized turns', () => {
  const turns = assembleAll(DEMO_EVENTS);
  assert.equal(turns.length, 8);
  assert.equal(turns[0].speaker, 'A');
  assert.ok(turns.every(t => t.speaker === 'A' || t.speaker === 'B'));
  assert.ok(turns.every(t => t.endMs > t.startMs));
  assert.ok(turns.every(t => t.text.length > 0));
  assert.deepEqual(turns.map(t => t.speaker), ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
});

test('DEMO_EVENTS are time-ordered and switch to Spanish by turn 4', () => {
  for (let i = 1; i < DEMO_EVENTS.length; i++) {
    assert.ok(DEMO_EVENTS[i].audioProcessedMs >= DEMO_EVENTS[i - 1].audioProcessedMs);
  }
  const last = DEMO_EVENTS.at(-1).audioProcessedMs;
  assert.ok(last > 25000 && last < 40000);
  const turns = assembleAll(DEMO_EVENTS);
  assert.match(turns[0].text, /garden/i);
  assert.match(turns[3].text, /\b(sí|mija|teníamos)\b/i);
});

test('assembler emits partials then a closed turn', () => {
  const a = createTurnAssembler();
  assert.equal(a.push({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 }), null);
  assert.deepEqual(a.push({ type: 'transcript', transcript: 'Hi', final: false, audioProcessedMs: 300 }),
    { kind: 'partial', turnId: 1, text: 'Hi', speaker: 'unknown' });
  const p = a.push({ type: 'transcript', transcript: 'Hi there', final: false, audioProcessedMs: 600 });
  assert.equal(p.text, 'Hi there'); // cumulative: replaced, not appended
  a.push({ type: 'speaker', label: 'A', audioProcessedMs: 650 });
  a.push({ type: 'speechEnd', turnId: 1, audioProcessedMs: 800 });
  const out = a.push({ type: 'speechComplete', turnId: 1, transcript: 'Hi there!', audioProcessedMs: 900 });
  assert.deepEqual(out, { kind: 'turn', turn: { turnId: 1, speaker: 'A', text: 'Hi there!', startMs: 0, endMs: 800 } });
  assert.equal(a.turns().length, 1);
});

test('missing speaker becomes unknown and audioProgress is ignored', () => {
  const turns = assembleAll([
    { type: 'speechStart', turnId: 1, audioProcessedMs: 0 },
    { type: 'audioProgress', audioProcessedMs: 100 },
    { type: 'somethingNew', foo: 1 },
    { type: 'speechEnd', turnId: 1, audioProcessedMs: 500 },
    { type: 'speechComplete', turnId: 1, transcript: 'hola', audioProcessedMs: 600 },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].speaker, 'unknown');
});

test('flush closes an open turn with the last partial and discards empty turns', () => {
  const a = createTurnAssembler();
  a.push({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
  a.push({ type: 'speechComplete', turnId: 1, transcript: '   ', audioProcessedMs: 400 });
  a.push({ type: 'speechStart', turnId: 2, audioProcessedMs: 1000 });
  a.push({ type: 'speaker', label: 'B', audioProcessedMs: 1100 });
  a.push({ type: 'transcript', transcript: 'and then we', audioProcessedMs: 1700 });
  const turns = a.flush();
  assert.deepEqual(turns, [{ turnId: 2, speaker: 'B', text: 'and then we', startMs: 1000, endMs: 1700 }]);
  assert.deepEqual(a.flush(), turns); // idempotent
});

class FakeWs extends EventEmitter {
  static last;
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    FakeWs.last = this;
    queueMicrotask(() => this.emit('open'));
  }
  send(data) { this.sent.push(data); }
  close(code = 1000) { queueMicrotask(() => this.emit('close', code, Buffer.from(''))); }
  reply(obj) { this.emit('message', Buffer.from(JSON.stringify(obj)), false); }
}

const tick = () => new Promise(r => setImmediate(r));

test('openMuseStream sends the exact handshake and resolves on sessionId', async () => {
  const events = [];
  const p = openMuseStream({ apiKey: 'k', model: 'muse-voice-transcribe-1.0', languages: ['English', 'Spanish'], onEvent: e => events.push(e), WebSocketImpl: FakeWs });
  await tick();
  const ws = FakeWs.last;
  assert.equal(ws.url, 'wss://api.meta.ai/v1/asr/realtime');
  const hs = JSON.parse(ws.sent[0]);
  assert.deepEqual(hs, {
    authorization: { accessToken: 'Bearer k' },
    audioEncoding: 'PCM_24KHZ',
    model: 'muse-voice-transcribe-1.0',
    mode: 'DIARIZATION',
    languageBias: ['English', 'Spanish'],
    partialMode: 'CUMULATIVE',
    emitAudioProgress: false,
  });
  ws.reply({ sessionId: 's1' });
  const stream = await p;

  const buf = Buffer.alloc(3840);
  stream.sendAudio(buf);
  assert.ok(Buffer.isBuffer(ws.sent[1]));

  ws.reply({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
  assert.equal(events[0].type, 'speechStart');

  const ended = stream.end();
  assert.deepEqual(JSON.parse(ws.sent.at(-1)), { type: 'endStream' });
  ws.close(1000);
  await ended;
});

test('openMuseStream rejects on handshake error', async () => {
  const p = openMuseStream({ apiKey: 'bad', model: 'm', languages: ['English'], onEvent() {}, WebSocketImpl: FakeWs });
  await tick();
  FakeWs.last.reply({ type: 'error', message: 'unauthorized', sessionId: '' });
  await assert.rejects(p, /unauthorized/);
});

test('openMuseStream rejects when the socket closes before the handshake', async () => {
  const p = openMuseStream({ apiKey: 'k', model: 'm', languages: ['English'], onEvent() {}, WebSocketImpl: FakeWs });
  await tick();
  FakeWs.last.close(1008);
  await assert.rejects(p, /1008/);
});

test('openMockStream replays every event once audio starts', async () => {
  const seen = [];
  let closed = null;
  const stream = await openMockStream({ onEvent: e => seen.push(e), onClose: c => { closed = c; }, speed: 1000 });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(seen.length, 0); // nothing until the mic actually sends audio
  stream.sendAudio(Buffer.alloc(3840));
  await new Promise(r => setTimeout(r, 80));
  assert.equal(seen.length, DEMO_EVENTS.length);
  await stream.end();
  assert.equal(closed, 1000);
  assert.equal(seen.length, DEMO_EVENTS.length);
});

test('openMockStream end() flushes the remainder immediately', async () => {
  const seen = [];
  let closed = null;
  const stream = await openMockStream({ onEvent: e => seen.push(e), onClose: c => { closed = c; }, speed: 1 });
  stream.sendAudio(Buffer.alloc(3840));
  await stream.end();
  assert.equal(seen.length, DEMO_EVENTS.length);
  assert.equal(closed, 1000);
  assert.equal(assembleAll(seen).length, 8);
});

test('transcribeWav posts multipart to the file endpoint and maps turns', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({
      sessionId: 's', transcript: 'hi hola', audioDurationMs: 2000,
      turns: [
        { turnId: 1, startMs: 0, endMs: 900, transcript: 'hi', speaker: 'A' },
        { turnId: 2, startMs: 1000, endMs: 2000, transcript: 'hola' },
      ],
    });
  };
  const turns = await transcribeWav({ apiKey: 'k', model: 'muse-voice-transcribe-1.0', languages: ['English', 'Spanish'], wav: Buffer.alloc(64), fetchImpl });
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.meta.ai/v1/asr/transcribe');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer k');
  assert.ok(init.body instanceof FormData);
  const req = JSON.parse(init.body.get('request'));
  assert.equal(req.mode, 'DIARIZATION');
  assert.equal(req.audioEncoding, 'WAV');
  assert.deepEqual(req.languageBias, ['English', 'Spanish']);
  assert.ok(init.body.get('audio') instanceof Blob);
  assert.deepEqual(turns, [
    { turnId: 1, speaker: 'A', text: 'hi', startMs: 0, endMs: 900 },
    { turnId: 2, speaker: 'unknown', text: 'hola', startMs: 1000, endMs: 2000 },
  ]);
});

test('transcribeWav throws on HTTP error', async () => {
  const fetchImpl = async () => new Response('nope', { status: 413 });
  await assert.rejects(transcribeWav({ apiKey: 'k', model: 'm', languages: [], wav: Buffer.alloc(4), fetchImpl }), /413/);
});

test('SEED_CONVERSATIONS are two earlier calls with Abuela', () => {
  assert.equal(SEED_CONVERSATIONS.length, 2);
  const [a, b] = SEED_CONVERSATIONS;
  assert.deepEqual([a.signals.followUps, b.signals.followUps], [1, 2]);
  const daysAgo = c => Math.round((Date.now() - Date.parse(c.createdAt)) / 86400000);
  assert.deepEqual([daysAgo(a), daysAgo(b)], [6, 3]);
  for (const c of SEED_CONVERSATIONS) {
    assert.equal(c.otherName, 'Abuela');
    assert.equal(c.tag, 'family');
    assert.equal(c.userLabel, 'A');
    assert.equal(c.signals.source, 'muse-spark');
    assert.equal(c.note.status, 'shown');
    assert.ok(c.turns.length >= 4);
    assert.equal(c.signals.questions.filter(q => q.isFollowUp).length, c.signals.followUps);
    assert.equal(c.signals.userTurns, c.turns.filter(t => t.speaker === 'A').length);
  }
});

test('a speaker label that lands after speechComplete still labels that turn', () => {
  const a = createTurnAssembler();
  a.push({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
  a.push({ type: 'transcript', transcript: 'hola', final: false, audioProcessedMs: 400 });
  a.push({ type: 'speechComplete', turnId: 1, transcript: 'hola', audioProcessedMs: 600 });
  a.push({ type: 'speaker', label: 'B', audioProcessedMs: 600 });
  assert.equal(a.flush()[0].speaker, 'B');
});

test('end sent before the Muse handshake finishes keeps the buffered audio and ends the stream', async () => {
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachTranscribeSocket } = await import('../src/transcribe/wsRoute.js');

  const saved = {};
  const store = { getConversation: () => ({ id: 'c1' }), updateConversation: (id, patch) => Object.assign(saved, patch) };
  const got = [];
  let ended = false;
  const openStream = ({ onEvent, onClose }) => new Promise(res => setTimeout(() => res({
    sendAudio: buf => got.push(buf.length),
    async end() {
      ended = true;
      onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
      onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 800 });
      onClose(1000);
    },
  }), 50));

  const server = http.createServer();
  attachTranscribeSocket({ server, store, log: () => {}, config: { mock: false }, openStream });
  await new Promise(r => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${server.address().port}/ws/transcribe?conversationId=c1`);
  const done = await new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(Buffer.alloc(3840));
      ws.send(Buffer.alloc(3840));
      ws.send(JSON.stringify({ type: 'end' }));
    });
    ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.type === 'done') resolve(m); });
    ws.on('error', reject);
  });
  server.close();

  assert.deepEqual(got, [3840, 3840]);
  assert.equal(ended, true);
  assert.equal(done.turns.length, 1);
  assert.equal(saved.turns.length, 1);
});

test('a conversation deleted while its stream is open is not written back or announced', async () => {
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachTranscribeSocket } = await import('../src/transcribe/wsRoute.js');

  let exists = true;
  const updates = [];
  const store = { getConversation: () => (exists ? { id: 'c1' } : undefined), updateConversation: (id, patch) => updates.push(patch) };
  const published = [];
  let streamEnd;
  const openStream = ({ onEvent, onClose }) => Promise.resolve({
    sendAudio() {},
    async end() {
      onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
      onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 800 });
      onClose(1000);
    },
  });

  const server = http.createServer();
  attachTranscribeSocket({ server, store, log: () => {}, config: { mock: false }, openStream, stage: { publish: m => published.push(m) } });
  await new Promise(r => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${server.address().port}/ws/transcribe?conversationId=c1`);
  await new Promise((resolve, reject) => {
    ws.on('message', raw => { if (JSON.parse(raw.toString()).type === 'ready') resolve(); });
    ws.on('error', reject);
  });
  // the phone abandons: it deletes the conversation and drops the socket without an "end"
  exists = false;
  ws.close();
  await new Promise(r => setTimeout(r, 50));
  server.close();

  assert.deepEqual(updates, []);
  // the one thing the stage hears is that the conversation is gone, so it forgets any live lines
  assert.deepEqual(published, [{ type: 'deleted', conversationId: 'c1' }]);
});

// ---- lip lock: cue frames over the same socket ----

// A fake Muse that answers "end" with a scripted exchange: you, them, a bystander, you, them.
function scriptedStream(turnsSpec) {
  return ({ onEvent, onClose }) => Promise.resolve({
    sendAudio() {},
    async end() {
      for (const [turnId, speaker, startMs, endMs] of turnsSpec) {
        onEvent({ type: 'speechStart', turnId, audioProcessedMs: startMs });
        onEvent({ type: 'speaker', label: speaker, audioProcessedMs: startMs + 100 });
        onEvent({ type: 'speechEnd', turnId, audioProcessedMs: endMs });
        onEvent({ type: 'speechComplete', turnId, transcript: `line ${turnId}`, audioProcessedMs: endMs });
      }
      onClose(1000);
    },
  });
}

const cueRun = (from, to, flags) => Array.from({ length: Math.ceil((to - from) / 125) }, (_, i) => ({ t: from + i * 125, face: true, mouth: 0, theirs: false, mine: false, ...flags }));

async function runWithCues({ cueBatches, turnsSpec, recordingsDir }) {
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachTranscribeSocket } = await import('../src/transcribe/wsRoute.js');
  const saved = {};
  const store = { getConversation: () => ({ id: 'c1', ...saved }), updateConversation: (id, patch) => { Object.assign(saved, patch); return { id, ...saved }; } };
  const published = [];
  const server = http.createServer();
  attachTranscribeSocket({ server, store, log: () => {}, config: { mock: false }, openStream: scriptedStream(turnsSpec), stage: { publish: m => published.push(m) }, recordingsDir });
  await new Promise(r => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${server.address().port}/ws/transcribe?conversationId=c1`);
  const done = await new Promise((resolve, reject) => {
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'ready') {
        ws.send(Buffer.alloc(3840));
        for (const samples of cueBatches) ws.send(JSON.stringify({ type: 'cues', samples }));
        ws.send(JSON.stringify({ type: 'end' }));
      }
      if (m.type === 'done') resolve(m);
    });
    ws.on('error', reject);
  });
  server.close();
  return { done, saved, published };
}

test('cue frames label the turns, pick your voice and drop the bystander from the count', async () => {
  const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const recordingsDir = join(mkdtempSync(join(tmpdir(), 'playback-cues-')), 'rec');

  const turnsSpec = [[1, 'A', 0, 2000], [2, 'B', 2200, 5000], [3, 'C', 5300, 6500], [4, 'A', 7000, 9000], [5, 'B', 9200, 12000]];
  const cueBatches = [
    cueRun(0, 2100, { mine: true }),
    cueRun(2100, 5200, { theirs: true }),
    cueRun(5200, 6900, {}),
    cueRun(6900, 9100, { mine: true }),
    cueRun(9100, 12100, { theirs: true }),
  ];
  const { done, saved, published } = await runWithCues({ cueBatches, turnsSpec, recordingsDir });

  assert.deepEqual(done.turns.map(t => t.source), ['you', 'them', 'crowd', 'you', 'them']);
  assert.equal(done.userLabel, 'A');
  assert.equal(done.crowdTurns, 1);
  assert.equal(saved.userLabel, 'A');
  assert.deepEqual(saved.turns.map(t => t.source), done.turns.map(t => t.source));
  // cues live next to the video, not on the conversation object
  assert.equal(saved.cues, undefined);
  const file = join(recordingsDir, 'c1.cues.json');
  assert.ok(existsSync(file), 'cues file written');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, cueBatches.flat().length);
  const stageDone = published.find(m => m.type === 'done');
  assert.equal(stageDone.userLabel, 'A');
  assert.equal(stageDone.turns[2].source, 'crowd');
  assert.equal(done.labelSource, 'camera');
  // the saved record goes out as a conversation update too, turns and all, ahead of done
  const stageConvo = published.filter(m => m.type === 'conversation').at(-1);
  assert.equal(stageConvo?.conversation.turns?.length, 5);
  assert.equal(stageConvo.conversation.userLabel, 'A');
  assert.ok(published.indexOf(stageConvo) < published.indexOf(stageDone));
});

test('without cues the done message is as before: no label picked, nothing written', async () => {
  const { done, saved } = await runWithCues({ cueBatches: [], turnsSpec: [[1, 'A', 0, 2000], [2, 'B', 2200, 5000]] });
  assert.equal(done.userLabel, null);
  assert.equal(done.labelSource, null);
  assert.equal(done.crowdTurns, 0);
  assert.ok(done.turns.every(t => t.source === 'unknown'));
  assert.equal(saved.userLabel, undefined);
});

test('malformed cue frames are ignored rather than crashing the stream', async () => {
  const { done } = await runWithCues({
    cueBatches: [[{ t: 'nope' }, null, 42, { t: 100, face: true, theirs: true, mine: false }], 'not-an-array'],
    turnsSpec: [[1, 'A', 0, 2000]],
  });
  assert.equal(done.turns.length, 1);
});

// ---- names picked up from the transcript ----

// A fake Muse that answers "end" with scripted lines: [turnId, speaker, text].
function talkingStream(lines) {
  return ({ onEvent, onClose }) => Promise.resolve({
    sendAudio() {},
    async end() {
      lines.forEach(([turnId, speaker, text], i) => {
        const startMs = i * 3000;
        onEvent({ type: 'speechStart', turnId, audioProcessedMs: startMs });
        onEvent({ type: 'speaker', label: speaker, audioProcessedMs: startMs + 100 });
        onEvent({ type: 'speechEnd', turnId, audioProcessedMs: startMs + 2000 });
        onEvent({ type: 'speechComplete', turnId, transcript: text, audioProcessedMs: startMs + 2000 });
      });
      onClose(1000);
    },
  });
}

async function runTalk({ lines, convo = {}, config = { mock: false, userName: 'Parth' } }) {
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachTranscribeSocket } = await import('../src/transcribe/wsRoute.js');
  const saved = { ...convo };
  const store = { getConversation: () => ({ id: 'c1', ...saved }), updateConversation: (id, patch) => { Object.assign(saved, patch); return { id, ...saved }; } };
  const published = [];
  const server = http.createServer();
  attachTranscribeSocket({ server, store, log: () => {}, config, openStream: talkingStream(lines), stage: { publish: m => published.push(m) } });
  await new Promise(r => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${server.address().port}/ws/transcribe?conversationId=c1`);
  const seen = [];
  const done = await new Promise((resolve, reject) => {
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      seen.push(m);
      if (m.type === 'ready') { ws.send(Buffer.alloc(3840)); ws.send(JSON.stringify({ type: 'end' })); }
      if (m.type === 'done') resolve(m);
    });
    ws.on('error', reject);
  });
  server.close();
  return { done, saved, published, seen };
}

test('an introduction in the stream names the conversation and tells the phone and the stage', async () => {
  const { done, saved, published, seen } = await runTalk({ lines: [[1, 'A', 'Hey, come on in.'], [2, 'B', "Thanks! I'm Priya, by the way."], [3, 'A', 'Great to meet you.']] });
  assert.equal(saved.otherName, 'Priya');
  const person = seen.find(m => m.type === 'person');
  assert.deepEqual(person, { type: 'person', name: 'Priya', turnId: 2, confidence: 0.9 });
  assert.ok(seen.indexOf(person) < seen.indexOf(done), 'the name lands before done');
  assert.equal(seen.filter(m => m.type === 'person').length, 1, 'said once');
  const stageConvo = published.find(m => m.type === 'conversation');
  assert.equal(stageConvo?.conversation.otherName, 'Priya');
  assert.equal(done.otherName, 'Priya');
  assert.equal(done.userLabel, null);
});

test('a name the user typed is never overwritten by what the transcript says', async () => {
  const { saved, seen } = await runTalk({ lines: [[1, 'B', "Hi, I'm Priya."]], convo: { otherName: 'Sam' } });
  assert.equal(saved.otherName, 'Sam');
  assert.equal(seen.some(m => m.type === 'person'), false);
});

test('the first clean name sticks; a later different one neither replaces it nor pings the phone again', async () => {
  const { saved, seen } = await runTalk({ lines: [[1, 'A', 'Hi Sam!'], [2, 'A', 'Thanks, Maria.']] });
  assert.equal(saved.otherName, 'Sam');
  assert.deepEqual(seen.filter(m => m.type === 'person').map(m => m.name), ['Sam']);
});

test('a name that only ever shows up alongside a rival is not trusted', async () => {
  const { saved, seen } = await runTalk({ lines: [[1, 'A', 'Hi Sam, thanks Maria.']] });
  assert.equal(saved.otherName, undefined);
  assert.equal(seen.some(m => m.type === 'person'), false);
});

test("the user's own introduction picks their voice when nothing else has", async () => {
  const { done, saved } = await runTalk({ lines: [[1, 'A', "Hi, I'm Parth."], [2, 'B', "Hello Parth, I'm Priya."]] });
  assert.equal(saved.userLabel, 'A');
  assert.equal(done.userLabel, 'A');
  assert.equal(done.labelSource, 'name');
  assert.equal(saved.otherName, 'Priya');
  // a label already on the conversation stays, and done does not claim to have found it
  const kept = await runTalk({ lines: [[1, 'A', "Hi, I'm Parth."]], convo: { userLabel: 'B' } });
  assert.equal(kept.saved.userLabel, 'B');
  assert.equal(kept.done.userLabel, 'B');
  assert.equal(kept.done.labelSource, null);
});

// ---- Muse hanging up mid-recording: reconnect where the audio left off ----

// Each call hands back a scripted Muse session; `sessions[i]` is what the i-th one does.
function sessionsStream(scripts, calls) {
  return opts => {
    const i = calls.length;
    calls.push(opts);
    const script = scripts[i];
    if (!script) return Promise.reject(new Error('no muse today'));
    return Promise.resolve({
      sent: 0,
      sendAudio(buf) { this.sent += buf.length; script.onAudio?.(this, opts); },
      async end() { script.onEnd?.(this, opts); },
    });
  };
}

// Reopens are immediate here unless a test says otherwise; the backoff has its own test below.
async function bridge({ openStream, store, published = [], reconnectBackoffMs = 0, log = () => {} }) {
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachTranscribeSocket } = await import('../src/transcribe/wsRoute.js');
  const server = http.createServer();
  attachTranscribeSocket({ server, store, log, config: { mock: false }, openStream, stage: { publish: m => published.push(m) }, reconnectBackoffMs });
  await new Promise(r => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${server.address().port}/ws/transcribe?conversationId=c1`);
  const got = [];
  ws.on('message', raw => got.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return { ws, got, server, until: type => new Promise(res => { const tick = () => got.some(m => m.type === type) ? res(got.find(m => m.type === type)) : setTimeout(tick, 5); tick(); }) };
}

test('a 1008 mid-recording opens a new Muse session and the turns keep one timeline', async () => {
  const saved = {};
  const store = { getConversation: () => ({ id: 'c1', ...saved }), updateConversation: (id, patch) => { Object.assign(saved, patch); return { id, ...saved }; } };
  const calls = [];
  const openStream = sessionsStream([
    { // first session: one turn, then Muse falls behind and hangs up after 4 frames of audio
      onAudio(s, { onEvent, onClose }) {
        if (s.sent !== 4 * 3840) return;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speaker', label: 'A', audioProcessedMs: 50 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 300 });
        onClose(1008, 'Audio processing backlog too large');
      },
    },
    { // second session: its clock and turn ids start over
      onEnd(s, { onEvent, onClose }) {
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speaker', label: 'B', audioProcessedMs: 50 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'how is the garden', audioProcessedMs: 500 });
        onClose(1000);
      },
    },
  ], calls);
  const { ws, got, server, until } = await bridge({ openStream, store });
  await until('ready');
  for (let i = 0; i < 4; i++) ws.send(Buffer.alloc(3840)); // 4 x 80 ms
  await until('turn');
  // give the reconnect a moment, then keep talking into the new session
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 2, 'a second Muse session was opened');
  for (let i = 0; i < 2; i++) ws.send(Buffer.alloc(3840));
  ws.send(JSON.stringify({ type: 'end' }));
  const done = await until('done');
  server.close();

  assert.equal(got.filter(m => m.type === 'error').length, 0, 'the phone never saw an error');
  assert.deepEqual(done.turns.map(t => t.turnId), [1, 2]);
  assert.deepEqual(done.turns.map(t => t.speaker), ['A', 'B']); // no camera: the new session's letters are taken as they came
  assert.equal(done.turns[1].startMs, 320); // 4 frames x 80 ms went to the first session before it died
  assert.equal(done.turns[1].endMs, 820);
  assert.equal(saved.turns.length, 2);
});

test('when Muse cannot be reopened the phone is told once and keeps what was heard', async () => {
  const saved = {};
  const store = { getConversation: () => ({ id: 'c1', ...saved }), updateConversation: (id, patch) => { Object.assign(saved, patch); return { id, ...saved }; } };
  const calls = [];
  const openStream = sessionsStream([
    {
      onAudio(s, { onEvent, onClose }) {
        if (s.sent !== 3840) return;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 300 });
        onClose(1011);
      },
    },
    // no second script: the reopen is refused
  ], calls);
  const { ws, got, server, until } = await bridge({ openStream, store });
  await until('ready');
  ws.send(Buffer.alloc(3840));
  const done = await until('done');
  server.close();

  assert.equal(calls.length, 2);
  const errors = got.filter(m => m.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /could not get it back/);
  assert.equal(done.turns.length, 1);
  assert.equal(done.turns[0].text, 'hi grandma');
});

const memStore = saved => ({ getConversation: () => ({ id: 'c1', ...saved }), updateConversation: (id, patch) => { Object.assign(saved, patch); return { id, ...saved }; } });

test('a 1008 in the middle of a turn keeps the half-heard line and the next session carries on the timeline', async () => {
  const saved = {};
  const calls = [];
  const openStream = sessionsStream([
    { // Muse dies after two frames, with a turn open and a partial out
      onAudio(s, { onEvent, onClose }) {
        if (s.sent !== 2 * 3840) return;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speaker', label: 'A', audioProcessedMs: 50 });
        onEvent({ type: 'transcript', transcript: 'hi gra', audioProcessedMs: 150 });
        onClose(1008, 'Audio processing backlog too large');
      },
    },
    {
      onEnd(s, { onEvent, onClose }) {
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speaker', label: 'B', audioProcessedMs: 50 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'how is the garden', audioProcessedMs: 500 });
        onClose(1000);
      },
    },
  ], calls);
  const { ws, got, server, until } = await bridge({ openStream, store: memStore(saved) });
  await until('ready');
  ws.send(Buffer.alloc(3840));
  ws.send(Buffer.alloc(3840));
  await until('partial');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 2);
  ws.send(Buffer.alloc(3840));
  ws.send(Buffer.alloc(3840));
  ws.send(JSON.stringify({ type: 'end' }));
  const done = await until('done');
  server.close();

  assert.equal(got.filter(m => m.type === 'error').length, 0, 'a reconnect that works is not an error');
  assert.deepEqual(done.turns.map(t => [t.turnId, t.speaker, t.text, t.startMs, t.endMs]), [
    [1, 'A', 'hi gra', 0, 160], // no speechComplete ever came: it runs up to where the next session's first turn starts
    [2, 'B', 'how is the garden', 160, 660],
  ]);
  assert.deepEqual(saved.turns.map(t => t.turnId), [1, 2]);
});

test('a turn the assembler had to number itself is not reused by the next session', async () => {
  const saved = {};
  const calls = [];
  const openStream = sessionsStream([
    { // a transcript with no speechStart ahead of it, then the hang-up
      onAudio(s, { onEvent, onClose }) {
        if (s.sent !== 3840) return;
        onEvent({ type: 'transcript', transcript: 'hi grandma', audioProcessedMs: 100 });
        onClose(1008);
      },
    },
    {
      onEnd(s, { onEvent, onClose }) {
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'how is it', audioProcessedMs: 300 });
        onClose(1000);
      },
    },
  ], calls);
  const { ws, server, until } = await bridge({ openStream, store: memStore(saved) });
  await until('ready');
  ws.send(Buffer.alloc(3840));
  await until('partial');
  await new Promise(r => setTimeout(r, 20));
  ws.send(JSON.stringify({ type: 'end' }));
  const done = await until('done');
  server.close();
  assert.deepEqual(done.turns.map(t => [t.turnId, t.text]), [[1, 'hi grandma'], [2, 'how is it']]);
});

// A Muse that hangs up on the first frame, then a second session the test lets in when it likes.
function deferredSecondSession({ onEnd }) {
  const calls = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const openStream = opts => {
    calls.push(opts);
    if (calls.length === 1) {
      return Promise.resolve({
        sent: 0,
        sendAudio(buf) {
          this.sent += buf.length;
          if (this.sent !== 3840) return;
          opts.onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
          opts.onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 50 });
          opts.onClose(1008);
        },
        async end() {},
      });
    }
    return gate.then(() => ({
      sent: 0,
      sendAudio(buf) { this.sent += buf.length; },
      async end() { onEnd(this, opts); },
    }));
  };
  return { openStream, calls, release: () => release(), second: () => calls[1] };
}

test('audio shed while the new session is still connecting moves its clock, not the transcript', async () => {
  const saved = {};
  const { openStream, calls, release } = deferredSecondSession({
    onEnd(s, { onEvent, onClose }) {
      onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
      onEvent({ type: 'speechComplete', turnId: 1, transcript: 'back again', audioProcessedMs: 100 });
      onClose(1000);
    },
  });
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachTranscribeSocket } = await import('../src/transcribe/wsRoute.js');
  const server = http.createServer();
  // a one-second queue limit and a bucket big enough that nothing is ever throttled
  attachTranscribeSocket({ server, store: memStore(saved), log: () => {}, config: { mock: false }, openStream, pace: { maxQueueMs: 1000, leadMs: 60000 }, reconnectBackoffMs: 0 });
  await new Promise(r => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${server.address().port}/ws/transcribe?conversationId=c1`);
  const got = [];
  ws.on('message', raw => got.push(JSON.parse(raw.toString())));
  const until = type => new Promise(res => { const tick = () => got.some(m => m.type === type) ? res(got.find(m => m.type === type)) : setTimeout(tick, 5); tick(); });
  await until('ready');
  ws.send(Buffer.alloc(3840)); // 80 ms into session 1, which hangs up on it
  await until('turn');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 2, 'the reconnect is in flight');
  for (let i = 0; i < 20; i++) ws.send(Buffer.alloc(3840)); // 1.6 s with nowhere to go: the oldest 640 ms is shed
  await new Promise(r => setTimeout(r, 60));
  release();
  await new Promise(r => setTimeout(r, 20));
  ws.send(JSON.stringify({ type: 'end' }));
  const done = await until('done');
  server.close();

  assert.equal(calls[1] && saved.turns.length, 2);
  assert.equal(done.turns[1].startMs, 80 + 640, 'session 2 starts where its first byte sits on the phone clock');
  assert.equal(done.turns[1].endMs, 80 + 640 + 100);
});

test('"end" sent while the reconnect is still in flight waits for the new session and drains into it', async () => {
  const saved = {};
  const { openStream, calls, release, second } = deferredSecondSession({
    onEnd(s, { onEvent, onClose }) {
      onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
      onEvent({ type: 'speechComplete', turnId: 1, transcript: 'and then', audioProcessedMs: 100 });
      onClose(1000);
    },
  });
  let s2;
  const spy = opts => openStream(opts).then(s => { if (calls.length === 2) s2 = s; return s; });
  const { ws, got, server, until } = await bridge({ openStream: spy, store: memStore(saved) });
  await until('ready');
  ws.send(Buffer.alloc(3840));
  await until('turn');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 2);
  ws.send(Buffer.alloc(3840));
  ws.send(Buffer.alloc(3840));
  ws.send(JSON.stringify({ type: 'end' }));
  await new Promise(r => setTimeout(r, 40));
  assert.equal(got.some(m => m.type === 'done'), false, 'done waits for the session we are opening');
  release();
  const done = await until('done');
  server.close();

  assert.ok(second());
  assert.equal(s2.sent, 2 * 3840, 'the frames that arrived mid-reconnect reached the new session before end');
  assert.equal(got.filter(m => m.type === 'error').length, 0);
  assert.deepEqual(done.turns.map(t => t.text), ['hi grandma', 'and then']);
  assert.equal(done.turns[1].startMs, 80);
});

test('the phone vanishing mid-reconnect still ends the new session and saves the turns', async () => {
  const saved = {};
  const published = [];
  let ended = 0;
  const { openStream, calls, release } = deferredSecondSession({
    onEnd(s, { onClose }) { ended++; onClose(1000); },
  });
  const { ws, server } = await bridge({ openStream, store: memStore(saved), published });
  await new Promise(r => setTimeout(r, 20));
  ws.send(Buffer.alloc(3840));
  await new Promise(r => setTimeout(r, 40));
  assert.equal(calls.length, 2);
  ws.close(); // no "end": the user navigated away
  await new Promise(r => setTimeout(r, 20));
  release();
  await new Promise(r => setTimeout(r, 40));
  server.close();

  assert.equal(ended, 1, 'the session opened after the phone left is closed, not leaked');
  assert.deepEqual(saved.turns?.map(t => t.text), ['hi grandma']);
  assert.equal(published.filter(m => m.type === 'done').length, 1);
});

test('Muse closing with 1000 on its own, while the phone is still recording, is a reconnect not an ending', async () => {
  const saved = {};
  const calls = [];
  const openStream = sessionsStream([
    { // a clean close we never asked for (a session cap, say)
      onAudio(s, { onEvent, onClose }) {
        if (s.sent !== 3840) return;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 50 });
        onClose(1000);
      },
    },
    {
      onEnd(s, { onEvent, onClose }) {
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'still here', audioProcessedMs: 200 });
        onClose(1000);
      },
    },
  ], calls);
  const { ws, got, server, until } = await bridge({ openStream, store: memStore(saved) });
  await until('ready');
  ws.send(Buffer.alloc(3840));
  await until('turn');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(calls.length, 2, 'a second session was opened');
  assert.equal(got.some(m => m.type === 'done'), false, 'the recording is not over until the phone says so');
  ws.send(Buffer.alloc(3840));
  ws.send(JSON.stringify({ type: 'end' }));
  const done = await until('done');
  server.close();
  assert.equal(got.filter(m => m.type === 'error').length, 0);
  assert.deepEqual(done.turns.map(t => [t.turnId, t.text, t.startMs]), [[1, 'hi grandma', 0], [2, 'still here', 80]]);
});

test('a reopen waits a beat longer each time, and audio sent during the wait reaches the new session', async () => {
  const saved = {};
  const calls = [];
  const opened = [];
  const streams = [];
  const openStream = sessionsStream([
    { // dies on the first frame
      onAudio(s, { onEvent, onClose }) {
        if (s.sent !== 3840) return;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 50 });
        onClose(1008);
      },
    },
    { onAudio(s) { if (s.sent === 3840) onClose2(1008); } }, // and so does the second
    { onEnd(s, { onClose }) { onClose(1000); } },
  ], calls);
  let onClose2;
  const spy = opts => {
    opened.push(Date.now());
    if (calls.length === 1) onClose2 = opts.onClose;
    return openStream(opts).then(s => { streams.push(s); return s; });
  };
  const { ws, got, server, until } = await bridge({ openStream: spy, store: memStore(saved), reconnectBackoffMs: 60 });
  await until('ready');
  ws.send(Buffer.alloc(3840));
  await until('turn');
  // nothing reopened yet: the first reopen waits one beat
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 1, 'no reopen in the first 20 ms');
  ws.send(Buffer.alloc(3840)); // spoken during the wait: must not be lost
  ws.send(Buffer.alloc(3840));
  await new Promise(r => setTimeout(r, 70));
  assert.equal(calls.length, 2, 'the second session opened after the beat');
  assert.ok(opened[1] - opened[0] >= 55, `waited ${opened[1] - opened[0]}ms before the first reopen`);
  // the second session died on its first frame; the third waits two beats
  await new Promise(r => setTimeout(r, 70));
  assert.equal(calls.length, 2, 'two beats have not passed');
  await new Promise(r => setTimeout(r, 90));
  assert.equal(calls.length, 3, 'the third session opened after two beats');
  assert.ok(opened[2] - opened[1] >= 110, `waited ${opened[2] - opened[1]}ms before the second reopen`);
  ws.send(JSON.stringify({ type: 'end' }));
  const done = await until('done');
  server.close();

  assert.equal(got.filter(m => m.type === 'error').length, 0);
  assert.equal(streams[1].sent + streams[2].sent, 2 * 3840, 'both frames from the wait went to a later session');
  assert.deepEqual(done.turns.map(t => t.text), ['hi grandma']);
});

test('the phone leaving during a reopen wait ends the recording without opening another session', async () => {
  const saved = {};
  const published = [];
  const calls = [];
  const openStream = sessionsStream([
    {
      onAudio(s, { onEvent, onClose }) {
        if (s.sent !== 3840) return;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 50 });
        onClose(1008);
      },
    },
    { onEnd(s, { onClose }) { onClose(1000); } },
  ], calls);
  const { ws, server, until } = await bridge({ openStream, store: memStore(saved), published, reconnectBackoffMs: 80 });
  await until('ready');
  ws.send(Buffer.alloc(3840));
  await until('turn');
  await new Promise(r => setTimeout(r, 20));
  ws.close(); // mid-wait, no "end"
  await new Promise(r => setTimeout(r, 120));
  server.close();

  assert.equal(calls.length, 1, 'nothing was reopened for a phone that had gone');
  assert.deepEqual(saved.turns?.map(t => t.text), ['hi grandma']);
  assert.equal(published.filter(m => m.type === 'done').length, 1);
});

test('"end" during a reopen wait still gets a session to drain into and then finishes', async () => {
  const saved = {};
  const calls = [];
  let s2;
  const openStream = sessionsStream([
    {
      onAudio(s, { onEvent, onClose }) {
        if (s.sent !== 3840) return;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 50 });
        onClose(1008);
      },
    },
    {
      onEnd(s, { onEvent, onClose }) {
        s2 = s;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'bye', audioProcessedMs: 100 });
        onClose(1000);
      },
    },
  ], calls);
  const { ws, got, server, until } = await bridge({ openStream, store: memStore(saved), reconnectBackoffMs: 60 });
  await until('ready');
  ws.send(Buffer.alloc(3840));
  await until('turn');
  ws.send(Buffer.alloc(3840));
  ws.send(JSON.stringify({ type: 'end' }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(got.some(m => m.type === 'done'), false, 'done waits for the reopen');
  const done = await until('done');
  server.close();

  assert.equal(calls.length, 2);
  assert.equal(s2.sent, 3840, 'the frame from the wait reached the new session before end');
  assert.deepEqual(done.turns.map(t => [t.text, t.startMs]), [['hi grandma', 0], ['bye', 80]]);
});

test('a line Muse flushes after done is not announced as a live turn', async () => {
  const saved = {};
  const published = [];
  let late;
  const openStream = ({ onEvent, onClose }) => Promise.resolve({
    sendAudio() {},
    async end() {
      onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
      onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 300 });
      onClose(1000);
      // Muse's close frame and a last transcript can cross on the wire
      late = () => {
        onEvent({ type: 'speechStart', turnId: 2, audioProcessedMs: 400 });
        onEvent({ type: 'speechComplete', turnId: 2, transcript: 'one more thing', audioProcessedMs: 900 });
      };
    },
  });
  const { ws, server, until } = await bridge({ openStream, store: memStore(saved), published });
  await until('ready');
  ws.send(Buffer.alloc(3840));
  ws.send(JSON.stringify({ type: 'end' }));
  await until('done');
  late();
  await new Promise(r => setTimeout(r, 20));
  server.close();

  const types = published.map(m => m.type);
  assert.equal(types.lastIndexOf('turn') < types.indexOf('done'), true, `a turn was published after done: ${types.join(',')}`);
  assert.deepEqual(saved.turns.map(t => t.text), ['hi grandma']);
});

// ---- "end" right behind a burst: everything queued still reaches Muse ----

test('"end" after a 20 s burst waits for the whole queue to reach the session before ending it', async () => {
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachTranscribeSocket } = await import('../src/transcribe/wsRoute.js');
  // the pacer's clock is hand-cranked, so the drain only moves when the test says so
  let t = 0;
  const timers = [];
  const clock = {
    now: () => t,
    schedule: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    cancel: h => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    tick(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers[0] || timers[0].at > end) break;
        const next = timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
  const saved = {};
  const logged = [];
  let sentAtEnd = null;
  const openStream = ({ onEvent, onClose }) => Promise.resolve({
    sent: 0,
    sendAudio(buf) { this.sent += buf.length; },
    async end() {
      sentAtEnd = this.sent;
      onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
      onEvent({ type: 'speechComplete', turnId: 1, transcript: 'all of it', audioProcessedMs: 20000 });
      onClose(1000);
    },
  });
  const server = http.createServer();
  attachTranscribeSocket({ server, store: memStore(saved), log: (...a) => logged.push(a), config: { mock: false }, openStream, pace: { ...clock, leadMs: 1500, catchUp: 1.5 } });
  await new Promise(r => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${server.address().port}/ws/transcribe?conversationId=c1`);
  const got = [];
  ws.on('message', raw => got.push(JSON.parse(raw.toString())));
  const until = (pred, what) => new Promise((res, rej) => {
    const giveUp = setTimeout(() => rej(new Error(`${what} never happened`)), 5000);
    const tick = () => { if (pred()) { clearTimeout(giveUp); res(); } else setTimeout(tick, 5); };
    tick();
  });
  try {
    await until(() => got.some(m => m.type === 'ready'), 'ready');
    // a stalled tunnel lets go: 20 s of audio lands in one burst, "end" right behind it
    const FRAMES = 250;
    for (let i = 0; i < FRAMES; i++) ws.send(Buffer.alloc(3840));
    ws.send(JSON.stringify({ type: 'end' }));
    await until(() => logged.some(([, , msg]) => /still queued, draining/.test(msg)), 'the drain notice');
    assert.match(logged.find(([, , msg]) => /still queued/.test(msg))[2], /18\.\ds of audio/); // 20 s minus the 1.5 s lead
    // the queue needs 20 s / 1.5 = 13.3 s; a fixed 5 s wait would have ended the session here
    clock.tick(14000);
    await until(() => got.some(m => m.type === 'done'), 'done');
    assert.equal(sentAtEnd, FRAMES * 3840, 'every byte reached the session before it was asked to end');
    assert.deepEqual(saved.turns.map(x => x.text), ['all of it']);
  } finally {
    ws.terminate();
    server.close();
  }
});

// ---- a second phone on a conversation that is still being recorded ----

test('a new stream on a conversation still recording takes over: the old one keeps what it had, the new one continues after it', async () => {
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachTranscribeSocket } = await import('../src/transcribe/wsRoute.js');
  const saved = {};
  const published = [];
  const calls = [];
  let ended = 0;
  const openStream = sessionsStream([
    { // the first phone: two lines heard, then its tunnel dies; Muse takes a while to confirm the end
      onAudio(s, { onEvent }) {
        if (s.sent !== 3840) return;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speaker', label: 'A', audioProcessedMs: 50 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi abuela', audioProcessedMs: 900 });
        onEvent({ type: 'speechStart', turnId: 2, audioProcessedMs: 1200 });
        onEvent({ type: 'speaker', label: 'B', audioProcessedMs: 1250 });
        onEvent({ type: 'speechComplete', turnId: 2, transcript: 'hola mija', audioProcessedMs: 2000 });
      },
      onEnd(s, { onClose }) { ended++; setTimeout(() => onClose(1000), 60); },
    },
    { // the resumed phone: Muse's clock, ids and letters start over
      onAudio(s, { onEvent }) {
        if (s.sent !== 3840) return;
        onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
        onEvent({ type: 'speaker', label: 'A', audioProcessedMs: 50 });
        onEvent({ type: 'speechComplete', turnId: 1, transcript: 'sorry, the phone died', audioProcessedMs: 1500 });
      },
      onEnd(s, { onClose }) { ended++; onClose(1000); },
    },
  ], calls);
  const server = http.createServer();
  attachTranscribeSocket({ server, store: memStore(saved), log: () => {}, config: { mock: false }, openStream, stage: { publish: m => published.push(m) } });
  await new Promise(r => server.listen(0, r));
  const url = `ws://localhost:${server.address().port}/ws/transcribe?conversationId=c1`;
  const phone = () => {
    const ws = new WebSocket(url);
    const got = [];
    ws.on('message', raw => got.push(JSON.parse(raw.toString())));
    const until = type => new Promise(res => { const tick = () => got.some(m => m.type === type) ? res(got.find(m => m.type === type)) : setTimeout(tick, 5); tick(); });
    return { ws, got, until };
  };

  const first = phone();
  const second = phone;
  let resumed;
  try {
    await first.until('ready');
    first.ws.send(Buffer.alloc(3840));
    await first.until('turn');
    first.ws.terminate(); // no close frame, no "end"
    await new Promise(r => setTimeout(r, 10));

    resumed = second();
    await resumed.until('ready');
    assert.deepEqual(saved.turns.map(t => t.text), ['hi abuela', 'hola mija'], 'the first stream was finished with what it had before the second got going');
    assert.ok(ended >= 1, 'the first Muse session was asked to end');
    resumed.ws.send(Buffer.alloc(3840));
    resumed.ws.send(JSON.stringify({ type: 'end' }));
    const done = await resumed.until('done');
    await new Promise(r => setTimeout(r, 100)); // the first session's late close must change nothing

    assert.deepEqual(done.turns.map(t => [t.turnId, t.speaker, t.text, t.startMs, t.endMs]), [
      [1, 'A', 'hi abuela', 0, 900],
      [2, 'B', 'hola mija', 1200, 2000],
      [3, 'A', 'sorry, the phone died', 2000, 3500], // ids and clock carry on; the fresh letter settles onto the first session's
    ]);
    assert.deepEqual(saved.turns, done.turns, 'the record is what the resumed phone was shown');
    const dones = published.filter(m => m.type === 'done');
    assert.deepEqual(dones.map(m => !!m.continued), [true, false], 'the stage heard both streams finish, the first marked as handed over');
  } finally {
    first.ws.terminate();
    resumed?.ws.terminate();
    server.close();
  }
});

// A hand-rolled client that completes the upgrade and then sends one frame with RSV1 set,
// which the ws receiver rejects: that surfaces as 'error' on the server-side socket.
async function sendBadFrame(port, path) {
  const net = await import('node:net');
  const { randomBytes } = await import('node:crypto');
  await new Promise(resolve => {
    const sock = net.connect(port, 'localhost', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let upgraded = false;
    sock.on('data', d => {
      if (upgraded || !d.toString().startsWith('HTTP/1.1 101')) return;
      upgraded = true;
      sock.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0])); // FIN + RSV1, text, masked, empty
    });
    sock.on('error', () => resolve());
    sock.on('close', () => resolve());
    setTimeout(() => { sock.destroy(); resolve(); }, 500);
  });
}

test('a malformed frame from the phone is logged, the socket closes like any other, and the server stays up', async () => {
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachTranscribeSocket } = await import('../src/transcribe/wsRoute.js');
  const saved = {};
  const logged = [];
  let ended = 0;
  const openStream = ({ onEvent, onClose }) => Promise.resolve({
    sendAudio() {},
    async end() {
      ended++;
      onEvent({ type: 'speechStart', turnId: 1, audioProcessedMs: 0 });
      onEvent({ type: 'speechComplete', turnId: 1, transcript: 'hi grandma', audioProcessedMs: 300 });
      onClose(1000);
    },
  });
  const server = http.createServer();
  attachTranscribeSocket({ server, store: memStore(saved), log: (...a) => logged.push(a), config: { mock: false }, openStream });
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  await sendBadFrame(port, '/ws/transcribe?conversationId=c1');
  await new Promise(r => setTimeout(r, 50));

  assert.ok(logged.some(([, level, msg]) => level === 'warn' && /phone socket/.test(msg)), JSON.stringify(logged));
  assert.equal(ended, 1, 'the Muse side was ended when the phone socket died');
  assert.deepEqual(saved.turns?.map(t => t.text), ['hi grandma']);
  // and the next phone can still connect
  const ws = new WebSocket(`ws://localhost:${port}/ws/transcribe?conversationId=c1`);
  const ready = await new Promise((resolve, reject) => {
    ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.type === 'ready') resolve(m); });
    ws.on('error', reject);
  });
  assert.equal(ready.type, 'ready');
  ws.close();
  server.close();
});
