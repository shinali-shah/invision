import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downsampleTo24k, micErrorMessage } from '../public/mic.js';

test('48 kHz input comes out at half the length', () => {
  const out = downsampleTo24k(new Float32Array(4800), 48000);
  assert.ok(out instanceof Int16Array);
  assert.equal(out.length, 2400);
});

test('24 kHz input passes straight through', () => {
  const src = Float32Array.from([0, 0.5, -0.5, 1]);
  const out = downsampleTo24k(src, 24000);
  assert.equal(out.length, 4);
  assert.equal(out[0], 0);
  assert.equal(out[3], 32767);
});

test('samples outside [-1, 1] clamp instead of wrapping', () => {
  const out = downsampleTo24k(Float32Array.from([2, 2, -3, -3]), 48000);
  assert.equal(out[0], 32767);
  assert.equal(out[1], -32768);
});

test('44.1 kHz interpolates between neighbours', () => {
  const src = new Float32Array(441).map((_, i) => i / 441);
  const out = downsampleTo24k(src, 44100);
  assert.equal(out.length, 240);
  for (let i = 1; i < out.length; i++) assert.ok(out[i] >= out[i - 1]);
});

test('blocked permission gets the Settings copy', () => {
  assert.equal(
    micErrorMessage({ name: 'NotAllowedError' }, { isSecureContext: true }),
    'Microphone permission was blocked. Allow it in Settings › Safari › Microphone and reload.'
  );
});

test('missing device gets the plug-in copy', () => {
  assert.equal(
    micErrorMessage({ name: 'NotFoundError' }, { isSecureContext: true }),
    'No microphone found. Plug in the glasses mic and try again.'
  );
});

test('plain http wins over whatever the error was', () => {
  const msg = 'Microphone needs HTTPS. Open the ngrok https link on the iPhone.';
  assert.equal(micErrorMessage({ name: 'NotAllowedError' }, { isSecureContext: false }), msg);
  assert.equal(micErrorMessage(new TypeError('x'), { isSecureContext: false }), msg);
});

test('anything else includes the original message', () => {
  assert.equal(
    micErrorMessage(new Error('boom'), { isSecureContext: true }),
    "Couldn't start the microphone: boom"
  );
});

import { createLeveler, rmsOf, toDb, TARGET_DB, createResampler, pickRecorderMime } from '../public/mic.js';

test('leveler lifts a quiet mic to speech level and leaves a normal one alone', () => {
  const quiet = createLeveler();
  let g;
  for (let i = 0; i < 50; i++) g = quiet(10 ** (-57 / 20)); // what the Saramonic recordings measured
  assert.ok(Math.abs(toDb(10 ** (-57 / 20) * g) - TARGET_DB) < 1, `got gain ${g}`);

  const normal = createLeveler();
  for (let i = 0; i < 50; i++) g = normal(10 ** (-22 / 20));
  assert.equal(g, 1);
});

test('leveler ignores silence and never boosts past its ceiling', () => {
  const lev = createLeveler();
  assert.equal(lev(0), null);              // nothing heard yet
  assert.equal(lev(10 ** (-90 / 20)), null); // room tone stays under the gate
  for (let i = 0; i < 50; i++) lev(10 ** (-74 / 20));
  assert.ok(lev(10 ** (-74 / 20)) <= 80);
  const after = lev(0);                    // a pause holds the gain
  assert.ok(after > 1);
});

test('rmsOf', () => {
  assert.equal(rmsOf(new Float32Array([0.5, -0.5])), 0.5);
  assert.equal(rmsOf(new Float32Array(0)), 0);
});

test('leveler pulls a hot mic down instead of pinning it at the limiter', () => {
  const hot = createLeveler();
  let g;
  for (let i = 0; i < 50; i++) g = hot(10 ** (-10 / 20));
  assert.ok(g < 1, `gain should drop below 1, got ${g}`);
  assert.ok(Math.abs(toDb(10 ** (-10 / 20) * g) - TARGET_DB) < 1);
});

test('resampler keeps sample count exact across chunk boundaries', () => {
  for (const rate of [44100, 48000, 24000]) {
    const rs = createResampler(rate);
    let out = 0;
    const chunks = 200;
    for (let c = 0; c < chunks; c++) out += rs(new Float32Array(2048)).length;
    const expected = Math.round(chunks * 2048 * 24000 / rate);
    assert.ok(Math.abs(out - expected) <= 1, `${rate}: ${out} vs ${expected}`);
  }
});

test('recorder mime list asks for AAC audio in mp4 before falling back', () => {
  // Chrome would otherwise mux Opus into the mp4, which Safari on the Mac can't play back
  assert.equal(pickRecorderMime(() => true), 'video/mp4;codecs=avc1,mp4a.40.2');
  assert.equal(pickRecorderMime((m) => m === 'video/mp4'), 'video/mp4');
  assert.equal(pickRecorderMime((m) => m.startsWith('video/webm')), 'video/webm;codecs=vp8,opus');
  assert.equal(pickRecorderMime(() => { throw new Error('no MediaRecorder'); }), '');
});

test('leveler shrugs off a reading that is not a number', () => {
  const lev = createLeveler();
  lev(10 ** (-30 / 20));
  const before = lev.levelDb;
  lev(NaN);
  lev(Infinity);
  assert.equal(lev.levelDb, before);
  const g = lev(10 ** (-30 / 20));
  assert.ok(Number.isFinite(g) && g > 1, String(g));
});

test('leveler exposes the speech level it is tracking, in dB', () => {
  const lev = createLeveler();
  assert.equal(lev.levelDb, null);
  lev(10 ** (-30 / 20));
  assert.ok(Math.abs(lev.levelDb - -30) < 0.01, String(lev.levelDb));
  lev(10 ** (-20 / 20)); // louder: tracks halfway up
  assert.ok(Math.abs(lev.levelDb - -25) < 0.01, String(lev.levelDb));
});
