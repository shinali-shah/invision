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
