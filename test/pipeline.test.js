import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/db.js';
import { createLogger } from '../src/log.js';
import { createLlm } from '../src/llm.js';
import { processConversation, recoach, refreshMemory } from '../src/pipeline.js';
import { seedDemo } from '../src/seed.js';
import { createTurnAssembler } from '../src/transcribe/assemble.js';
import { DEMO_EVENTS } from '../src/mock/demoConversation.js';

function demoTurns() {
  const asm = createTurnAssembler();
  for (const e of DEMO_EVENTS) asm.push(e);
  return asm.flush();
}

function setup({ llm = createLlm({ mock: true }) } = {}) {
  const store = openStore();
  const log = createLogger(store, { quiet: true });
  return { store, llm, log };
}

function liveConversation(store, turns = demoTurns()) {
  const c = store.createConversation({ tag: 'family', otherName: 'Abuela' });
  store.updateConversation(c.id, { turns, userLabel: 'A' });
  return c.id;
}

const brokenLlm = { mock: false, json: async () => { throw new Error('muse down'); } };

test('happy path: signals from Muse Spark, a reviewed note, then pattern 1 -> 3 and a next step', async () => {
  const deps = setup();
  seedDemo(deps.store);
  seedDemo(deps.store); // idempotent
  assert.equal(deps.store.listConversations().length, 2);

  const id = liveConversation(deps.store);
  const c = await processConversation({ ...deps, id, reflection: 'I talked too much at the start' });

  assert.equal(c.reflection, 'I talked too much at the start');
  assert.equal(c.signals.source, 'muse-spark');
  assert.equal(c.signals.followUps, 3);
  assert.ok(['shown', 'rewritten'].includes(c.note.status), c.note.status);
  assert.match(c.note.text, /^You/);

  const pattern = deps.store.getKv('pattern');
  assert.equal(pattern.metric, 'followUps');
  assert.deepEqual(pattern.counts, [1, 2, 3]);
  assert.equal(deps.store.latestNextStep().status, 'proposed');
});

test('every Muse call failing still finishes with rule counts and a dropped note (Review Focus 2)', async () => {
  const deps = setup({ llm: brokenLlm });
  const id = liveConversation(deps.store);
  const c = await processConversation({ ...deps, id, reflection: '' });

  assert.equal(c.signals.source, 'rules-only');
  assert.equal(c.signals.userQuestions, 4);
  assert.equal(c.note.status, 'dropped');
  assert.ok(deps.store.listLogs().some(l => l.level === 'warn'));
  // No model, but the lexical detector still counts follow-ups and the template still drafts a message
  assert.ok(Number.isInteger(c.signals.followUps) && c.signals.followUps >= 2);
  assert.ok(c.hooks.topics.length > 0);
  assert.equal(c.followUp.source, 'template');
});

test('with Muse up, the detector cross-checks it and the agreement is logged', async () => {
  const deps = setup();
  const id = liveConversation(deps.store);
  const c = await processConversation({ ...deps, id, reflection: '' });
  assert.equal(c.signals.detectorAgreement.of, 4);
  assert.ok(deps.store.listLogs().some(l => /detector agrees with Muse Spark on \d of 4/.test(l.message)));
  assert.equal(c.followUp.source, 'muse-spark');
  assert.equal(c.followUp.status, 'draft');
});

test('a one-turn recording is too short to coach (Review Focus 3)', async () => {
  const deps = setup();
  const id = liveConversation(deps.store, demoTurns().slice(0, 1));
  const c = await processConversation({ ...deps, id, reflection: '' });
  assert.equal(c.note.status, 'dropped');
  assert.equal(c.note.reason, 'too_short');
  assert.ok(c.signals);
});

test('coaching a conversation that was deleted meanwhile returns null instead of throwing', async () => {
  const { store, llm, log } = setup();
  assert.equal(await processConversation({ store, llm, log, id: 'gone', reflection: '' }), null);
  assert.equal(await recoach({ store, llm, log, id: 'gone', tag: 'friend' }), null);
  // deleted after the tap landed but before the note was written
  const id = liveConversation(store);
  const slow = { mock: true, json: async args => { store.deleteConversation(id); return llm.json(args); } };
  assert.equal(await processConversation({ store, llm: slow, log, id, reflection: '' }), null);
  assert.equal(store.getConversation(id), null);
});

test('recoach switches the tag and rewrites the note without reclassifying', async () => {
  const deps = setup();
  const id = liveConversation(deps.store);
  const before = await processConversation({ ...deps, id, reflection: '' });

  let classifyCalls = 0;
  const counting = { ...deps.llm, json: args => { if (args.name === 'classify') classifyCalls++; return deps.llm.json(args); } };
  const after = await recoach({ ...deps, llm: counting, id, tag: 'networking' });

  assert.equal(after.tag, 'networking');
  assert.equal(classifyCalls, 0);
  assert.deepEqual(after.signals, before.signals);
  assert.notEqual(after.note.suggestion, before.note.suggestion);
});

test('deleting a conversation drops it from memory and recent notes (Review Focus 5)', async () => {
  const deps = setup();
  seedDemo(deps.store);
  const id = liveConversation(deps.store);
  await processConversation({ ...deps, id, reflection: '' });
  assert.ok(deps.store.getKv('pattern'));

  deps.store.deleteConversation(id);
  const { pattern } = await refreshMemory(deps);
  assert.equal(pattern, null);
  assert.equal(deps.store.getKv('pattern'), null);
  assert.equal(deps.store.recentNotes(10).length, 2);
});

// ---- concurrency: follow-up and memory run alongside coaching ----

const slow = base => ({ mock: true, json: async args => { await new Promise(r => setTimeout(r, 15)); return base.json(args); } });

test('two /process calls on the same conversation propose one next step, not two', async () => {
  const deps = setup({ llm: slow(createLlm({ mock: true })) });
  seedDemo(deps.store);
  const id = liveConversation(deps.store);
  await Promise.all([processConversation({ ...deps, id, reflection: '' }), processConversation({ ...deps, id, reflection: '' })]);
  assert.equal(deps.store.listLogs().filter(l => l.agent === 'nextStep').length, 1);
  assert.equal(deps.store.latestNextStep().id, 1);
});

test('a follow-up the user edited or sent while coaching ran is not overwritten by the draft', async () => {
  const deps = setup();
  const id = liveConversation(deps.store);
  const base = createLlm({ mock: true });
  const edited = { text: 'my own words', hooksUsed: [], source: 'edited', status: 'draft', sentAt: null };
  const editing = { mock: true, json: async args => {
    if (args.name === 'coach') deps.store.updateConversation(id, { followUp: edited });
    return base.json(args);
  } };
  const c = await processConversation({ ...deps, llm: editing, id, reflection: '' });
  assert.equal(c.followUp.source, 'edited');
  assert.equal(c.followUp.text, 'my own words');
  assert.ok(['shown', 'rewritten'].includes(c.note.status));
});

test('a tag change that lands while coaching runs is what the note is coached for', async () => {
  const deps = setup();
  const id = liveConversation(deps.store);
  const base = createLlm({ mock: true });
  let coachedAs = null;
  const retagging = { mock: true, json: async args => {
    if (args.name === 'classify') deps.store.updateConversation(id, { tag: 'networking' });
    if (args.name === 'coach') coachedAs = args.user.tag;
    return base.json(args);
  } };
  const c = await processConversation({ ...deps, llm: retagging, id, reflection: '' });
  assert.equal(c.tag, 'networking');
  assert.equal(coachedAs, 'networking');
});

// ---- lip lock: crowd lines stay in the transcript but out of the analysis ----

test('crowd turns are excluded from signals, hooks and the coach prompt, and counted', async () => {
  const deps = setup();
  const base = createLlm({ mock: true });
  const seen = {};
  const spying = { mock: true, json: async args => { seen[args.name] = args.user; return base.json(args); } };
  const turns = demoTurns().map(t => ({ ...t, source: t.speaker === 'A' ? 'you' : 'them' }));
  const bystander = { turnId: 99, speaker: 'C', text: 'Hey can we get the bill over here please? The chess tournament is starting.', startMs: 15000, endMs: 17000, source: 'crowd' };
  const id = liveConversation(deps.store, [...turns.slice(0, 4), bystander, ...turns.slice(4)]);
  const clean = await processConversation({ ...deps, id: liveConversation(deps.store, turns), reflection: '' });
  const c = await processConversation({ ...deps, llm: spying, id, reflection: '' });

  assert.equal(c.signals.crowd, 1);
  assert.equal(clean.signals.crowd, 0);
  assert.equal(c.signals.otherTurns, clean.signals.otherTurns);
  assert.equal(c.turns.length, turns.length + 1); // still in the transcript, flagged
  assert.equal(c.turns.find(t => t.turnId === 99).source, 'crowd');
  assert.ok(!c.hooks.topics.some(t => /chess|bill/i.test(t.term)), JSON.stringify(c.hooks.topics));
  assert.ok(!seen.coach.turns.some(t => t.turnId === 99), 'coach never sees the bystander');
  assert.ok(!seen.classify.turns.some(t => t.turnId === 99), 'classify never sees the bystander');
});

test('recoaching a recording that was all bystanders keeps the too_short note', async () => {
  const deps = setup();
  const id = liveConversation(deps.store, demoTurns().map(t => ({ ...t, source: 'crowd' })));
  const c = await processConversation({ ...deps, id, reflection: '' });
  assert.equal(c.note.reason, 'too_short');
  const again = await recoach({ ...deps, id, tag: 'networking' });
  assert.equal(again.tag, 'networking');
  assert.equal(again.note.reason, 'too_short'); // eight raw turns, none of them a conversation
});
