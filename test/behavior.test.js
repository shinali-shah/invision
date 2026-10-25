import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { alignBehavior, cleanFrames, countNods, textTone } from '../src/behavior/align.js';
import { buildHeatmap } from '../src/nlp/heatmap.js';
import { generateInsight, fallbackInsight } from '../src/agents/insight.js';
import { extractHooks } from '../src/nlp/hooks.js';
import { createServer } from '../src/server.js';

const turns = [
  { turnId: 1, speaker: 'A', text: 'What are you working on?', startMs: 0, endMs: 2000 },
  { turnId: 2, speaker: 'B', text: "I'm building a robotics arm for the hackathon, it's been so fun!", startMs: 2000, endMs: 6000 },
  { turnId: 3, speaker: 'A', text: 'Wait, how does the robotics arm grab things?', startMs: 6000, endMs: 8000 },
  { turnId: 4, speaker: 'B', text: 'Suction cups, honestly it took forever to get the robotics part right, my team nearly gave up twice.', startMs: 8000, endMs: 13000 },
  { turnId: 5, speaker: 'A', text: 'Um cool. Anyway do you want food?', startMs: 13000, endMs: 15000 },
  { turnId: 6, speaker: 'B', text: 'Sure.', startMs: 15000, endMs: 16000 },
];
const signals = { questions: [
  { turnId: 1, isFollowUp: false }, { turnId: 3, isFollowUp: true }, { turnId: 5, isFollowUp: false },
] };

// Smiles big after the follow-up (8-10.5 s), flat after the food question, nods once at 9 s.
function frames() {
  const out = [];
  for (let t = 0; t <= 17000; t += 200) {
    const warm = t >= 8000 && t <= 10500;
    out.push({ t, face: true, smile: warm ? 0.7 : 0.15, jawOpen: 0.1, browUp: 0.1, yaw: t > 15000 ? 40 : 0, pitch: t >= 9000 && t < 9400 ? -8 : 0 });
  }
  return out;
}

test('cleanFrames drops junk, clamps scores and sorts by time', () => {
  const out = cleanFrames([{ t: 5, smile: 3 }, null, { t: 'x' }, { t: 1, face: true, smile: -1, yaw: 999 }]);
  assert.deepEqual(out.map(f => f.t), [1, 5]);
  assert.equal(out[0].smile, 0);
  assert.equal(out[0].yaw, 180);
  assert.equal(out[1].smile, 1);
  assert.equal(cleanFrames('nope').length, 0);
});

test('a dip-and-return in pitch is one nod; a slow drift is none', () => {
  const nod = [0, -3, -7, -6, -1, 0].map((pitch, i) => ({ t: i * 200, face: true, pitch }));
  assert.equal(countNods(nod), 1);
  const drift = Array.from({ length: 20 }, (_, i) => ({ t: i * 500, face: true, pitch: -i }));
  assert.equal(countNods(drift), 0);
});

test('text tone reads English and Spanish', () => {
  assert.equal(textTone('it was so fun!'), 'positive');
  assert.equal(textTone('estoy cansada y triste'), 'negative');
  assert.equal(textTone('Suction cups.'), 'neutral');
});

test('alignBehavior: reactions after follow-ups vs other lines, baseline, facing', () => {
  const hooks = extractHooks(turns, 'A');
  const b = alignBehavior({ model: 'test', fps: 5, frames: frames(), turns, userLabel: 'A', signals, hooks });
  assert.equal(b.faceSeenPct, 1);
  assert.equal(b.baseline.smile, 0.15);
  const t3 = b.turns.find(r => r.turnId === 3);
  assert.ok(t3.reaction.smileDelta > 0.4, 'smiled after the follow-up');
  assert.equal(t3.reaction.nods, 1);
  const t5 = b.turns.find(r => r.turnId === 5);
  assert.ok(t5.reaction.smileDelta <= 0.01);
  assert.ok(t5.reaction.facingPct < 1, 'looked away after the food question');
  assert.equal(b.stats.afterFollowUps.n, 1);
  assert.ok(b.stats.afterFollowUps.smileDelta > b.stats.afterOther.smileDelta);
  // "so fun!" said with a flat face is a mixed signal; the user's own lines never get one
  assert.equal(b.turns.find(r => r.turnId === 2).congruence, 'mixed');
  assert.equal(t3.congruence, null);
});

test('no face at all gives nulls, not crashes', () => {
  const b = alignBehavior({ model: 'x', fps: 5, frames: [{ t: 0, face: false }], turns, userLabel: 'A', signals, hooks: null });
  assert.equal(b.faceSeenPct, 0);
  assert.equal(b.turns[0].smile, null);
  assert.equal(b.stats.afterFollowUps.n, 0);
});

test('heatmap marks picked-up words, follow-ups, fillers and the missed moment', () => {
  const hooks = extractHooks(turns, 'A');
  const behavior = alignBehavior({ model: 'x', fps: 5, frames: frames(), turns, userLabel: 'A', signals, hooks });
  const map = buildHeatmap({ turns, userLabel: 'A', hooks, signals, behavior, frames: frames() });
  const words = id => map.turns.find(t => t.turnId === id).words;
  assert.equal(words(2).map(w => w.w).join(' '), turns[1].text, 'tokens rebuild the line');
  assert.ok(words(2).some(w => /robotics/.test(w.w) && w.kind === 'picked-up'));
  assert.ok(words(3).some(w => /robotics/.test(w.w) && w.kind === 'follow-up'));
  assert.ok(words(5).some(w => w.w === 'Um' && w.kind === 'filler'));
  assert.ok(words(4).some(w => w.kind === 'missed' || w.kind === 'smile'));
  assert.ok(map.turns.find(t => t.turnId === 3).reaction > 0.4);
  assert.ok(map.legend.length >= 6);
});

test('heatmap works with no video and no hooks', () => {
  const map = buildHeatmap({ turns, userLabel: 'A', hooks: null, signals: null, behavior: null });
  assert.equal(map.turns.length, 6);
  assert.ok(map.turns.every(t => t.reaction === null));
});

const stub = reply => ({ async json() { if (reply instanceof Error) throw reply; return reply; } });

test('insight keeps grounded moments and drops unknown turns', async () => {
  const hooks = extractHooks(turns, 'A');
  const behavior = alignBehavior({ model: 'x', fps: 5, frames: frames(), turns, userLabel: 'A', signals, hooks });
  const out = await generateInsight({
    llm: stub({
      moments: [
        { turnId: 3, title: 'Follow-up landed', observation: 'Their smile rose 55 points after this.', why: 'Keep asking how things work.' },
        { turnId: 99, title: 'x', observation: 'y', why: 'z' },
      ],
      adviceCheck: [{ advice: 'Ask about their project', verdict: 'backed', evidenceTurnIds: [3, 42], reason: 'Smile +55 after the follow-up.' }],
    }),
    note: { text: 'n', suggestion: 'Ask about their project' }, behavior, hooks, signals, turns, userLabel: 'A',
  });
  assert.equal(out.source, 'muse-spark');
  assert.deepEqual(out.moments.map(m => m.turnId), [3]);
  assert.deepEqual(out.adviceCheck[0].evidenceTurnIds, [3]);
});

test('insight that reads minds ("she was bored", "fake smile") falls back to the numbers', async () => {
  const hooks = extractHooks(turns, 'A');
  const behavior = alignBehavior({ model: 'x', fps: 5, frames: frames(), turns, userLabel: 'A', signals, hooks });
  for (const observation of ['She was bored by the food question.', 'That was a fake smile.']) {
    const out = await generateInsight({
      llm: stub({ moments: [{ turnId: 5, title: 't', observation, why: 'w' }], adviceCheck: [] }),
      note: { suggestion: 'Ask more follow-ups.' }, behavior, hooks, signals, turns, userLabel: 'A',
    });
    assert.equal(out.source, 'fallback');
  }
});

test('fallback insight backs the follow-up advice when reactions were warmer after follow-ups', () => {
  const hooks = extractHooks(turns, 'A');
  const behavior = alignBehavior({ model: 'x', fps: 5, frames: frames(), turns, userLabel: 'A', signals, hooks });
  const out = fallbackInsight({ note: { suggestion: 'Ask one more follow-up.' }, behavior, hooks, turns });
  assert.equal(out.adviceCheck[0].verdict, 'backed');
  assert.ok(out.moments.length >= 1 && out.moments[0].turnId === 3);
});

// ---------- routes ----------

let srv;
let base;
before(async () => {
  const config = Object.freeze({
    apiKey: null, mock: true, port: 0, languages: ['English'], sparkModel: 'm', asrModel: 'a', dbPath: ':memory:',
  });
  srv = createServer({ config, quiet: true, mockSpeed: 1000 });
  await new Promise(r => srv.server.listen(0, r));
  base = `http://localhost:${srv.server.address().port}`;
});
after(() => srv.close());

test('video upload, ranged playback, behavior, heatmap and delete', async () => {
  const convo = await (await fetch(`${base}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag: 'friend', otherName: 'Sam', consentConfirmed: true }),
  })).json();
  const url = `${base}/api/conversations/${convo.id}`;

  assert.equal((await fetch(`${url}/recording`)).status, 404);
  assert.equal((await fetch(`${url}/recording`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await fetch(`${url}/recording`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: '' })).status, 400);

  const video = Buffer.alloc(5000, 7);
  const up = await fetch(`${url}/recording?offsetMs=120`, { method: 'POST', headers: { 'Content-Type': 'video/mp4;codecs=avc1' }, body: video });
  assert.equal(up.status, 201);
  const rec = await up.json();
  assert.deepEqual([rec.bytes, rec.offsetMs, rec.mime], [5000, 120, 'video/mp4']);

  const ranged = await fetch(`${url}/recording`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  assert.equal((await fetch(`${url}/behavior`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"frames":[]}' })).status, 400);
  const res = await fetch(`${url}/behavior`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mediapipe', fps: 5, frames: frames() }),
  });
  assert.equal(res.status, 200);
  const { behavior, insight } = await res.json();
  assert.ok(behavior.frameCount > 50);
  assert.ok(insight);
  assert.equal((await (await fetch(`${url}/behavior/frames`)).json()).frames.length, behavior.frameCount);
  assert.ok(Array.isArray((await (await fetch(`${url}/heatmap`)).json()).turns));

  assert.equal((await fetch(url, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${url}/recording`)).status, 404);
});

// ---------- takeaways ----------

const maya = [
  { turnId: 1, speaker: 'B', text: "A glove that translates sign language. My little brother is deaf, so honestly it's personal for me.", startMs: 0, endMs: 6000 },
  { turnId: 2, speaker: 'A', text: 'Cool. We are doing an AI coaching app with glasses.', startMs: 6400, endMs: 9000 },
  { turnId: 3, speaker: 'B', text: 'Oh that sounds fun.', startMs: 9400, endMs: 10500 },
  { turnId: 4, speaker: 'A', text: 'Wait, how does the glove read the signs?', startMs: 11000, endMs: 13000 },
  { turnId: 5, speaker: 'B', text: "Flex sensors. I'm going to show my brother the demo next weekend.", startMs: 13400, endMs: 18000 },
  { turnId: 6, speaker: 'A', text: "I'll send you our demo video. Good luck with your brother!", startMs: 18400, endMs: 21000 },
];

test('the missed moment becomes a grounded "try this" with numbers we computed', async () => {
  const hooks = extractHooks(maya, 'A');
  assert.deepEqual(hooks.missedBids.map(b => b.replyTurnId), [2]); // "Good luck with your brother!" is not a miss
  const frames = Array.from({ length: 120 }, (_, i) => {
    const t = i * 200;
    const cold = t > 9000 && t < 11500;
    return { t, face: true, smile: cold ? 0.1 : t > 13000 && t < 15500 ? 0.6 : 0.2, yaw: cold ? 35 : 0, pitch: 0, jawOpen: 0.1, browUp: 0.1 };
  });
  const signals = { questions: [{ turnId: 4, isFollowUp: true }] };
  const behavior = alignBehavior({ model: 'x', fps: 5, frames, turns: maya, userLabel: 'A', signals, hooks });
  const llm = stub({
    moments: [{ turnId: 4, title: 'Glove question landed', observation: 'Their smile rose 40 points.', why: 'Go back to what they cared about.' }],
    adviceCheck: [],
    rewrites: [
      { turnId: 2, title: 'Stay with their story', tryInstead: 'Is your brother the reason you started building the glove?', because: 'It shows you heard the personal part.' },
      { turnId: 4, title: 'x', tryInstead: 'What about pizza?', because: 'y' }, // not a candidate
    ],
  });
  const out = await generateInsight({ llm, note: null, behavior, hooks, signals, turns: maya, userLabel: 'A' });
  assert.deepEqual(out.rewrites.map(r => r.turnId), [2]);
  const [tryIt, keep, next] = out.takeaways;
  assert.equal(tryIt.kind, 'try');
  assert.match(tryIt.tryInstead, /brother/);
  assert.match(tryIt.said, /^Cool\./);
  assert.match(tryIt.theySaid, /deaf/);
  assert.match(tryIt.evidence, /^Smile −?-?\d+ · looked away/);
  assert.equal(keep.kind, 'keep');
  assert.equal(keep.turnId, 4);
  assert.equal(keep.title, 'Glove question landed');
  assert.equal(next.kind, 'next');
  assert.match(next.text, /next weekend/);
});

test('an ungrounded rewrite is replaced by a plain one that names their words', async () => {
  const hooks = extractHooks(maya, 'A');
  const llm = stub({
    moments: [{ turnId: 4, title: 't', observation: 'o', why: 'w' }], adviceCheck: [],
    rewrites: [{ turnId: 2, title: 'Be curious', tryInstead: 'Tell me more!', because: 'b' }],
  });
  const out = await generateInsight({ llm, note: null, behavior: null, hooks, signals: null, turns: maya, userLabel: 'A' });
  assert.equal(out.rewrites.length, 1);
  assert.notEqual(out.rewrites[0].tryInstead, 'Tell me more!');
  assert.equal(out.takeaways[0].kind, 'try');
  assert.equal(out.takeaways[0].evidence, 'They had just shared something personal');
});

test('heatmap keeps at most three coloured words per line', () => {
  const hooks = extractHooks(maya, 'A');
  const map = buildHeatmap({ turns: maya, userLabel: 'A', hooks, signals: null, behavior: null });
  for (const t of map.turns) assert.ok(t.words.filter(w => w.kind).length <= 3, `turn ${t.turnId}`);
});
