import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRuleSignals } from '../src/analysis/rules.js';
import { classifySignals } from '../src/analysis/classify.js';

const turns = [
  { turnId: 1, speaker: 'A', text: 'How was the trip?', startMs: 0, endMs: 2000 },
  { turnId: 2, speaker: 'B', text: 'Great, we drove up the coast and got lost twice.', startMs: 2000, endMs: 8000 },
  { turnId: 3, speaker: 'A', text: 'Wait, where did you get lost?', startMs: 8000, endMs: 10000 },
  { turnId: 4, speaker: 'B', text: 'Near Big Sur.', startMs: 10000, endMs: 11000 },
  { turnId: 5, speaker: 'A', text: 'Did you stop in Monterey?', startMs: 11000, endMs: 13000 },
  { turnId: 6, speaker: 'B', text: 'No.', startMs: 13000, endMs: 14000 },
];
const ruleSignals = computeRuleSignals(turns, 'A');

function stub(result, calls = []) {
  return { json: async args => { calls.push(args); return result; } };
}

test('merges Muse Spark classifications into the rule signals', async () => {
  const calls = [];
  const llm = stub({
    questions: [
      { turnId: 1, isFollowUp: false, storyShared: true },
      { turnId: 3, isFollowUp: true, storyShared: false },
      { turnId: 5, isFollowUp: true, storyShared: false },
    ],
    reflections: 1,
  }, calls);
  const s = await classifySignals({ llm, turns, userLabel: 'A', tag: 'friend', ruleSignals });

  assert.equal(s.followUps, 2);
  assert.equal(s.storiesAfterQuestions, 1);
  assert.equal(s.reflections, 1);
  assert.equal(s.source, 'muse-spark');
  assert.equal(s.userQuestions, 3);
  assert.equal(s.questions[1].isFollowUp, true);
  assert.equal(s.questions[0].storyShared, true);
  assert.equal(s.questions[0].replyTurnId, 2);

  const call = calls[0];
  assert.equal(call.name, 'classify');
  assert.deepEqual(call.user, { tag: 'friend', userLabel: 'A', turns, questions: [1, 3, 5] });
  assert.match(call.system, /user/i);
  assert.match(call.system, /never/i);
});

test('schema is valid for strict mode', async () => {
  const calls = [];
  await classifySignals({ llm: stub({ questions: [], reflections: 0 }, calls), turns, userLabel: 'A', tag: 'friend', ruleSignals });
  const check = node => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(check);
    }
    if (node.type === 'array') check(node.items);
  };
  assert.equal(calls[0].schema.type, 'object');
  check(calls[0].schema);
});

test('ignores turnIds that are not user questions', async () => {
  const llm = stub({
    questions: [
      { turnId: 3, isFollowUp: true, storyShared: true },
      { turnId: 999, isFollowUp: true, storyShared: true },
      { turnId: 2, isFollowUp: true, storyShared: true },
    ],
    reflections: 0,
  });
  const s = await classifySignals({ llm, turns, userLabel: 'A', tag: 'friend', ruleSignals });
  assert.equal(s.followUps, 1);
  assert.equal(s.storiesAfterQuestions, 1);
  assert.equal(s.questions.length, 3);
});

test('falls back to rule counts when Muse Spark fails', async () => {
  const llm = { json: async () => { throw new Error('boom'); } };
  const s = await classifySignals({ llm, turns, userLabel: 'A', tag: 'friend', ruleSignals });
  assert.deepEqual(s, ruleSignals);
});

test('falls back when the response has the wrong shape', async () => {
  const s = await classifySignals({ llm: stub({ nope: true }), turns, userLabel: 'A', tag: 'friend', ruleSignals });
  assert.deepEqual(s, ruleSignals);
});
