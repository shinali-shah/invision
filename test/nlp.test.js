import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokens, stem, contentWords, overlap, isQuestion, stripFillers,
  extractHooks, detectFollowUps, compareConversations, buildBrief,
} from '../src/nlp/index.js';
import { DEMO_EVENTS, SEED_CONVERSATIONS } from '../src/mock/demoConversation.js';

// Rebuild the demo's turns from its scripted realtime events.
function demoTurns() {
  const turns = [];
  let speaker = null;
  for (const e of DEMO_EVENTS) {
    if (e.type === 'speaker') speaker = e.label;
    if (e.type === 'speechComplete') turns.push({ turnId: e.turnId, speaker, text: e.transcript, startMs: 0, endMs: 0 });
  }
  return turns;
}

const lines = (rows, start = 1) => rows.map(([speaker, text], i) => ({
  turnId: start + i, speaker, text, startMs: i * 1000, endMs: i * 1000 + 900,
}));

const networking = lines([
  ['A', 'So what are you working on these days?'],
  ['B', 'Honestly I have my Meta interview next Friday and I am pretty nervous about the system design round, I keep studying every night.'],
  ['A', 'Cool. Do you know any good coffee places downtown?'],
  ['B', 'There is one on Fifth that I like.'],
  ['A', "Nice. I'll send you the article tonight about system design."],
  ['B', 'That would help a lot, thank you.'],
]);

const spanish = lines([
  ['B', 'Mañana tengo cita con el doctor, estoy un poco preocupada por los resultados.'],
  ['A', '¿Y qué te dijo la última vez?'],
  ['B', 'Que todo estaba bien. La próxima semana voy a Guadalajara a ver a mi hermana.'],
  ['A', 'Te llamo el domingo para saber cómo te fue.'],
]);

// --- text -------------------------------------------------------------------

test('tokens lowercases, keeps Unicode letters and drops possessive s', () => {
  assert.deepEqual(tokens("Abuela's maíz, ¿sí? 42!"), ['abuela', 'maíz', 'sí']);
  assert.deepEqual(tokens(null), []);
  assert.deepEqual(tokens(undefined), []);
});

test('stemming folds English plurals/verbs and Spanish verb endings', () => {
  assert.equal(stem('tomatoes'), stem('tomato'));
  assert.equal(stem('sembraban'), stem('sembrar'));
  assert.equal(stem('planting'), stem('plant'));
  assert.equal(stem('cooked'), stem('cook'));
  assert.equal(stem('stories'), stem('story'));
  assert.equal(stem('neighbors'), stem('neighbor'));
  assert.equal(stem('huertos'), stem('huerto'));
  // Short words and -ss/-us/-is endings are left alone.
  assert.equal(stem('news'), 'news');
  assert.equal(stem('paris'), 'paris');
  assert.equal(stem('class'), 'class');
});

test('contentWords drops stopwords and short words in both languages', () => {
  const words = contentWords('This is really what I wanted, pero también the garden con tomatoes');
  assert.deepEqual([...words].sort(), ['garden', 'tomato']);
  assert.equal(contentWords('').size, 0);
});

test('overlap returns shared stems from strings or sets', () => {
  assert.deepEqual(overlap('Did you grow tomatoes there?', 'The tomato is red'), ['tomato']);
  assert.deepEqual(overlap('¿Qué sembraban?', new Set([stem('sembrar')])), [stem('sembrar')]);
  assert.deepEqual(overlap('hello there', 'nothing shared'), []);
});

// --- follow-ups -------------------------------------------------------------

test('demo: every question after the first builds on what Abuela said', () => {
  const det = detectFollowUps(demoTurns(), 'A');
  assert.deepEqual(det.map(d => [d.turnId, d.isFollowUp]), [[1, false], [3, true], [5, true], [7, true]]);
  assert.ok(det[1].overlap.includes('oaxaca'));
  assert.ok(det[1].overlap.includes('tomatoes'), 'surface form, not the stem');
  assert.deepEqual(det[2].overlap, ['huerto']);
  assert.deepEqual(det[3].overlap, ['cabra']);
});

test('seed conversations: detector agrees with the baked-in classifier verdicts', () => {
  for (const conv of SEED_CONVERSATIONS) {
    const det = detectFollowUps(conv.turns, conv.userLabel);
    const expected = conv.signals.questions.map(q => [q.turnId, q.isFollowUp]);
    assert.deepEqual(det.map(d => [d.turnId, d.isFollowUp]), expected);
  }
});

test('back-reference questions count only right after the other person spoke', () => {
  const turns = lines([
    ['B', 'We ended up driving all night to get there.'],
    ['A', 'Really? How come?'],
    ['A', 'Why?'],
  ]);
  const det = detectFollowUps(turns, 'A');
  assert.equal(det[0].isFollowUp, true);
  assert.deepEqual(det[0].overlap, []);
  assert.equal(det[1].isFollowUp, false, 'previous turn was the user, so "why" has nothing to point at');

  const es = detectFollowUps(lines([['B', 'Fuimos al mercado.'], ['A', '¿Y luego qué pasó ahí?']]), 'A');
  assert.equal(es[0].isFollowUp, true);
});

test('an unrelated question is not a follow-up', () => {
  const det = detectFollowUps(networking, 'A');
  assert.deepEqual(det.map(d => [d.turnId, d.isFollowUp]), [[1, false], [3, false]]);
});

// --- hooks ------------------------------------------------------------------

test('demo hooks: topics, the Sunday event and the long turns', () => {
  const hooks = extractHooks(demoTurns(), 'A');
  assert.equal(hooks.topics[0].term, 'Oaxaca');
  assert.deepEqual(hooks.topics[0].turnIds, [2, 4]);
  assert.ok(hooks.topics.length <= 5);
  assert.ok(hooks.topics.some(t => t.term === 'tomatoes'));
  for (let i = 1; i < hooks.topics.length; i++) assert.ok(hooks.topics[i - 1].weight >= hooks.topics[i].weight);

  assert.deepEqual(hooks.events, [{ text: 'Te cuento más el domingo.', when: 'el domingo', hasNoun: false, turnId: 8 }]);
  assert.deepEqual(hooks.commitments, []);
  assert.deepEqual(hooks.missedBids, []);
  assert.deepEqual(hooks.highlights.map(h => h.turnId), [4, 6]);
  assert.ok(hooks.highlights[0].words >= hooks.highlights[1].words);
  assert.equal(hooks.followUpDetector.length, 4);
});

test('networking chat: interview event, article commitment, missed bid', () => {
  const hooks = extractHooks(networking, 'A');

  assert.equal(hooks.events.length, 1);
  assert.equal(hooks.events[0].turnId, 2);
  assert.equal(hooks.events[0].when, 'next friday');
  assert.equal(hooks.events[0].hasNoun, true);
  assert.match(hooks.events[0].text, /^Honestly I have my Meta interview next Friday/);
  assert.ok(hooks.events[0].text.length <= 90);

  assert.deepEqual(hooks.commitments, [{ text: "I'll send you the article tonight about system design.", turnId: 5 }]);

  assert.equal(hooks.missedBids.length, 1);
  assert.equal(hooks.missedBids[0].turnId, 2);
  assert.equal(hooks.missedBids[0].replyTurnId, 3);
  assert.ok(hooks.missedBids[0].cue.length >= 4);

  assert.ok(hooks.topics.some(t => t.term === 'Meta'), 'capitalized mid-sentence word is a topic');
  assert.deepEqual(hooks.highlights.map(h => h.turnId), [2]);
});

test('Spanish lines: mañana / la próxima semana events, te llamo commitment', () => {
  const hooks = extractHooks(spanish, 'A');
  assert.deepEqual(hooks.events.map(e => [e.turnId, e.when.toLowerCase()]), [[1, 'mañana'], [3, 'la próxima semana']]);
  assert.match(hooks.events[1].text, /Guadalajara/);
  assert.deepEqual(hooks.commitments, [{ text: 'Te llamo el domingo para saber cómo te fue.', turnId: 4 }]);
  // Turn 2 is a "¿y...?" back-reference, so the worried line wasn't ignored; the trip to see
  // her sister got a reply that picks up none of it.
  assert.deepEqual(hooks.missedBids, [{ turnId: 3, replyTurnId: 4, cue: 'Guadalajara' }]);
  assert.ok(hooks.topics.some(t => t.term === 'Guadalajara'));
});

test('"la mañana" means morning, and past-tense weekday mentions are not events', () => {
  const hooks = extractHooks(lines([
    ['B', 'Trabajo en el jardín por la mañana.'],
    ['B', 'Church on Sunday was lovely, and the neighbors came for dinner.'],
    ['B', 'Last week I had my interview, it went fine.'],
  ]), 'A');
  assert.deepEqual(hooks.events, []);
});

test('events and commitments cap at 3 and trim long sentences to 90 chars', () => {
  const long = 'Tomorrow I am finally driving up to the lake house with my cousins and their three dogs and a car full of camping gear for the week';
  const turns = lines([
    ['B', long], ['B', 'Next week is my exam.'], ['B', 'I have a wedding on Saturday.'], ['B', 'Mañana trabajo.'],
    ['A', "I'll text you."], ['A', 'I will call you.'], ['A', 'Let me send you the link.'], ['A', 'Remind me later.'],
  ]);
  const hooks = extractHooks(turns, 'A');
  assert.equal(hooks.events.length, 3);
  assert.equal(hooks.commitments.length, 3);
  assert.ok(hooks.events[0].text.length <= 90);
  assert.equal(hooks.events[0].when, 'tomorrow');
  assert.match(hooks.events[0].text, /^Tomorrow/);
  assert.match(hooks.events[0].text, /…$/);
});

test('a long turn answered on-topic is not a missed bid', () => {
  const turns = lines([
    ['B', 'My sister finally got the job at the hospital after two years of applying everywhere in the city.'],
    ['A', 'That is huge, which hospital is it?'],
    ['B', 'I feel worried about the surgery.'],
    ['A', 'Anyway, did you watch the game?'],
  ]);
  const hooks = extractHooks(turns, 'A');
  assert.deepEqual(hooks.missedBids.map(b => [b.turnId, b.replyTurnId]), [[3, 4]]);
  assert.equal(hooks.missedBids[0].cue, 'surgery', '"worried" is an -ed form, so it is skipped as a cue');
});

test('empty, one-turn, unknown speakers and missing text do not throw', () => {
  const empty = extractHooks([], 'A');
  assert.deepEqual(empty, { topics: [], events: [], commitments: [], missedBids: [], highlights: [], followUpDetector: [], awkward: { flags: [], score: 0, seams: [], worst: null } });
  assert.deepEqual(extractHooks(undefined, 'A'), empty);
  assert.deepEqual(extractHooks([null, 'junk'], 'A'), empty);

  const one = extractHooks(lines([['A', 'Hello?']]), 'A');
  assert.deepEqual(one.followUpDetector, [{ turnId: 1, isFollowUp: false, overlap: [] }]);

  // 'unknown' is treated as the other person, like rules.js does.
  const hooks = extractHooks([
    { turnId: 1, speaker: 'unknown', text: 'I have my exam tomorrow morning in Boston.' },
    { turnId: 2, speaker: 'A' },
    { turnId: 3, speaker: 'A', text: 'How did the exam prep go?' },
  ], 'A');
  assert.equal(hooks.events[0].turnId, 1);
  assert.deepEqual(hooks.followUpDetector, [{ turnId: 3, isFollowUp: true, overlap: ['exam'] }]);
});

// --- compare ----------------------------------------------------------------

const conv = (over = {}) => ({
  id: 'c', createdAt: '2026-10-20T10:00:00.000Z', otherName: 'Priya', userLabel: 'A', turns: [],
  signals: { followUps: 1, userQuestions: 3, storiesAfterQuestions: 1, userTalkShare: 0.7 },
  hooks: { missedBids: [{}, {}] },
  note: null,
  ...over,
});

const metric = (cmp, key) => cmp.metrics.find(m => m.key === key);

test('compare with no previous conversation', () => {
  assert.deepEqual(compareConversations(null, conv()), {
    previousId: null, previousAt: null, samePerson: false, metrics: [], suggestion: null,
  });
});

test('compare: metric order and better/worse semantics', () => {
  const before = conv({ id: 'old' });
  const after = conv({
    id: 'new', otherName: ' priya ',
    signals: { followUps: 3, userQuestions: 2, storiesAfterQuestions: 1, userTalkShare: 0.45 },
    hooks: { missedBids: [] },
  });
  const cmp = compareConversations(before, after);
  assert.equal(cmp.previousId, 'old');
  assert.equal(cmp.previousAt, before.createdAt);
  assert.equal(cmp.samePerson, true);
  assert.deepEqual(cmp.metrics.map(m => m.key), ['followUps', 'userQuestions', 'storiesAfterQuestions', 'userTalkShare', 'missedBids']);
  assert.deepEqual(metric(cmp, 'followUps'), { key: 'followUps', label: 'Follow-up questions', before: 1, after: 3, delta: 2, better: true });
  assert.equal(metric(cmp, 'userQuestions').better, false);
  assert.equal(metric(cmp, 'storiesAfterQuestions').better, null, 'equal is neither');
  assert.equal(metric(cmp, 'storiesAfterQuestions').delta, 0);
  assert.equal(metric(cmp, 'userTalkShare').delta, -0.25);
  assert.equal(metric(cmp, 'userTalkShare').better, true);
  assert.equal(metric(cmp, 'missedBids').better, true, 'fewer missed bids is better');
  for (const m of cmp.metrics) assert.equal(typeof m.label, 'string');
});

test('compare: talk share is judged by distance from 0.5', () => {
  const share = (b, a) => metric(compareConversations(conv({ signals: { userTalkShare: b } }), conv({ signals: { userTalkShare: a } })), 'userTalkShare');
  assert.equal(share(0.3, 0.6).better, true);
  assert.equal(share(0.5, 0.3).better, false);
  assert.equal(share(0.4, 0.6).better, null, 'same distance either side');
  assert.equal(share(0.2, 0.2).better, null);
});

test('compare: nulls on either side give null delta and better', () => {
  const before = conv({ signals: { userQuestions: 2, followUps: null, storiesAfterQuestions: null }, hooks: null, turns: [] });
  const after = conv({ otherName: 'Sam', signals: { userQuestions: 4, followUps: 2, storiesAfterQuestions: 1 } });
  const cmp = compareConversations(before, after);
  assert.equal(cmp.samePerson, false);
  for (const key of ['followUps', 'storiesAfterQuestions', 'missedBids']) {
    assert.equal(metric(cmp, key).before, null, key);
    assert.equal(metric(cmp, key).delta, null, key);
    assert.equal(metric(cmp, key).better, null, key);
  }
  assert.equal(metric(cmp, 'userQuestions').better, true);
});

test('compare falls back to the turns when signals and hooks are missing', () => {
  const before = { id: 'x', userLabel: 'A', turns: networking };
  const after = { id: 'y', userLabel: 'A', turns: demoTurns().map((t, i) => ({ ...t, startMs: i * 1000, endMs: i * 1000 + 500 })) };
  const cmp = compareConversations(before, after);
  assert.equal(metric(cmp, 'followUps').before, 0);
  assert.equal(metric(cmp, 'followUps').after, 3);
  assert.equal(metric(cmp, 'userQuestions').before, 2);
  assert.equal(metric(cmp, 'missedBids').before, 1);
  assert.equal(metric(cmp, 'missedBids').after, 0);
  assert.equal(metric(cmp, 'missedBids').better, true);
  assert.equal(metric(cmp, 'userTalkShare').after, 0.5);
  assert.equal(cmp.samePerson, false, 'no names at all');
});

test('suggestion followed when a later question picks up its specific words', () => {
  const before = conv({ note: { status: 'shown', suggestion: 'Next call, try asking about the mole she mentioned.' } });
  const after = conv({
    turns: lines([
      ['A', 'Did you call your sister?'],
      ['B', 'Yes, yesterday.'],
      ['A', 'How do you make the mole, step by step?'],
    ]),
  });
  assert.deepEqual(compareConversations(before, after).suggestion, {
    text: 'Next call, try asking about the mole she mentioned.', followed: true, evidenceTurnId: 3,
  });
});

test('suggestion not followed when only generic words match', () => {
  const before = conv({ note: { status: 'rewritten', suggestion: 'Next time, try asking a follow-up question.' } });
  const after = conv({ turns: lines([['A', 'Can I ask you a question next time?']]) });
  assert.deepEqual(compareConversations(before, after).suggestion, {
    text: 'Next time, try asking a follow-up question.', followed: false, evidenceTurnId: null,
  });
});

test('seed: Abuela suggestion about the mole was not followed in the second call', () => {
  const [first, second] = SEED_CONVERSATIONS;
  const cmp = compareConversations(first, second);
  assert.equal(cmp.samePerson, true);
  assert.equal(cmp.suggestion.followed, false);
  assert.equal(metric(cmp, 'followUps').better, true);
});

test('suggestion is null for dropped or missing notes', () => {
  assert.equal(compareConversations(conv({ note: { status: 'dropped', suggestion: null } }), conv()).suggestion, null);
  assert.equal(compareConversations(conv({ note: { status: 'shown', suggestion: '' } }), conv()).suggestion, null);
  assert.equal(compareConversations(conv(), conv()).suggestion, null);
});

// --- brief ------------------------------------------------------------------

test('brief: kind order, quoting, and the 4-item limit', () => {
  const older = { id: 'c1', createdAt: '2026-10-01T00:00:00Z', userLabel: 'A', turns: demoTurns(), note: null };
  const latest = {
    id: 'c2', createdAt: '2026-10-10T00:00:00Z', userLabel: 'A', turns: networking,
    note: { status: 'shown', suggestion: 'Next time, ask how the interview prep is going.' },
  };
  const brief = buildBrief({ otherName: 'Priya', conversations: [older, latest] });
  assert.equal(brief.otherName, 'Priya');
  assert.equal(brief.lastMetAt, '2026-10-10T00:00:00Z');
  assert.equal(brief.conversations, 2);
  assert.deepEqual(brief.items.map(i => i.kind), ['commitment', 'event', 'topic', 'suggestion']);
  assert.equal(brief.items[0].text, "Follow through: you said “I'll send you the article tonight about system design.”");
  assert.equal(brief.items[0].turnId, 5);
  assert.match(brief.items[1].text, /^Ask how it went: “Honestly I have my Meta interview next Friday/);
  // Meta is already in the event, so the topic moves on to something else.
  assert.doesNotMatch(brief.items[2].text, /Meta/);
  assert.match(brief.items[2].text, /^They opened up about .+\. Bring it up again\.$/);
  assert.deepEqual(brief.items[3], { kind: 'suggestion', text: 'Next time, ask how the interview prep is going.', conversationId: 'c2', turnId: null });
  for (const item of brief.items) assert.equal(item.conversationId, 'c2');
});

test('brief: limit holds with lots of commitments and events', () => {
  const busy = {
    id: 'b', createdAt: '2026-10-11T00:00:00Z', userLabel: 'A',
    turns: lines([
      ['B', 'Tomorrow is my exam.'], ['B', 'Next week I fly out.'], ['B', 'Mañana hay boda.'],
      ['A', "I'll text you."], ['A', 'I will call you.'], ['A', 'Let me send you the link.'],
    ]),
    note: { status: 'shown', suggestion: 'Ask about the trip.' },
  };
  const brief = buildBrief({ otherName: 'Sam', conversations: [busy] });
  assert.equal(brief.items.length, 4);
  assert.deepEqual(brief.items.map(i => i.kind), ['commitment', 'commitment', 'event', 'event']);
});

test('brief: older conversations supply the topic and suggestion when the latest is thin', () => {
  const [first, second] = SEED_CONVERSATIONS;
  const thin = { id: 'c3', createdAt: '2026-10-23T00:00:00Z', userLabel: 'A', turns: lines([['A', 'Hola!'], ['B', 'Hola mija.']]), note: null };
  const brief = buildBrief({ otherName: 'Abuela', conversations: [first, second, thin] });
  assert.deepEqual(brief.items.map(i => i.kind), ['topic', 'suggestion']);
  assert.equal(brief.lastMetAt, thin.createdAt);
  assert.equal(brief.items[1].text, second.note.suggestion);
});

test('brief: uses stored hooks when present and dedupes repeated text', () => {
  const hooks = {
    topics: [], events: [{ text: 'my trip', when: 'soon', turnId: 2 }, { text: 'my trip', when: 'soon', turnId: 4 }],
    commitments: [], missedBids: [], highlights: [], followUpDetector: [],
  };
  const brief = buildBrief({ otherName: 'Lee', conversations: [{ id: 'h', createdAt: 'x', hooks, turns: [] }] });
  assert.deepEqual(brief.items, [{ kind: 'event', text: 'Ask how it went: “my trip”', conversationId: 'h', turnId: 2 }]);
});

test('brief is null when there is nothing to say', () => {
  assert.equal(buildBrief({ otherName: 'X', conversations: [] }), null);
  assert.equal(buildBrief({}), null);
  assert.equal(buildBrief(), null);
  assert.equal(buildBrief({ otherName: 'X', conversations: [{ id: 'e', userLabel: 'A', turns: [] }] }), null);
  assert.equal(buildBrief({ otherName: 'X', conversations: [{ id: 'd', turns: [], note: { status: 'dropped', suggestion: 'x' } }] }), null);
});

// --- false positives from realistic transcripts ------------------------------

const userSays = text => extractHooks(lines([['A', text]]), 'A').commitments;
const theySay = text => extractHooks(lines([['B', text]]), 'A').events;

test('commitments need an action verb after "I\'ll"', () => {
  for (const line of [
    "I'll be honest, I'm not sure.", "I'll have the salmon.", "I'll be right back", "I'll think about it",
    'i will never forget that', "I will say, that's wild", "I'll probably just stay home",
    'Remind me what your startup does?', 'Remind me later.', "I'll send you the deck?",
  ]) assert.deepEqual(userSays(line), [], line);

  assert.deepEqual(userSays('ill text you tomorrow'), [{ text: 'ill text you tomorrow', turnId: 1 }]);
  assert.equal(userSays("I'll definitely get back to you on that.").length, 1);
  assert.equal(userSays('Remind me to send you the link.').length, 1);
  assert.equal(userSays('Let me introduce you to my manager.').length, 1);
  assert.deepEqual(userSays("Yeah, um, I'll email you the slides."), [{ text: "I'll email you the slides.", turnId: 1 }]);
});

test('"me" and "mi" alone are not self-disclosure; "me siento" is', () => {
  const pass = extractHooks(lines([['B', 'Can you pass me the salt please'], ['A', 'Sure, here.']]), 'A');
  assert.deepEqual(pass.missedBids, []);
  const mi = extractHooks(lines([['B', 'Mi coche está afuera.'], ['A', 'Okay.']]), 'A');
  assert.deepEqual(mi.missedBids, []);
  const siento = extractHooks(lines([['B', 'Me siento sola en la ciudad.'], ['A', '¿Viste el partido?']]), 'A');
  assert.deepEqual(siento.missedBids.map(b => b.turnId), [1]);
  assert.equal(siento.missedBids[0].cue, 'ciudad');
});

test('a bid whose only words are fillers or adverbs is skipped rather than given an empty cue', () => {
  const h = extractHooks(lines([['B', 'Honestly I dunno, I feel kinda weird.'], ['A', 'Nice weather huh']]), 'A');
  assert.ok(h.missedBids.every(b => b.cue), JSON.stringify(h.missedBids));
  assert.ok(!h.missedBids.some(b => ['honestly', 'dunno', 'kinda'].includes(b.cue)));
});

test('junk words, -ly adverbs and -ed/-ing forms never become topics, but still overlap', () => {
  const turns = lines([
    ['B', 'Honestly people at work are super busy, working crazy hours on the robot, kinda stuff you dunno about.'],
    ['A', 'Sounds rough.'],
    ['B', 'Honestly people at work are super busy, I basically started running and cooked a lot, really excited about the robot.'],
    ['A', 'You started running?'],
  ]);
  const h = extractHooks(turns, 'A');
  const junk = ['people', 'work', 'working', 'honestly', 'kinda', 'busy', 'super', 'crazy', 'stuff', 'dunno',
    'basically', 'started', 'running', 'cooked', 'excited'];
  for (const t of h.topics) assert.ok(!junk.includes(t.term.toLowerCase()), t.term);
  assert.equal(h.topics[0].term, 'robot');
  assert.deepEqual(h.followUpDetector[0], { turnId: 4, isFollowUp: true, overlap: ['started', 'running'] });
  // Words that only look like verb forms stay.
  const fam = extractHooks(lines([['B', 'My family wedding is in the morning, family first.'], ['A', 'Your family wedding?']]), 'A');
  assert.ok(fam.topics.some(t => t.term === 'family'));
  assert.ok(fam.topics.some(t => t.term === 'wedding'));
});

test('past-tense sentences are never events, strong cues included', () => {
  for (const line of [
    'This weekend was amazing.', 'this saturday was my birthday',
    'Tomorrow was supposed to be my day off but I got called in.', "I'm going to be honest, it was rough.",
  ]) assert.deepEqual(theySay(line), [], line);
});

test('"soon" and bare "going to" / "voy a" are not events without a plan', () => {
  for (const line of [
    'I need to get a haircut soon.', "I'm going to be honest with you.", "I'm gonna grab a coffee.",
    'Voy a pensarlo.', 'Pronto, ya veremos.',
  ]) assert.deepEqual(theySay(line), [], line);

  assert.deepEqual(theySay("I'm going to visit my parents."), [{ text: "I'm going to visit my parents.", when: "i'm going to", hasNoun: false, turnId: 1 }]);
  assert.equal(theySay("We're going to Austin for the conference.")[0].hasNoun, true);
  assert.equal(theySay('Voy a viajar con mi hermana.')[0].when, 'voy a');
  assert.equal(theySay('Vamos a Guadalajara.')[0].when, 'vamos a');
});

test('habits are not events: "every Sunday"', () => {
  assert.deepEqual(theySay('We go to church every Sunday, this Sunday too.'), []);
  assert.deepEqual(theySay('Todos los domingos vamos al mercado, el domingo también.'), []);
  assert.equal(theySay('Church is on Sunday.')[0].when, 'on sunday');
});

test('events: lowercase when, hasNoun, fillers trimmed', () => {
  assert.deepEqual(theySay('Yeah, um, so I have my Meta interview next Friday.'), [
    { text: 'I have my Meta interview next Friday.', when: 'next friday', hasNoun: true, turnId: 1 },
  ]);
  assert.deepEqual(theySay('Bueno, pues mañana tengo la entrevista.'), [
    { text: 'Mañana tengo la entrevista.', when: 'mañana', hasNoun: true, turnId: 1 },
  ]);
  assert.equal(theySay('Tomorrow I am free.')[0].hasNoun, false);
});

test('generic openers after an unrelated story are not follow-ups', () => {
  const story = 'My grandmother raised chickens on a farm near Guadalajara for forty years.';
  for (const q of ['so where are you from?', 'is it cold outside?', 'and what do you do for fun?']) {
    const det = detectFollowUps(lines([['B', story], ['A', q]]), 'A');
    assert.deepEqual(det, [{ turnId: 2, isFollowUp: false, overlap: [] }], q);
  }
  // The explicit back-references still work.
  for (const q of ['Wait, how did that happen?', 'Really?', 'What happened next?', '¿Y eso?']) {
    assert.equal(detectFollowUps(lines([['B', story], ['A', q]]), 'A')[0].isFollowUp, true, q);
  }
});

test('isQuestion: punctuation first, question-word openers for unpunctuated ASR', () => {
  assert.equal(isQuestion('Where are you from?'), true);
  assert.equal(isQuestion('¿Dónde vives'), true);
  assert.equal(isQuestion('so what do you do'), true);
  assert.equal(isQuestion('um uh how was the trip'), true);
  assert.equal(isQuestion('y tú qué haces'), true);
  assert.equal(isQuestion('por qué te mudaste'), true);
  assert.equal(isQuestion('did you see the game'), true);
  assert.equal(isQuestion('What a day.'), false, 'punctuated and no question mark');
  assert.equal(isQuestion('I went to the store'), false);
  assert.equal(isQuestion('whatever man'), false);
  assert.equal(isQuestion(''), false);
  assert.equal(isQuestion(null), false);

  // ...and the detector picks those up.
  const det = detectFollowUps(lines([['B', 'We drove to Marfa last week.'], ['A', 'how was marfa']]), 'A');
  assert.deepEqual(det, [{ turnId: 2, isFollowUp: true, overlap: ['marfa'] }]);
});

test('stripFillers drops leading fillers and recapitalizes', () => {
  assert.equal(stripFillers('yeah um so I will'), 'I will');
  assert.equal(stripFillers('Bueno, pues mañana'), 'Mañana');
  assert.equal(stripFillers('Likewise, thanks'), 'Likewise, thanks');
  assert.equal(stripFillers('um'), 'um', 'nothing left, so keep it');
  assert.equal(stripFillers('Este fin de semana'), 'Este fin de semana');
});

// Straight from a live Muse transcript at HackTX, fillers and all.
const intro = [
  { turnId: 0, speaker: 'A', text: "Hi, what's your name?" },
  { turnId: 1, speaker: 'B', text: "Hi, my I'm Priya." },
  { turnId: 2, speaker: 'A', text: "Oh nice to meet you I'm Parth." },
  { turnId: 3, speaker: 'B', text: 'Nice to meet you too.' },
  { turnId: 4, speaker: 'A', text: 'Yeah yeah uh uh so what do you do?' },
  { turnId: 5, speaker: 'B', text: "I'm a sophomore studying at UT Austin majoring in data science." },
  { turnId: 6, speaker: 'A', text: 'Oh cool. Um' },
  { turnId: 7, speaker: 'B', text: 'What about you?' },
  { turnId: 8, speaker: 'A', text: 'Um I am not I I do CS at UTD.' },
];

test('introductions: names and small talk are not topics', () => {
  const h = extractHooks(intro, 'A', { otherName: 'Priya' });
  const terms = h.topics.map(t => t.term.toLowerCase());
  for (const junk of ['priya', 'parth', 'meet', 'nice']) assert.ok(!terms.includes(junk), junk);
  assert.ok(terms.includes('austin'));
});

test('"Oh cool. Um" after they say who they are is a missed bid; answering their question is not', () => {
  const h = extractHooks(intro, 'A', { otherName: 'Priya' });
  assert.deepEqual(h.missedBids.map(b => [b.turnId, b.replyTurnId]), [[5, 6]]);
});
