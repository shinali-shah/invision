import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db.js';
import { buildSynthetic } from '../src/synthetic/build.js';
import { SYNTHETIC_CONVERSATIONS } from '../src/synthetic/conversations.js';

test('synthetic account: every conversation goes through the real agents without a fallback', async () => {
  const store = openStore(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'playback-synth-test-'));
  try {
    const { built, problems } = await buildSynthetic({ store, recordingsDir: dir, videos: false, now: Date.parse('2026-10-25T21:00:00') });
    assert.deepEqual(problems, []);
    assert.equal(built.length, SYNTHETIC_CONVERSATIONS.length);

    // Specs are oldest first, same as the store lists them.
    store.listConversations().forEach((c, i) => {
      const spec = SYNTHETIC_CONVERSATIONS[i];
      assert.equal(c.otherName, spec.otherName);
      assert.ok(c.turns.length >= 10 && c.userLabel && c.reflection, spec.key);
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
    assert.equal(store.getKv('dataset').name, 'synthetic');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
