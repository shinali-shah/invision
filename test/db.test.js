import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openStore } from '../src/db.js';

const require = createRequire(import.meta.url);

const turns = [{ turnId: 1, speaker: 'A', text: 'hola', startMs: 0, endMs: 900 }];

test('conversation round-trips JSON fields', () => {
  const store = openStore();
  const c = store.createConversation({ tag: 'family', otherName: 'Abuela' });
  assert.equal(c.seeded, false);
  assert.equal(c.turns, null);
  store.updateConversation(c.id, { turns, userLabel: 'A', signals: { userQuestions: 2 }, note: { text: 'hi', status: 'shown' } });
  const got = store.getConversation(c.id);
  assert.deepEqual(got.turns, turns);
  assert.equal(got.userLabel, 'A');
  assert.deepEqual(got.signals, { userQuestions: 2 });
  assert.equal(got.note.text, 'hi');
  assert.equal(got.otherName, 'Abuela');
});

test('listConversations is oldest first and delete removes', () => {
  const store = openStore();
  const a = store.createConversation({ tag: 'family', otherName: 'x' });
  const b = store.createConversation({ tag: 'friend', otherName: 'y' });
  store.updateConversation(a.id, { createdAt: '2026-10-20T00:00:00.000Z' });
  store.updateConversation(b.id, { createdAt: '2026-10-18T00:00:00.000Z' });
  assert.deepEqual(store.listConversations().map(c => c.id), [b.id, a.id]);
  assert.equal(store.deleteConversation(a.id), true);
  assert.equal(store.getConversation(a.id), null);
  assert.equal(store.deleteConversation(a.id), false);
});

test('recentNotes skips dropped notes and the excluded id', () => {
  const store = openStore();
  const mk = (text, status, createdAt) => {
    const c = store.createConversation({ tag: 'family', otherName: 'x' });
    store.updateConversation(c.id, { note: { text, status }, createdAt });
    return c.id;
  };
  mk('old', 'shown', '2026-10-01T00:00:00.000Z');
  mk('dropped', 'dropped', '2026-10-02T00:00:00.000Z');
  mk('mid', 'rewritten', '2026-10-03T00:00:00.000Z');
  const newest = mk('new', 'shown', '2026-10-04T00:00:00.000Z');
  assert.deepEqual(store.recentNotes(3), ['new', 'mid', 'old']);
  assert.deepEqual(store.recentNotes(3, newest), ['mid', 'old']);
  assert.deepEqual(store.recentNotes(1), ['new']);
});

test('kv, next steps and logs', () => {
  const store = openStore();
  assert.equal(store.getKv('pattern'), null);
  store.setKv('pattern', { counts: [1, 2, 3] });
  assert.deepEqual(store.getKv('pattern'), { counts: [1, 2, 3] });

  assert.equal(store.latestNextStep(), null);
  const step = store.createNextStep('Ask one follow-up');
  assert.equal(step.status, 'proposed');
  const changed = store.updateNextStep(step.id, { status: 'changed', text: 'Ask two' });
  assert.equal(changed.text, 'Ask two');
  assert.equal(store.latestNextStep().status, 'changed');

  store.addLog({ agent: 'coach', level: 'info', message: 'first' });
  store.addLog({ agent: 'review', level: 'warn', message: 'second', data: { a: 1 } });
  const logs = store.listLogs();
  assert.equal(logs[0].message, 'second');
  assert.deepEqual(logs[0].data, { a: 1 });
  assert.equal(logs[1].data, null);
});

test('the other person can be renamed after the fact', () => {
  const store = openStore(':memory:');
  const c = store.createConversation({ tag: 'friend', otherName: 'them' });
  assert.equal(store.updateConversation(c.id, { otherName: 'Priya' }).otherName, 'Priya');
  assert.equal(store.getConversation(c.id).otherName, 'Priya');
  store.close();
});

test('a database from before names, hooks and video opens and takes the new fields', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const path = join(mkdtempSync(join(require('node:os').tmpdir(), 'playback-old-db-')), 'old.db');
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, tag TEXT NOT NULL, created_at TEXT NOT NULL, seeded INTEGER NOT NULL DEFAULT 0, turns TEXT, user_label TEXT, reflection TEXT, signals TEXT, note TEXT)');
  raw.exec(`INSERT INTO conversations (id, tag, created_at, turns, user_label) VALUES ('old1', 'family', '2026-10-01T00:00:00.000Z', '${JSON.stringify(turns)}', 'A')`);
  raw.close();

  const store = openStore(path);
  const old = store.getConversation('old1');
  assert.equal(old.otherName, 'them');
  assert.deepEqual(old.turns, turns);
  assert.equal(old.hooks, null);
  assert.equal(old.recording, null);
  const updated = store.updateConversation('old1', { otherName: 'Abuela', hooks: { topics: [] }, behavior: { frameCount: 1 }, insight: null, followUp: { text: 'hi' } });
  assert.equal(updated.otherName, 'Abuela');
  assert.deepEqual(updated.hooks, { topics: [] });
  assert.equal(updated.insight, null);
  // the seed insert names the other person, which is what used to fail on a table without the column
  assert.equal(store.createConversation({ tag: 'friend', otherName: 'Sam' }).otherName, 'Sam');
  store.close();
});
