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
  const nod = [0, 0, 0, -3, -10, -9, -1, 0].map((pitch, i) => ({ t: i * 200, face: true, pitch }));
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
  assert.equal(b.baseline.smile, 0.23); // mean over the whole video, warm stretch included
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

test('behavior and insight on a labelled but never-processed conversation extract the hooks first', async () => {
  const convo = await (await fetch(`${base}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag: 'friend', otherName: 'Maya', consentConfirmed: true }),
  })).json();
  // the lip lock named the voice at the end of the recording; nobody tapped "get coaching"
  srv.store.updateConversation(convo.id, { userLabel: 'A', turns: maya });
  assert.equal(srv.store.getConversation(convo.id).hooks, null);
  const url = `${base}/api/conversations/${convo.id}`;

  const res = await fetch(`${url}/behavior`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mediapipe', fps: 5, frames: frames() }),
  });
  assert.equal(res.status, 200);
  const after = srv.store.getConversation(convo.id);
  assert.ok(after.hooks && Array.isArray(after.hooks.missedBids), 'hooks were extracted on the way to the behavior');
  assert.ok(after.signals && after.signals.questions.length >= 1, 'signals too');
  assert.ok(after.insight);

  // and /insight alone does the same for a conversation that has no video
  const bare = await (await fetch(`${base}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag: 'friend', otherName: 'Maya', consentConfirmed: true }),
  })).json();
  srv.store.updateConversation(bare.id, { userLabel: 'A', turns: maya });
  assert.equal((await fetch(`${base}/api/conversations/${bare.id}/insight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  assert.ok(srv.store.getConversation(bare.id).hooks, 'insight extracted the hooks first');
});


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

// ---------- awkward moments (from a real HackTX recording) ----------

import { detectAwkward } from '../src/nlp/awkward.js';
import { inferUserLabel } from '../src/behavior/speaker.js';

const shinali = [
  { turnId: 0, speaker: 'A', text: 'Hello.', startMs: 1100, endMs: 1740 },
  { turnId: 1, speaker: 'B', text: 'Hello?', startMs: 1900, endMs: 2540 },
  { turnId: 2, speaker: 'A', text: "Wait, what's your name?", startMs: 2780, endMs: 3580 },
  { turnId: 3, speaker: 'B', text: "Shanali, what's your name?", startMs: 3740, endMs: 5340 },
  { turnId: 4, speaker: 'A', text: "Oh, I'm Parth. Wait, what do you do right now? Are you like YouTube?", startMs: 5500, endMs: 9900 },
  { turnId: 5, speaker: 'B', text: "Um I'm a wait aren't you the same roommate that like the girl cheated on her boyfriend with from Purdue? Um I'm not sure.", startMs: 10140, endMs: 19340 },
  { turnId: 6, speaker: 'A', text: 'Wait are you sure?', startMs: 19420, endMs: 20460 },
  { turnId: 7, speaker: 'B', text: "Yeah, I'm sure. I'm not sure.", startMs: 20540, endMs: 22860 },
  { turnId: 8, speaker: 'A', text: "Okay, okay, okay. Well I do CS at UTD but like I'm low-key just just bored that's why I like that's what I heard", startMs: 22860, endMs: 29980 },
  { turnId: 9, speaker: 'B', text: "That's cool.", startMs: 30140, endMs: 31900 },
  { turnId: 10, speaker: 'A', text: 'Okay.', startMs: 32140, endMs: 35500 },
];

test('the rumour and the cut-in are yours, even where the voices got merged into her line', () => {
  const a = detectAwkward(shinali, 'A');
  const mine = a.flags.filter(f => f.who === 'you').map(f => `${f.turnId} ${f.kind}`);
  assert.ok(mine.includes('5 cut-in'));
  assert.ok(mine.includes('5 gossip'));
  assert.ok(mine.includes('8 gossip'));
  assert.ok(mine.includes('8 undersell'));
  assert.ok(a.flags.some(f => f.turnId === 9 && f.kind === 'short-reply' && f.who === 'them'));
  assert.ok(a.flags.some(f => f.turnId === 7 && f.kind === 'hedge'));
  assert.equal(a.seams[0].theirs, "Um I'm a");
  assert.match(a.seams[0].yours, /^wait aren't you the same roommate/);
});

test('ordinary quick turn-taking is not a cut-in', () => {
  const polite = [
    { turnId: 1, speaker: 'B', text: 'Nice to meet you too.', startMs: 0, endMs: 1500 },
    { turnId: 2, speaker: 'A', text: 'So what do you do?', startMs: 1580, endMs: 3000 },
  ];
  assert.deepEqual(detectAwkward(polite, 'A').flags, []);
  const open = [{ ...polite[0], text: 'I was going to say that the' }, polite[1]];
  assert.equal(detectAwkward(open, 'A').flags[0].kind, 'cut-in');
});

test('nothing awkward of yours is ever "keep doing this", whatever the face did', async () => {
  const hooks = extractHooks(shinali, 'A');
  const signals = { questions: [{ turnId: 6, isFollowUp: true }, { turnId: 4, isFollowUp: false }] };
  // Big smile after the rumour: still not praise
  const frames = Array.from({ length: 180 }, (_, i) => ({ t: i * 200, face: true, smile: i * 200 > 20500 && i * 200 < 23000 ? 0.8 : 0.2, yaw: 0, pitch: 0, jawOpen: 0.1, browUp: 0.1 }));
  const behavior = alignBehavior({ model: 'x', fps: 5, frames, turns: shinali, userLabel: 'A', signals, hooks });
  const out = await generateInsight({
    llm: stub({ moments: [{ turnId: 6, title: 'Great check-in', observation: 'Smile rose 60 points.', why: 'Keep doing this.' }], adviceCheck: [], rewrites: [] }),
    note: null, behavior, hooks, signals, turns: shinali, userLabel: 'A',
  });
  assert.ok(!out.takeaways.some(t => t.kind === 'keep'), 'turn 6 got a hedge back, so no praise');
  assert.equal(out.takeaways[0].kind, 'try');
  assert.equal(out.takeaways[0].turnId, 5); // the rumour comes first
  assert.match(out.takeaways[0].evidence, /Gossip about someone else/);
});

test('quoting the user is fine; judging the other person is not', async () => {
  const hooks = extractHooks(shinali, 'A');
  const ask = observation => generateInsight({
    llm: stub({ moments: [{ turnId: 8, title: 't', observation, why: 'w' }], adviceCheck: [], rewrites: [] }),
    note: null, behavior: null, hooks, signals: null, turns: shinali, userLabel: 'A',
  });
  assert.equal((await ask('You called yourself just bored.')).source, 'muse-spark');
  assert.equal((await ask('She was bored by then.')).source, 'fallback');
  assert.equal((await ask('They seemed uncomfortable.')).source, 'fallback');
});

test('the voice whose lines move the face on camera is theirs, so the other one is yours', () => {
  const frames = Array.from({ length: 180 }, (_, i) => {
    const t = i * 200;
    const theirs = shinali.some(x => x.speaker === 'B' && t >= x.startMs && t <= x.endMs);
    return { t, face: true, jawOpen: theirs ? (i % 2 ? 0.3 : 0.05) : 0.05 + (i % 2) * 0.02, smile: 0.2, yaw: 0, pitch: 0, browUp: 0 };
  });
  assert.equal(inferUserLabel(shinali, frames).label, 'A');
  const still = frames.map(f => ({ ...f, jawOpen: 0.1 }));
  assert.equal(inferUserLabel(shinali, still), null, 'no difference, no guess');
  // One face re-lock during your lines (a 0.6 jump) must not read as you being the one on camera.
  const relock = still.map((f, i) => ({ ...f, jawOpen: i === 44 ? 0.7 : 0.1 }));
  assert.equal(inferUserLabel(shinali, relock), null, 'a single jump is not talking');
  const close = frames.map((f, i) => (f.jawOpen === 0.3 ? { ...f, jawOpen: 0.09 } : f)); // 0.04 vs 0.02 is 2x
  assert.equal(inferUserLabel(shinali, close).label, 'A');
});

// ---------- pose cues on real phone footage (5 fps, handheld) ----------

import { readFileSync } from 'node:fs';
import { nodTimes } from '../src/behavior/align.js';

// Pitch readings copied from a real recording while the other person stood still and listened:
// the frame-to-frame wobble of a handheld phone, with a mouth-open blip at the end.
const STILL_PITCH = [-0.9, -0.6, -0.7, 0.2, -1.1, -0.7, -1.4, -0.6, -0.5, -3.8, -4.4, -2.9, -0.1, 3.4, -0.3, -4.8, -1.3, 5.6, 2.5, -1.7];
const seq = (pitches, jaw = 0.02) => pitches.map((pitch, i) => ({ t: i * 200, face: true, pitch, smile: 0.1, jawOpen: jaw, browUp: 0.1, yaw: 0 }));

test('handheld jitter of a few degrees is not a nod; a real dip and return is', () => {
  assert.equal(countNods(seq(STILL_PITCH)), 0, 'wobble around ±5° should not count');
  const nod = seq([-2, -1, -2, -1, -12, -10, -3, -1, -2]);
  assert.equal(countNods(nod), 1);
  // the same dip with the face lost for a second right before it: nothing to compare against
  const gap = nod.map((f, i) => (i === 2 || i === 3 ? { ...f, face: false } : f));
  assert.equal(countNods(gap), 0);
});

test('the replay page finds the same nods as the server', () => {
  const src = readFileSync(new URL('../public/replay.js', import.meta.url), 'utf8');
  const fn = name => src.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(fn('findNods') && fn('refPitch'), 'replay.js still defines findNods/refPitch');
  const consts = src.match(/^const (NOD_DEG|NOD_MAX_MS|NOD_REF_MS|NOD_GAP_MS) = .*$/gm).join('\n');
  const findNods = new Function(`${consts}\n${fn('refPitch')}\n${fn('findNods')}\nreturn findNods;`)();
  const mixed = seq([...STILL_PITCH, -2, -1, -12, -11, -2, -1, ...STILL_PITCH, 1, 2, 14, 12, 3, 1]);
  const lost = mixed.map((f, i) => (i % 17 === 0 ? { ...f, face: false } : f));
  for (const frames of [mixed, lost, seq(STILL_PITCH)]) {
    assert.deepEqual(findNods(frames), nodTimes(frames));
  }
  assert.equal(nodTimes(mixed).length, 2);
});

test('a smile that is spiky but no different from usual is not a reaction', () => {
  // Talking makes the smile score blip for one frame at a time; that happens all conversation long.
  const spiky = [];
  for (let t = 0; t <= 20000; t += 200) spiky.push({ t, face: true, smile: (t / 200) % 5 === 0 ? 0.8 : 0.1, jawOpen: 0.1, browUp: 0.1, yaw: 0, pitch: 0 });
  const b = alignBehavior({ model: 'x', fps: 5, frames: spiky, turns, userLabel: 'A', signals, hooks: null });
  for (const r of b.turns.filter(r => r.reaction)) {
    assert.ok(Math.abs(r.reaction.smileDelta) < 0.05, `turn ${r.turnId} read a reaction of ${r.reaction.smileDelta} out of nothing`);
  }
  assert.ok(Math.abs(b.stats.afterOther.smileDelta) < 0.05);
  // one-frame blips don't make a line "lit" either: "so fun!" over a face like this is not a match
  assert.notEqual(b.turns.find(r => r.turnId === 2).congruence, 'match');
  assert.ok(b.turns.find(r => r.turnId === 2).smilePeak < 0.4, 'peak is the sustained smile, not a blip');
});

test('heatmap colours your side of a cut-in, as a phrase, and never truncates a flagged phrase', () => {
  const hooks = extractHooks(shinali, 'A');
  const map = buildHeatmap({ turns: shinali, userLabel: 'A', hooks, signals: null, behavior: null });
  const awk = id => map.turns.find(t => t.turnId === id).words.filter(w => w.kind === 'awkward').map(w => w.w);
  // Turn 5 is her line with you merged in. "Um I'm a" is hers; the cut-in starts at "wait aren't you".
  assert.ok(!awk(5).includes("I'm"), 'her words are not your awkward moment');
  assert.deepEqual(awk(5).slice(0, 3), ['wait', "aren't", 'you']);
  // "just bored" and "that's what I heard" both stay whole, past the usual three-per-line cap.
  assert.deepEqual(awk(8), ['just', 'bored', "that's", 'what', 'I', 'heard']);
  for (const t of map.turns) assert.ok(t.words.filter(w => w.kind && w.kind !== 'awkward').length <= 3, `turn ${t.turnId}`);
});
