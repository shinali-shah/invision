import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftFollowUp, templateFollowUp, groundedIn } from '../src/agents/followUp.js';
import responders from '../src/mock/responders.js';

const hooks = {
  topics: [{ term: 'robotics', turnIds: [2], weight: 3 }],
  events: [{ text: 'my Meta interview next Friday', when: 'next friday', hasNoun: true, turnId: 4 }],
  commitments: [{ text: "I'll send you the article tonight", turnId: 5 }],
  missedBids: [],
  highlights: [],
  followUpDetector: [],
};

const turns = [
  { turnId: 1, speaker: 'A', text: 'What are you working on?' },
  { turnId: 2, speaker: 'B', text: 'A robotics arm for the hackathon.' },
];

const llmReturning = reply => ({ calls: [], async json(args) { this.calls.push(args); if (reply instanceof Error) throw reply; return reply; } });

test('a grounded Muse draft is kept, and hooksUsed comes from the text, not the model', async () => {
  const llm = llmReturning({ text: 'Hey Priya! Good luck with the interview next Friday, and the robotics arm looked great.', hooksUsed: ['made up'] });
  const out = await draftFollowUp({ llm, tag: 'networking', otherName: 'Priya', hooks, turns, userLabel: 'A' });
  assert.equal(out.source, 'muse-spark');
  assert.deepEqual(out.hooksUsed.sort(), ['next friday', 'robotics'].sort());
  const sent = llm.calls[0].user;
  assert.equal(sent.otherName, 'Priya');
  assert.deepEqual(sent.turns[0], { speaker: 'you', text: 'What are you working on?' });
  assert.equal('missedBids' in sent.hooks, false);
});

test('a generic draft that mentions no hook falls back to the template', async () => {
  const llm = llmReturning({ text: 'Great chatting with you! Let’s stay in touch.', hooksUsed: [] });
  const out = await draftFollowUp({ llm, tag: 'networking', otherName: 'Priya', hooks, turns, userLabel: 'A' });
  assert.equal(out.source, 'template');
  assert.ok(out.hooksUsed.length > 0);
  assert.match(out.text, /robotics/);
});

test('Muse failures and oversized drafts fall back to the template', async () => {
  for (const llm of [llmReturning(new Error('down')), llmReturning({ text: 'robotics '.repeat(60), hooksUsed: [] })]) {
    const out = await draftFollowUp({ llm, tag: 'friend', otherName: 'them', hooks, turns, userLabel: 'A' });
    assert.equal(out.source, 'template');
    assert.ok(out.text.length <= 320);
  }
});

test('template names the person, the topic, the event timing and the promise', () => {
  const out = templateFollowUp({ hooks, otherName: 'Priya Shah', tag: 'networking' });
  assert.match(out.text, /^Hi Priya!/);
  assert.match(out.text, /robotics/);
  assert.match(out.text, /Good luck next friday!/);
  assert.match(out.text, /Like I said: I'll send you the article tonight\./);
  assert.equal(out.hooksUsed.length, 3);
});

test('template copes with no hooks and no name', () => {
  const out = templateFollowUp({ hooks: null, otherName: 'them', tag: 'family' });
  assert.match(out.text, /^Hi! Loved talking with you today\.$/);
  assert.deepEqual(out.hooksUsed, []);
});

test('with nothing to ground on, any reasonable Muse draft is accepted', async () => {
  const empty = { topics: [], events: [], commitments: [] };
  const out = await draftFollowUp({ llm: llmReturning({ text: 'Thanks for the chat today!', hooksUsed: [] }), tag: 'friend', otherName: 'Sam', hooks: empty, turns, userLabel: 'A' });
  assert.equal(out.source, 'muse-spark');
});

test('groundedIn matches on content words, ignoring case and plurals', () => {
  assert.deepEqual(groundedIn('Hope the ROBOTICS demo went well', hooks), ['robotics']);
  assert.deepEqual(groundedIn('Thanks again!', hooks), []);
});

test('mock responder drafts something the validator accepts', async () => {
  const out = responders.followUp({ otherName: 'Priya', hooks, tag: 'networking' });
  assert.ok(groundedIn(out.text, hooks).length >= 2);
});

test('event lines: luck for real events, "talk" otherwise, Spanish stays Spanish', async () => {
  const { eventLine } = await import('../src/agents/followUp.js');
  assert.equal(eventLine({ when: 'next friday', hasNoun: true }), 'Good luck next friday!');
  assert.equal(eventLine({ when: 'tomorrow', hasNoun: false }), 'Talk tomorrow!');
  assert.equal(eventLine({ when: 'el domingo', hasNoun: false }), '¡Hablamos el domingo!');
  assert.equal(eventLine({ when: '', hasNoun: false }), 'Talk soon!');
});

test('a Muse draft that quotes something they said counts as grounded', async () => {
  const story = [
    { turnId: 1, speaker: 'B', text: 'Una vez una cabra se comió todo el maíz. Pancha, se llamaba.' },
    { turnId: 2, speaker: 'A', text: '¡Qué risa!' },
  ];
  const llm = llmReturning({ text: 'Abuela, still laughing about Pancha. Talk Sunday!', hooksUsed: [] });
  const out = await draftFollowUp({ llm, tag: 'family', otherName: 'Abuela', hooks, turns: story, userLabel: 'A' });
  assert.equal(out.source, 'muse-spark');
});

test('a draft that repeats your own flagged line (the rumour, "just bored") is thrown out', async () => {
  // Live Muse draft for a chat whose only topic was a rumour: nothing to ground on, so it was accepted.
  const bare = { topics: [], events: [], commitments: [], missedBids: [], highlights: [], followUpDetector: [],
    awkward: { flags: [
      { turnId: 5, who: 'you', kind: 'gossip', label: 'Gossip about someone else', evidence: '“cheated on her”: a story about someone who isn\'t here', weight: 4 },
      { turnId: 8, who: 'you', kind: 'undersell', label: 'Undersold yourself', evidence: '“just bored” is what they\'ll remember about you', weight: 2 },
    ], score: 60, seams: [], worst: null } };
  const chat = [
    { turnId: 4, speaker: 'A', text: 'Wait, what do you do right now?' },
    { turnId: 5, speaker: 'B', text: "Um I'm a wait aren't you the roommate that the girl cheated on her boyfriend with from Purdue?" },
    { turnId: 8, speaker: 'A', text: "I do CS at UTD but I'm low-key just bored" },
  ];
  for (const text of [
    "Hey Shanali, nice meeting you. I'm usually bored doing CS at UTD so hit me up if you wanna chat again.",
    "Still laughing about that Purdue cheating story. Let's chat again!",
  ]) {
    const llm = llmReturning({ text, hooksUsed: [] });
    const out = await draftFollowUp({ llm, tag: 'friend', otherName: 'Shanali', hooks: bare, turns: chat, userLabel: 'A' });
    assert.equal(out.source, 'template', text);
    assert.doesNotMatch(out.text, /bored|cheat|Purdue/i);
    // ...and the model was told what to stay away from.
    assert.deepEqual(llm.calls[0].user.avoid, ['cheated on her', 'just bored']);
  }
  const fine = await draftFollowUp({ llm: llmReturning({ text: 'Hey Shanali, nice meeting you today. Good luck with the semester!', hooksUsed: [] }), tag: 'friend', otherName: 'Shanali', hooks: bare, turns: chat, userLabel: 'A' });
  assert.equal(fine.source, 'muse-spark');
});
