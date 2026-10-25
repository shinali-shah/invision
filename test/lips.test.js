import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMouthGate, createVoiceGate, readMouth, MOUTH_HOLD_MS, VOICE_HOLD_MS } from '../public/lips.js';

// 8 fps samples of a mouth that opens and closes (talking) or sits still.
const talking = (gate, from, n, amp = 0.1) => {
  let last = false;
  for (let i = 0; i < n; i++) last = gate.push({ t: from + i * 125, face: true, mouth: i % 2 ? amp : 0 });
  return last;
};
const still = (gate, from, n, mouth = 0.05) => {
  let last = false;
  for (let i = 0; i < n; i++) last = gate.push({ t: from + i * 125, face: true, mouth });
  return last;
};

test('a still mouth is not theirs; a moving one locks after the window fills', () => {
  const g = createMouthGate();
  assert.equal(still(g, 0, 8), false);
  assert.equal(talking(g, 1000, 4), true);
});

test('a short pause between words keeps the lock, a longer one drops it', () => {
  const g = createMouthGate();
  talking(g, 0, 8);
  // quiet for less than the hold: still theirs
  assert.equal(still(g, 1000, Math.floor(MOUTH_HOLD_MS / 125)), true);
  // quiet well past the hold: released
  assert.equal(still(g, 1375, 12), false);
});

test('a tiny flutter does not trip the lock (hysteresis floor)', () => {
  const g = createMouthGate();
  assert.equal(talking(g, 0, 12, 0.02), false);
});

test('losing the face releases the lock and clears the window', () => {
  const g = createMouthGate();
  talking(g, 0, 8);
  assert.equal(g.push({ t: 1000, face: false, mouth: 0 }), false);
  // one moving sample after a dropout is not enough on its own
  assert.equal(g.push({ t: 1125, face: true, mouth: 0.3 }), false);
});

test('a clock that runs backwards starts the mouth gate over instead of wedging it on', () => {
  // The lip lock used to feed the gate performance.now() until audio started and transcript
  // ms after. The old samples never left the window and the hold never ran out.
  const g = createMouthGate();
  assert.equal(talking(g, 30000, 8), true);
  assert.equal(still(g, 100, 40), false);
  // and it locks again on the new clock
  assert.equal(talking(g, 6000, 4), true);
});

test('the close loud voice is mine when it sits near the tracked speech level', () => {
  const g = createVoiceGate();
  assert.equal(g.push(0, -30, null), false);      // nothing tracked yet
  assert.equal(g.push(100, -30, -28), true);      // 2 dB under the speech level
  assert.equal(g.push(200, -35, -28), true);      // 7 dB under, still near
  assert.equal(g.push(300, -37, -28), true);      // 9 dB under: inside the hold
  assert.equal(g.push(300 + VOICE_HOLD_MS + 50, -42, -28), false); // 14 dB under for longer than the hold
  assert.equal(g.push(900, -90, -28), false);     // room tone
});

test('mine needs the level to climb back within the near band, not just out of the far one', () => {
  const g = createVoiceGate();
  g.push(0, -50, -28);
  assert.equal(g.push(100, -38, -28), false);     // 10 dB under: between the bands, stays off
  assert.equal(g.push(200, -35, -28), true);      // 7 dB under: on
});

test('readMouth turns a landmarker result into face / mouth / box', () => {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  lm[10] = { x: 0.5, y: 0.2 };   // forehead
  lm[152] = { x: 0.5, y: 0.8 };  // chin
  lm[13] = { x: 0.5, y: 0.58 };  // upper inner lip
  lm[14] = { x: 0.5, y: 0.64 };  // lower inner lip
  lm[61] = { x: 0.42, y: 0.6 };  // mouth corners
  lm[291] = { x: 0.58, y: 0.6 };
  lm[0] = { x: 0.5, y: 0.55 };   // upper lip top
  lm[17] = { x: 0.5, y: 0.67 };  // lower lip bottom
  const res = { faceLandmarks: [lm], faceBlendshapes: [{ categories: [{ categoryName: 'jawOpen', score: 0.2 }] }] };
  const m = readMouth(res);
  assert.equal(m.face, true);
  // lip gap 0.06 over a 0.6 face height is 0.1; scaled x3 it beats jawOpen 0.2
  assert.equal(m.mouth, 0.3);
  assert.deepEqual(m.box, { x: 0.42, y: 0.55, w: 0.16, h: 0.12 });
  assert.deepEqual(readMouth(null), { face: false, mouth: 0, box: null });
  assert.equal(readMouth({ faceLandmarks: [] }).face, false);
});
