import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRuleSignals } from '../src/analysis/rules.js';

const words = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

const turns = [
  { turnId: 1, speaker: 'A', text: 'How was the trip?', startMs: 0, endMs: 2000 },
  { turnId: 2, speaker: 'B', text: words(12), startMs: 2000, endMs: 8000 },
  { turnId: 3, speaker: 'A', text: 'Did you see the coast?', startMs: 8000, endMs: 10000 },
  { turnId: 4, speaker: 'B', text: words(3), startMs: 10000, endMs: 11000 },
  { turnId: 5, speaker: 'A', text: '¿Cómo está tu jardín?', startMs: 11000, endMs: 13000 },
  { turnId: 6, speaker: 'B', text: words(25), startMs: 13000, endMs: 20000 },
];

test('counts the user questions and the replies they got', () => {
  const s = computeRuleSignals(turns, 'A');
  assert.equal(s.userQuestions, 3);
  assert.equal(s.userTurns, 3);
  assert.equal(s.otherTurns, 3);
  assert.equal(s.userTalkMs, 6000);
  assert.equal(s.otherTalkMs, 14000);
  assert.equal(s.userTalkShare, 0.3);
  assert.equal(s.otherAvgAnswerWords, 13.3);
  assert.equal(s.source, 'rules-only');
  assert.equal(s.followUps, null);
  assert.equal(s.reflections, null);
  assert.equal(s.storiesAfterQuestions, null);
  assert.deepEqual(s.questions.map(q => [q.turnId, q.replyTurnId, q.replyWords]), [[1, 2, 12], [3, 4, 3], [5, 6, 25]]);
  assert.ok(s.questions.every(q => q.isFollowUp === null && q.storyShared === null));
});

test('a question followed by another user turn has no reply', () => {
  const s = computeRuleSignals([
    { turnId: 1, speaker: 'A', text: 'You good?', startMs: 0, endMs: 1000 },
    { turnId: 2, speaker: 'A', text: 'Anyway.', startMs: 1000, endMs: 2000 },
    { turnId: 3, speaker: 'B', text: 'yes', startMs: 2000, endMs: 3000 },
  ], 'A');
  assert.equal(s.questions[0].replyTurnId, null);
  assert.equal(s.questions[0].replyWords, 0);
  assert.equal(s.otherAvgAnswerWords, 0);
});

test('diarization collapses to the user only', () => {
  const s = computeRuleSignals(turns.map(t => ({ ...t, speaker: 'A' })), 'A');
  assert.equal(s.otherTurns, 0);
  assert.equal(s.otherAvgAnswerWords, 0);
  assert.equal(s.userTalkShare, 1);
  assert.ok(s.questions.every(q => q.replyTurnId === null));
});

test('all-unknown speakers count as the other person', () => {
  const s = computeRuleSignals(turns.map(t => ({ ...t, speaker: 'unknown' })), 'A');
  assert.equal(s.userTurns, 0);
  assert.equal(s.userQuestions, 0);
  assert.equal(s.otherTurns, 6);
  assert.equal(s.userTalkShare, 0);
});

test('no turns gives zeros', () => {
  const s = computeRuleSignals([], 'A');
  assert.equal(s.userQuestions, 0);
  assert.equal(s.userTurns, 0);
  assert.equal(s.otherTurns, 0);
  assert.equal(s.userTalkShare, 0);
  assert.equal(s.otherAvgAnswerWords, 0);
  assert.deepEqual(s.questions, []);
});

test('background lines are counted as crowd and left out of everything else', () => {
  const withCrowd = [
    ...turns.slice(0, 2),
    { turnId: 9, speaker: 'C', text: 'Did anyone order the fries?', startMs: 8100, endMs: 9000, source: 'crowd' },
    ...turns.slice(2),
  ];
  const s = computeRuleSignals(withCrowd, 'A');
  const clean = computeRuleSignals(turns, 'A');
  assert.equal(s.crowd, 1);
  assert.equal(clean.crowd, 0);
  assert.equal(s.otherTurns, clean.otherTurns);
  assert.equal(s.otherTalkMs, clean.otherTalkMs);
  assert.deepEqual(s.questions, clean.questions);
});

test('a crowd line between a question and its answer does not steal the reply', () => {
  const s = computeRuleSignals([
    { turnId: 1, speaker: 'A', text: 'How was the trip?', startMs: 0, endMs: 1000 },
    { turnId: 2, speaker: 'C', text: 'excuse me', startMs: 1000, endMs: 1500, source: 'crowd' },
    { turnId: 3, speaker: 'B', text: words(10), startMs: 1500, endMs: 4000 },
  ], 'A');
  assert.equal(s.questions[0].replyTurnId, 3);
  assert.equal(s.questions[0].replyWords, 10);
});
