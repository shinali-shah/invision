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
