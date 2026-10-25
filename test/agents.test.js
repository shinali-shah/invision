import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAGS, TAG_FOCUS, FIXED_GOALS } from '../src/agents/context.js';
import { generateNote } from '../src/agents/coach.js';
import { reviewNote, violatesOtherPersonRule } from '../src/agents/reviewer.js';
import { findPattern } from '../src/agents/patternFinder.js';
import { proposeNextStep } from '../src/agents/nextStep.js';

// Stub llm: records every call, answers with `reply` (function or value), or throws.
function stubLlm(reply) {
  const calls = [];
  return {
    calls,
    async json(args) {
      calls.push(args);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(args) : reply;
    },
  };
}

// Walks a JSON schema and checks the strict-mode rules Muse enforces.
function assertStrictSchema(schema, path = 'root') {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path} needs additionalProperties:false`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path} must require every property`);
    for (const [key, sub] of Object.entries(schema.properties)) assertStrictSchema(sub, `${path}.${key}`);
  }
  if (schema.type === 'array') assertStrictSchema(schema.items, `${path}[]`);
}

const turns = [
  { turnId: 1, speaker: 'A', text: 'How was the trip to Oaxaca?', startMs: 0, endMs: 2000 },
  { turnId: 2, speaker: 'B', text: 'Oh it was lovely, we went to the market every morning.', startMs: 2000, endMs: 6000 },
  { turnId: 3, speaker: 'A', text: 'What did you buy at the market?', startMs: 6000, endMs: 8000 },
  { turnId: 4, speaker: 'B', text: 'Chiles, mostly, and a clay pot like the one my mother had.', startMs: 8000, endMs: 12000 },
];

const signals = {
  userQuestions: 2, userTurns: 2, otherTurns: 2, userTalkMs: 4000, otherTalkMs: 8000,
  userTalkShare: 0.33, otherAvgAnswerWords: 11.5,
  followUps: 1, reflections: 0, storiesAfterQuestions: 1,
  questions: [
    { turnId: 1, isFollowUp: false, replyTurnId: 2, replyWords: 11, storyShared: false },
    { turnId: 3, isFollowUp: true, replyTurnId: 4, replyWords: 12, storyShared: true },
  ],
  source: 'muse-spark',
};

const goodNote = {
  text: 'You asked two questions and one was a follow-up about the market. After that follow-up she told you about her mother’s clay pot.',
  suggestion: 'Next call, ask what she remembers about cooking with that pot.',
  citedTurnIds: [3, 4],
  status: 'shown',
  source: 'muse-spark',
};

test('context exposes the three tags with focus copy and three fixed goals each', () => {
  assert.deepEqual(TAGS, ['family', 'friend', 'networking']);
  assert.equal(TAG_FOCUS.friend, 'Follow-up questions, remembering what matters to them, following through');
  for (const tag of TAGS) {
    assert.equal(typeof TAG_FOCUS[tag], 'string');
    assert.equal(FIXED_GOALS[tag].length, 3);
  }
});

test('coach returns a shown note and drops cited turns that do not exist', async () => {
  const llm = stubLlm({ text: goodNote.text, suggestion: goodNote.suggestion, citedTurnIds: [1, 99] });
  const note = await generateNote({ llm, tag: 'family', signals, turns, userLabel: 'A', reflection: 'felt rushed', lastNotes: [] });
  assert.equal(note.status, 'shown');
  assert.equal(note.source, 'muse-spark');
  assert.deepEqual(note.citedTurnIds, [1]);
  assert.equal(note.text, goodNote.text);

  const call = llm.calls[0];
  assert.equal(call.name, 'coach');
  assert.equal(call.effort, 'medium');
  assert.match(call.system, /Phrases to keep the conversation going/);
  assertStrictSchema(call.schema);
});

test('coach falls back to a dropped note when the llm throws', async () => {
  const note = await generateNote({ llm: stubLlm(new Error('boom')), tag: 'friend', signals, turns, userLabel: 'A', reflection: null, lastNotes: [] });
  assert.deepEqual(note, { text: null, suggestion: null, citedTurnIds: [], status: 'dropped', reason: 'coach_failed', source: 'fallback' });
});

test('violatesOtherPersonRule flags judgements of the other person and scoring', () => {
  assert.equal(violatesOtherPersonRule('Your grandmother was boring'), true);
  assert.equal(violatesOtherPersonRule('She is rude'), true);
  assert.equal(violatesOtherPersonRule('Maria was cold', 'Maria'), true);
  assert.equal(violatesOtherPersonRule('You asked 3 questions'), false);
  assert.equal(violatesOtherPersonRule("I'd rate this 7/10"), true);
  assert.equal(violatesOtherPersonRule(goodNote.text), false);
});

test('reviewer pass keeps the note unchanged', async () => {
  const llm = stubLlm({ verdict: 'pass', text: '', suggestion: '' });
  const out = await reviewNote({ llm, note: goodNote, signals, otherName: 'Abuela' });
  assert.deepEqual(out, goodNote);
  assert.equal(llm.calls[0].name, 'review');
  assertStrictSchema(llm.calls[0].schema);
  assert.deepEqual(llm.calls[0].schema.properties.verdict.enum, ['pass', 'rewrite']);
});

test('reviewer rewrite replaces text and marks it rewritten', async () => {
  const llm = stubLlm({ verdict: 'rewrite', text: 'You asked two questions.', suggestion: 'Next call, ask about the market.' });
  const out = await reviewNote({ llm, note: goodNote, signals, otherName: 'Abuela' });
  assert.equal(out.status, 'rewritten');
  assert.equal(out.text, 'You asked two questions.');
  assert.equal(out.suggestion, 'Next call, ask about the market.');
  assert.deepEqual(out.citedTurnIds, goodNote.citedTurnIds);
});

test('reviewer drops a rewrite that still judges the other person', async () => {
  const llm = stubLlm({ verdict: 'rewrite', text: 'You asked two questions but Abuela seemed distant.', suggestion: 'Try again.' });
  const out = await reviewNote({ llm, note: goodNote, signals, otherName: 'Abuela' });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'reviewer');
  assert.equal(out.text, null);
  assert.equal(out.suggestion, null);
});

test('reviewer drops the note when the llm throws', async () => {
  const out = await reviewNote({ llm: stubLlm(new Error('timeout')), note: goodNote, signals, otherName: 'Abuela' });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'reviewer');
});

test('reviewer drops a violating note without calling the llm', async () => {
  const llm = stubLlm({ verdict: 'pass', text: '', suggestion: '' });
  const bad = { ...goodNote, text: 'You asked two questions. She was boring though.' };
  const out = await reviewNote({ llm, note: bad, signals, otherName: 'Abuela' });
  assert.equal(out.status, 'dropped');
  assert.equal(out.reason, 'reviewer');
  assert.equal(llm.calls.length, 0);
});

test('reviewer passes an already dropped note straight through', async () => {
  const llm = stubLlm({ verdict: 'pass', text: '', suggestion: '' });
  const dropped = { text: null, suggestion: null, citedTurnIds: [], status: 'dropped', reason: 'coach_failed', source: 'fallback' };
  assert.deepEqual(await reviewNote({ llm, note: dropped, signals, otherName: 'x' }), dropped);
  assert.equal(llm.calls.length, 0);
});

function convo(day, sig, tag = 'family') {
  return { id: `c${day}`, tag, otherName: 'Abuela', createdAt: `2026-10-${String(day).padStart(2, '0')}T18:00:00.000Z`, signals: sig };
}

const risingStatement = 'Your follow-up questions rose from 1 to 3 per conversation over the last week.';

test('pattern needs at least three analysed conversations', async () => {
  const llm = stubLlm({ statement: risingStatement });
  const out = await findPattern({ llm, conversations: [convo(1, { ...signals, followUps: 1 }), convo(2, { ...signals, followUps: 2 }), convo(3, null)] });
  assert.equal(out, null);
  assert.equal(llm.calls.length, 0);
});

test('pattern uses followUps in chronological order and keeps a statement that cites its numbers', async () => {
  const llm = stubLlm({ statement: risingStatement });
  // deliberately out of order: the finder sorts by createdAt
  const conversations = [convo(3, { ...signals, followUps: 3 }), convo(1, { ...signals, followUps: 1 }), convo(2, { ...signals, followUps: 2 }, 'friend')];
  const out = await findPattern({ llm, conversations });
  assert.deepEqual(out, { statement: risingStatement, metric: 'followUps', counts: [1, 2, 3] });
  assert.equal(llm.calls[0].name, 'pattern');
  assert.deepEqual(llm.calls[0].user, { metric: 'followUps', counts: [1, 2, 3], tags: ['family', 'friend', 'family'] });
  assertStrictSchema(llm.calls[0].schema);
});

test('pattern is null when the statement leaves out the first or last count', async () => {
  const llm = stubLlm({ statement: 'You are getting much better at follow-up questions.' });
  const out = await findPattern({ llm, conversations: [1, 2, 3].map(d => convo(d, { ...signals, followUps: d })) });
  assert.equal(out, null);
});

test('pattern is null when the llm throws', async () => {
  const out = await findPattern({ llm: stubLlm(new Error('500')), conversations: [1, 2, 3].map(d => convo(d, { ...signals, followUps: d })) });
  assert.equal(out, null);
});

test('pattern falls back to userQuestions when any conversation lacks AI signals', async () => {
  const llm = stubLlm({ statement: 'You asked 2 questions in your first conversation and 4 in your latest.' });
  const conversations = [
    convo(1, { ...signals, userQuestions: 2 }),
    convo(2, { ...signals, userQuestions: 3, followUps: null, source: 'rules-only' }),
    convo(3, { ...signals, userQuestions: 4 }),
  ];
  const out = await findPattern({ llm, conversations });
  assert.equal(out.metric, 'userQuestions');
  assert.deepEqual(out.counts, [2, 3, 4]);
});

const pattern = { statement: risingStatement, metric: 'followUps', counts: [1, 2, 3] };

test('next step returns the drafted goal', async () => {
  const llm = stubLlm({ goal: 'Ask one follow-up about the market in each call this week.' });
  const out = await proposeNextStep({ llm, pattern, tag: 'family', statedGoal: null });
  assert.equal(out, 'Ask one follow-up about the market in each call this week.');
  assert.equal(llm.calls[0].name, 'nextStep');
  assertStrictSchema(llm.calls[0].schema);
});

test('next step falls back to the fixed goal when the llm throws', async () => {
  const out = await proposeNextStep({ llm: stubLlm(new Error('nope')), pattern, tag: 'family', statedGoal: null });
  assert.equal(out, FIXED_GOALS.family[0]);
});

test('next step uses the fixed goal without calling the llm when there is no pattern', async () => {
  const llm = stubLlm({ goal: 'should not be used' });
  const out = await proposeNextStep({ llm, pattern: null, tag: 'networking', statedGoal: null });
  assert.equal(out, FIXED_GOALS.networking[0]);
  assert.equal(llm.calls.length, 0);
});

// ---- regressions from the live-transcript debugging pass ----

import { generateInsight } from '../src/agents/insight.js';
import { extractHooks } from '../src/nlp/hooks.js';

test('coach survives a reply whose fields have the wrong types instead of throwing out of the pipeline', async () => {
  const note = await generateNote({ llm: stubLlm({ text: 'You asked two questions.', suggestion: 'Ask about the pot.', citedTurnIds: '3' }), tag: 'family', signals, turns, userLabel: 'A', reflection: '' });
  assert.equal(note.status, 'shown');
  assert.deepEqual(note.citedTurnIds, []);
  const odd = await generateNote({ llm: stubLlm({ text: 'You asked two questions.', suggestion: 5, citedTurnIds: [3] }), tag: 'family', signals, turns, userLabel: 'A', reflection: '' });
  assert.equal(odd.suggestion, null);
});

test('reviewer survives a rewrite with a non-string suggestion', async () => {
  const note = await reviewNote({ llm: stubLlm({ verdict: 'rewrite', text: 'You asked two questions.', suggestion: 7 }), note: goodNote, signals });
  assert.equal(note.status, 'rewritten');
  assert.equal(note.suggestion, null);
});

test('violatesOtherPersonRule: talking about a game score is fine, "seemed bored" is not', () => {
  assert.equal(violatesOtherPersonRule('You asked about the score twice and she told you the whole match.'), false);
  assert.equal(violatesOtherPersonRule('You asked how their rating at work went.'), false);
  assert.equal(violatesOtherPersonRule('She was a 7/10 listener.'), true);
  assert.equal(violatesOtherPersonRule('She seemed bored by the end.'), true);
  assert.equal(violatesOtherPersonRule('He seemed pretty quiet after that.'), true);
});

const insightTurns = [
  { turnId: 1, speaker: 'A', text: 'How was Oaxaca?', startMs: 0, endMs: 1000 },
  { turnId: 2, speaker: 'B', text: 'Lovely, we saw the pottery market and my cousin got married there.', startMs: 1200, endMs: 5000 },
  { turnId: 3, speaker: 'A', text: 'Cool. I went to Austin.', startMs: 5200, endMs: 7000 },
];
const insightWith = (reply, turns = insightTurns) => generateInsight({
  llm: stubLlm(reply), note: null, behavior: null, hooks: extractHooks(turns, 'A'),
  signals: { questions: [{ turnId: 1, isFollowUp: false }] }, turns, userLabel: 'A',
});
const moment = (observation, why = 'Ask about it next time.', turnId = 2) => ({ moments: [{ turnId, title: 'Pottery', observation, why }], adviceCheck: [], rewrites: [] });

test('insight: stated interests and intensifiers are not mind-reading; sincerity and feelings still are', async () => {
  for (const ok of ['They are interested in pottery, so ask about the market.', 'You genuinely asked about the wedding.', 'Her cousin is happy there, she said.']) {
    assert.equal((await insightWith(moment(ok))).source, 'muse-spark', ok);
  }
  for (const bad of ['They seemed interested at first.', 'She looked bored by then.', 'That was a genuine smile.', 'They genuinely enjoyed that one.', 'She was happy about it.']) {
    assert.equal((await insightWith(moment(bad))).source, 'fallback', bad);
  }
});

test('insight: a corrective "keep the question about them" on a flagged line is not praise', async () => {
  const turns = [
    { turnId: 1, speaker: 'B', text: 'Do you know Sam?', startMs: 0, endMs: 1000 },
    { turnId: 2, speaker: 'A', text: 'I heard that she cheated on her boyfriend', startMs: 1200, endMs: 3000 },
    { turnId: 3, speaker: 'B', text: 'Oh. Um.', startMs: 3200, endMs: 3600 },
  ];
  const out = await insightWith(moment('You brought up the rumour and they answered in two words.', 'Next time keep the question about them, not about Sam.', 2), turns);
  assert.equal(out.source, 'muse-spark');
  assert.equal(out.moments[0].turnId, 2);
  const praised = await insightWith(moment('You brought up the rumour and they smiled.', 'That landed, keep doing it.', 2), turns);
  assert.equal(praised.source, 'fallback');
});

test('insight survives replies whose arrays are not arrays', async () => {
  for (const bad of [
    { moments: { turnId: 1 }, adviceCheck: [], rewrites: [] },
    { moments: [{ turnId: 2, title: 'x', observation: 'y', why: 'z' }], adviceCheck: [{ advice: 'a', verdict: 'backed', evidenceTurnIds: 'x', reason: 'r' }], rewrites: 'none' },
    { moments: [{ turnId: 2, title: 'x', observation: 'y', why: 'z' }], adviceCheck: [], rewrites: [{ turnId: 3, title: 't', tryInstead: 7, because: 'b' }] },
  ]) {
    const out = await insightWith(bad);
    assert.ok(['muse-spark', 'fallback'].includes(out.source));
    assert.ok(Array.isArray(out.takeaways));
  }
});
