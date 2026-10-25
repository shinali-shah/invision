import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacer } from '../src/transcribe/pace.js';

// A hand-cranked clock: push() and tick() are the only things that move time or timers.
function clock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    schedule: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    cancel: h => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    tick(ms) {
      const end = t + ms;
      while (true) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

const frame = ms => Buffer.alloc(ms * 48); // 24 kHz 16-bit mono

test('audio at real-time pace goes straight through', () => {
  const c = clock();
  const out = [];
  const p = createPacer({ ...c, leadMs: 1500 });
  p.setSink(b => out.push(b.length));
  for (let i = 0; i < 100; i++) { p.push(frame(80)); c.tick(80); }
  assert.equal(out.length, 100);
  assert.equal(p.queuedMs(), 0);
  assert.equal(p.positionMs(), 8000);
});

test('a burst after a stall drains at the catch-up rate, not all at once', () => {
  const c = clock();
  const out = [];
  const p = createPacer({ ...c, leadMs: 1500, catchUp: 1.5 });
  p.setSink(b => out.push(b.length));
  // 10 s of audio arrives in one go (a stalled tunnel letting go)
  for (let i = 0; i < 125; i++) p.push(frame(80));
  const immediate = out.length * 80;
  assert.ok(immediate <= 1500 && immediate >= 1400, `only the lead goes out at once, got ${immediate}ms`);
  c.tick(1000);
  const afterASecond = out.length * 80;
  assert.ok(afterASecond - immediate <= 1600 && afterASecond - immediate >= 1400, `about 1.5 s per second, got ${afterASecond - immediate}ms`);
  c.tick(10000);
  assert.equal(out.length, 125);
  assert.equal(p.queuedMs(), 0);
});

test('nothing moves without a sink; it all goes once one is set', () => {
  const c = clock();
  const out = [];
  const p = createPacer({ ...c });
  p.push(frame(80));
  p.push(frame(80));
  assert.equal(p.queuedMs(), 160);
  assert.equal(p.positionMs(), 0);
  p.setSink(b => out.push(b.length));
  assert.equal(out.length, 2);
  assert.equal(p.positionMs(), 160);
});

test('the oldest audio is shed past the queue limit and still counts toward position', () => {
  const c = clock();
  const dropped = [];
  const p = createPacer({ ...c, maxQueueMs: 1000, onDrop: ms => dropped.push(ms) });
  for (let i = 0; i < 20; i++) p.push(frame(100)); // 2 s queued with nobody listening
  assert.equal(p.queuedMs(), 1000);
  assert.equal(dropped.reduce((a, b) => a + b, 0), 1000);
  assert.equal(p.positionMs(), 1000); // a new Muse session would start its clock after the lost second
  const out = [];
  p.setSink(b => out.push(b.length));
  assert.equal(out.length, 10);
  assert.equal(p.positionMs(), 2000);
});

test('idle resolves when the queue empties, or on its timeout', async () => {
  const c = clock();
  const p = createPacer({ ...c, leadMs: 100, catchUp: 1 });
  p.setSink(() => {});
  for (let i = 0; i < 10; i++) p.push(frame(100)); // 1 s queued behind a 100 ms lead
  let settled = false;
  p.idle(300).then(() => { settled = true; });
  c.tick(200);
  await Promise.resolve();
  assert.equal(settled, false);
  c.tick(200); // timeout fires first
  await Promise.resolve();
  assert.equal(settled, true);
  c.tick(2000); // the rest drains
  assert.equal(p.queuedMs(), 0);
  let fast = false;
  p.idle(1).then(() => { fast = true; }); // nothing queued: settles without a timer
  await Promise.resolve();
  assert.equal(fast, true);
});
