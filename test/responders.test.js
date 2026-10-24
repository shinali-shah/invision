import { test } from 'node:test';
import assert from 'node:assert/strict';
import responders from '../src/mock/responders.js';
import { createTurnAssembler } from '../src/transcribe/assemble.js';
import { DEMO_EVENTS } from '../src/mock/demoConversation.js';

function demoTurns() {
  const a = createTurnAssembler();
  for (const e of DEMO_EVENTS) a.push(e);
  return a.flush();
}

const demoSignals = {
  userQuestions: 4, userTurns: 4, otherTurns: 4, userTalkMs: 9000, otherTalkMs: 17000,
  userTalkShare: 0.35, otherAvgAnswerWords: 15.5, followUps: 3, reflections: 0, storiesAfterQuestions: 2,
  questions: [], source: 'muse-spark',
};

test('classify finds 3 follow-ups and 2 stories in the demo call', () => {
  const turns = demoTurns();
  const questions = turns.filter(t => t.speaker === 'A' && /[?¿]/.test(t.text)).map(t => t.turnId);
  assert.equal(questions.length, 4);
  const out = responders.classify({ tag: 'family', userLabel: 'A', turns, questions });
  assert.equal(out.questions.length, 4);
  assert.equal(out.questions.filter(q => q.isFollowUp).length, 3);
  assert.equal(out.questions.filter(q => q.storyShared).length, 2);
  assert.equal(out.questions[0].isFollowUp, false); // the opener can't follow anything
  assert.equal(typeof out.reflections, 'number');
});

test('classify survives empty input', () => {
  assert.deepEqual(responders.classify({}), { questions: [], reflections: 0 });
});

test('coach writes a second-person note quoting the counts', () => {
  const turns = demoTurns();
  const out = responders.coach({ tag: 'family', signals: demoSignals, turns, userLabel: 'A', reflection: null, lastNotes: [], focus: '' });
  assert.match(out.text, /^You/);
  assert.ok(out.text.includes(String(demoSignals.userQuestions)));
  assert.ok(out.text.includes('3'));
  assert.ok(out.text.split(/(?<=[.!?])\s+/).length <= 3);
  assert.match(out.suggestion, /Oaxaca/);
  assert.ok(out.citedTurnIds.every(id => turns.some(t => t.turnId === id)));
});

test('coach suggestion depends on the tag', () => {
  const turns = demoTurns();
  const fam = responders.coach({ tag: 'family', signals: demoSignals, turns, userLabel: 'A' });
  const net = responders.coach({ tag: 'networking', signals: demoSignals, turns, userLabel: 'A' });
  assert.notEqual(fam.text, net.text);
  assert.match(net.suggestion, /follow-up message/i);
  assert.match(net.text, /follow-up message/i);
});

test('coach is defensive about missing fields', () => {
  const out = responders.coach({ tag: 'friend' });
  assert.match(out.text, /^You/);
  assert.ok(out.text.includes('0'));
  assert.deepEqual(out.citedTurnIds, []);
});

test('review passes the note through', () => {
  const note = { text: 'You asked 4 questions.', suggestion: 'Ask about Oaxaca.' };
  assert.deepEqual(responders.review({ note, signals: demoSignals }), { verdict: 'pass', ...note });
});

test('pattern statement cites the first and last counts', () => {
  const { statement } = responders.pattern({ metric: 'followUps', counts: [1, 2, 3], tags: ['family', 'family', 'family'] });
  assert.match(statement, /^Your follow-up questions rose from 1 to 3/);
  assert.match(responders.pattern({ metric: 'userTalkShare', counts: [0.6, 0.4] }).statement, /fell from 0.6 to 0.4/);
  assert.match(responders.pattern({ metric: 'userQuestions', counts: [2, 5, 2] }).statement, /held/);
});

test('nextStep returns a goal string', () => {
  const pattern = { metric: 'followUps', counts: [1, 2, 3], statement: 'x' };
  const { goal } = responders.nextStep({ pattern, tag: 'family', statedGoal: null });
  assert.equal(typeof goal, 'string');
  assert.ok(goal.length > 10);
  assert.match(responders.nextStep({ pattern, tag: 'family', statedGoal: 'ask about her recipes' }).goal, /recipes/);
  assert.equal(typeof responders.nextStep({}).goal, 'string');
});
