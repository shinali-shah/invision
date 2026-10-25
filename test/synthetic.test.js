import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db.js';
import { buildSynthetic, schedule } from '../src/synthetic/build.js';

test('synthetic account: every conversation goes through the real agents without a fallback', async () => {
  const store = openStore(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'playback-synth-test-'));
  try {
    const now = Date.parse('2026-10-25T21:00:00');
    const plan = schedule(now);
    const { built, problems } = await buildSynthetic({ store, recordingsDir: dir, videos: false, now });
    assert.deepEqual(problems, []);
    assert.equal(built.length, plan.length);

    // The Home calendar is mostly filled in, with some days off, and today always has a conversation.
    const day = iso => new Date(iso).toDateString();
    const days = new Set(store.listConversations().map(c => day(c.createdAt)));
    let total = 0;
    for (const d = new Date(2026, 8, 1); d <= new Date(now); d.setDate(d.getDate() + 1)) total++;
    assert.ok(days.size >= total * 0.55 && days.size <= total * 0.8, `${days.size} of ${total} days`);
    assert.ok(days.has(new Date(now).toDateString()));

    // Plan is oldest first, same as the store lists them.
    store.listConversations().forEach((c, i) => {
      const spec = plan[i];
      assert.equal(c.otherName, spec.otherName);
      assert.ok(c.turns.length >= 8 && c.userLabel && c.reflection, spec.key);
      assert.equal(c.signals.source, 'muse-spark');
      assert.equal(c.note.status, 'shown');
      assert.ok(c.hooks.topics.length);
      assert.ok(['muse-spark', 'edited'].includes(c.followUp.source));
      assert.equal(c.followUp.status, spec.followUp.status);
      assert.equal(c.insight.source, 'muse-spark');
      assert.ok(c.insight.takeaways.length >= 2, spec.key);
      if (spec.video) {
        assert.ok(c.recording && c.behavior?.turns.length, `${spec.key} has face cues`);
        assert.ok(existsSync(join(dir, `${c.id}.frames.json`)));
      } else {
        assert.equal(c.recording, null);
      }
    });

    assert.deepEqual(store.listNextSteps().map(s => s.status), ['changed', 'dismissed', 'accepted']);
    assert.match(store.getKv('pattern').statement, /rose/);
    assert.ok(plan.some(p => p.mood === 'bumps') && plan.some(p => p.mood === 'rough'));
    assert.equal(store.getKv('dataset').name, 'synthetic');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
