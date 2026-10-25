import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/db.js';
import { buildDemo, exportSnapshot } from '../src/synthetic/build.js';
import { DEMO_CONVERSATIONS, ROTATION } from '../src/synthetic/conversations.js';

// The Home page's rules, restated so the test checks what the calendar and lists will show.
const colour = score => (score < 30 ? 'green' : score < 70 ? 'yellow' : 'red');
const dayKey = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const TODAY = new Date(2026, 9, 25, 9, 0); // the morning after the last conversation
const TASK_DAYS = 4;

async function build() {
  const store = openStore(':memory:');
  const { problems } = await buildDemo({ store });
  return { store, problems, conversations: store.listConversations() };
}

const { store, problems, conversations } = await build();

test('the demo builds with every scenario landing as written', () => {
  assert.deepEqual(problems, []);
});

test('exactly 13 conversations, one a day, Oct 12 through Oct 24, 2026', () => {
  assert.equal(conversations.length, 13);
  conversations.forEach((c, i) => {
    const d = new Date(c.createdAt);
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 9, 12 + i]);
  });
});

test('speakers rotate Prat, Priya, Parth from the first day', () => {
  assert.deepEqual(conversations.map(c => c.otherName), conversations.map((_, i) => ROTATION[i % 3]));
  const count = name => conversations.filter(c => c.otherName === name).length;
  assert.deepEqual([count('Prat'), count('Priya'), count('Parth')], [5, 4, 4]);
});

test('all three calendar colours appear, each day the colour its scenario was written for', () => {
  const colours = conversations.map(c => colour(c.hooks.awkward.score));
  assert.deepEqual(new Set(colours), new Set(['green', 'yellow', 'red']));
  const want = { good: 'green', bumps: 'yellow', rough: 'red' };
  assert.deepEqual(colours, DEMO_CONVERSATIONS.map(s => want[s.mood]));
});

test('every awkward flag that counts toward a colour is the user\'s, never the teammate\'s', () => {
  for (const c of conversations) for (const f of c.hooks.awkward.flags) assert.equal(f.who, 'you', `${c.otherName} ${f.kind}`);
});

test('Pending tasks has at least two promises from the last four days', () => {
  const since = new Date(TODAY);
  since.setDate(since.getDate() - (TASK_DAYS - 1));
  since.setHours(0, 0, 0, 0);
  const recent = conversations.filter(c => new Date(c.createdAt) >= since);
  const drafts = recent.filter(c => c.followUp?.status === 'draft');
  const promises = recent.flatMap(c => c.hooks.commitments);
  assert.ok(drafts.length + promises.length > 0);
  assert.ok(promises.length >= 2, `${promises.length} promises`);
});

test('every number in a coaching note is one of that conversation\'s measured signals', () => {
  const numbers = (v, out = new Set()) => {
    if (typeof v === 'number') out.add(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) numbers(x, out);
    return out;
  };
  for (const c of conversations) {
    const measured = numbers(c.signals);
    const said = `${c.note.text} ${c.note.suggestion ?? ''}`.match(/\d+(?:\.\d+)?/g) ?? [];
    for (const n of said) assert.ok(measured.has(Number(n)), `${c.otherName} ${c.createdAt.slice(0, 10)}: ${n} is not in the signals`);
  }
});

test('the practice streak is 13 days', () => {
  const days = new Set(conversations.map(c => dayKey(new Date(c.createdAt))));
  const d = new Date(TODAY);
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  assert.equal(n, 13);
});

test('every seeded conversation is marked synthetic', () => {
  for (const c of conversations) assert.equal(c.synthetic, true);
  assert.equal(store.getKv('dataset').name, 'synthetic');
});

test('the featured conversations keep their hand-written rewrites', () => {
  for (const spec of DEMO_CONVERSATIONS.filter(s => s.rewrites)) {
    const c = conversations.find(x => new Date(x.createdAt).getDate() === spec.date[2]);
    const got = c.insight.takeaways.find(t => t.kind === 'try');
    assert.equal(got.tryInstead, spec.rewrites[0].tryInstead, spec.key);
  }
});

test('running the seed twice produces identical output', async () => {
  const again = await build();
  assert.equal(JSON.stringify(exportSnapshot(again.store)), JSON.stringify(exportSnapshot(store)));
});
