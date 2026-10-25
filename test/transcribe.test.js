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
  assert.deepEqual(published, []);
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
});

test('without cues the done message is as before: no label picked, nothing written', async () => {
  const { done, saved } = await runWithCues({ cueBatches: [], turnsSpec: [[1, 'A', 0, 2000], [2, 'B', 2200, 5000]] });
  assert.equal(done.userLabel, null);
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
  assert.equal(saved.otherName, 'Priya');
  // a label already on the conversation stays
  const kept = await runTalk({ lines: [[1, 'A', "Hi, I'm Parth."]], convo: { userLabel: 'B' } });
  assert.equal(kept.saved.userLabel, 'B');
  assert.equal(kept.done.userLabel, 'B');
});
