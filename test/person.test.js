import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPeople } from '../src/nlp/person.js';
import { DEMO_EVENTS } from '../src/mock/demoConversation.js';

const T = (turnId, speaker, text) => ({ turnId, speaker, text, startMs: 0, endMs: 0 });
const lines = rows => rows.map(([speaker, text], i) => T(i + 1, speaker, text));

function demoTurns() {
  const turns = [];
  let speaker = null;
  for (const e of DEMO_EVENTS) {
    if (e.type === 'speaker') speaker = e.label;
    if (e.type === 'speechComplete') turns.push(T(e.turnId, speaker, e.transcript));
  }
  return turns;
}

test('a self-introduction names that speaker', () => {
  const { other, self } = detectPeople(lines([['A', 'Hey, good to meet you.'], ['B', "Hi, I'm Priya. Thanks for coming."]]), { userName: 'Parth' });
  assert.equal(self, null);
  assert.equal(other.name, 'Priya');
  assert.equal(other.turnId, 2);
  assert.equal(other.confidence, 0.9);
  assert.match(other.how, /intro/);
  assert.match(other.how, /Priya/);
});

test('every English and Spanish intro phrase works', () => {
  for (const text of ['I am Jordan', 'My name is Jordan', "My name's Jordan", 'This is Jordan', 'Call me Jordan', 'Me llamo Jordan', 'Soy Jordan', 'Hola, soy Jordan.']) {
    const { other } = detectPeople(lines([['B', text]]), { userName: 'Parth' });
    assert.equal(other?.name, 'Jordan', text);
  }
});

test('two capitalised words make a two-word name', () => {
  const { other } = detectPeople(lines([['B', 'My name is Jordan Lee and I run the lab.']]), { userName: 'Parth' });
  assert.equal(other.name, 'Jordan Lee');
});

test('a greeting at the start of a line names the person being addressed', () => {
  const { other } = detectPeople(demoTurns(), { userName: 'Parth' });
  assert.equal(other.name, 'Abuela');
  assert.equal(other.turnId, 1);
  assert.equal(other.confidence, 0.7);
  assert.match(other.how, /vocative/);
});

test('vocatives at the start or end of a line, English and Spanish', () => {
  const cases = [['Jordan, hey! Long time.', 'Jordan'], ['Hi Jordan!', 'Jordan'], ['Thanks so much, Maria.', 'Maria'], ['Hola Ana', 'Ana'], ['Good morning Dr. Okafor', null], ['thanks Maria', 'Maria']];
  for (const [text, want] of cases) {
    const { other } = detectPeople(lines([['A', text]]), { userName: 'Parth' });
    assert.equal(other?.name ?? null, want, text);
  }
});

test('greetings, fillers, kin slang, days and lowercase words are not names', () => {
  for (const text of ['Hi there!', 'Okay, so what happened?', "I'm Sorry about that.", 'See you Monday.', 'Hi Mija!', 'hi abuela', 'Hey Bro, what up', 'Thanks, Dude.', "I'm Good, you?", 'Hola, Buenos días.', 'Hi, Hey!', 'Oaxaca? Did you grow tomatoes there too?', 'Pancha.']) {
    const { other } = detectPeople(lines([['A', text]]), { userName: 'Parth' });
    assert.equal(other, null, text);
  }
});

test("the user's own introduction comes back as self, not as the other person", () => {
  const turns = lines([['A', "Hi, I'm Parth."], ['B', "Nice to meet you Parth, I'm Priya."]]);
  const { other, self } = detectPeople(turns, { userName: 'Parth' });
  assert.deepEqual(self, { speaker: 'A', name: 'Parth', turnId: 1 });
  assert.equal(other.name, 'Priya');
  assert.equal(other.confidence, 0.9);
});

test('a first-name match is enough for the user', () => {
  const { self } = detectPeople(lines([['A', 'My name is Parth Srivastava']]), { userName: 'Parth' });
  assert.equal(self.speaker, 'A');
  assert.equal(self.name, 'Parth Srivastava');
});

test('with userLabel known, the other person calling the user by name is not the other person', () => {
  const turns = lines([['B', 'Hi Parth, come in.'], ['A', 'Hi Abuela!']]);
  const { other } = detectPeople(turns, { userName: 'Parth', userLabel: 'A' });
  assert.equal(other.name, 'Abuela');
  const alone = detectPeople(lines([['B', 'Hi Parth, come in.']]), { userName: 'Parth', userLabel: 'A' });
  assert.equal(alone.other, null);
});

test("with userLabel known, the user's own intro is still self and a nickname from the other side is ignored", () => {
  const turns = lines([['B', 'Hey Champ, how are you'], ['A', 'Good! Soy Parth.']]);
  const { other, self } = detectPeople(turns, { userName: 'Parth', userLabel: 'A' });
  assert.equal(other, null);
  assert.equal(self.speaker, 'A');
});

test('conflicting names lower the confidence; the stronger cue wins, ties go to the earliest', () => {
  const two = detectPeople(lines([['A', 'Hi Sam!'], ['B', "I'm Priya."]]), { userName: 'Parth' });
  assert.equal(two.other.name, 'Priya');
  assert.equal(two.other.confidence, 0.7);
  const vocs = detectPeople(lines([['A', 'Hi Sam!'], ['A', 'Thanks, Maria.']]), { userName: 'Parth' });
  assert.equal(vocs.other.name, 'Sam');
  assert.equal(vocs.other.confidence, 0.5);
});

test('the same name heard twice is not a conflict', () => {
  const { other } = detectPeople(lines([['A', 'Hi Abuela!'], ['B', 'Hola mija'], ['A', 'Gracias, Abuela.']]), { userName: 'Parth' });
  assert.equal(other.name, 'Abuela');
  assert.equal(other.confidence, 0.7);
});

test("an 'unknown' speaker can still name the other person but never becomes self", () => {
  const { other } = detectPeople(lines([['unknown', "Hi, I'm Priya."]]), { userName: 'Parth' });
  assert.equal(other.name, 'Priya');
  const { self, other: none } = detectPeople(lines([['unknown', "Hi, I'm Parth."]]), { userName: 'Parth' });
  assert.equal(self, null);
  assert.equal(none, null);
});

test('nothing to go on gives nulls and never throws', () => {
  assert.deepEqual(detectPeople(lines([['A', 'So how was the trip?'], ['B', 'Long. Very long.']]), { userName: 'Parth' }), { other: null, self: null });
  assert.deepEqual(detectPeople([], { userName: 'Parth' }), { other: null, self: null });
  assert.deepEqual(detectPeople(null, {}), { other: null, self: null });
  assert.deepEqual(detectPeople([{ turnId: 1, speaker: 'A' }], {}), { other: null, self: null });
});
