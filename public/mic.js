// Pure audio + error helpers. Kept DOM-free so node --test can import it.

export const TARGET_RATE = 24000;

// Linear-interpolating resampler to 24 kHz PCM16. Safari usually runs the
// AudioContext at 48 kHz, but some USB mics force 44.1, so don't assume 2:1.
export function downsampleTo24k(input, inRate) {
  const ratio = inRate / TARGET_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = pos - lo;
    out[i] = toInt16(input[lo] + (input[hi] - input[lo]) * frac);
  }
  return out;
}

function toInt16(s) {
  if (s > 1) s = 1;
  else if (s < -1) s = -1;
  return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
}

// Same interpolation, but for a live stream fed in worklet-sized chunks.
// downsampleTo24k restarts its phase at 0 on every call and can't see the next
// chunk's first sample, so at 44.1 kHz it drops ~0.5 samples per chunk and
// puts a small step at every boundary (a ~21 Hz tick). This keeps the read
// position and the last sample across calls.
export function createResampler(inRate) {
  const ratio = inRate / TARGET_RATE;
  let pos = 0;   // where the next output sample sits, relative to the chunk start; -1..0 means between prev and input[0]
  let prev = 0;
  return function resample(input) {
    const n = input.length;
    if (!n) return new Int16Array(0);
    const out = new Int16Array(Math.max(0, Math.ceil((n - 1 - pos) / ratio)));
    let i = 0;
    let p = pos;
    // stop short of the last sample so interpolation never needs input[n]; the next call picks it up
    while (p < n - 1 && i < out.length) {
      const lo = Math.floor(p);
      const a = lo < 0 ? prev : input[lo];
      const b = input[lo + 1];
      out[i++] = toInt16(a + (b - a) * (p - lo));
      p += ratio;
    }
    pos = p - n;
    prev = input[n - 1];
    return i === out.length ? out : out.subarray(0, i);
  };
}

export function micErrorMessage(err, { isSecureContext } = {}) {
  // getUserMedia doesn't even exist over plain http on iOS, so whatever error
  // we got is a symptom of this.
  if (!isSecureContext) return 'Microphone needs HTTPS. Open the ngrok https link on the iPhone.';
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was blocked. Allow it in Settings › Safari › Microphone and reload.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone found. Plug in the glasses mic and try again.';
  }
  return `Couldn't start the microphone: ${(err && err.message) || String(err)}`;
}

// Errors where it's the camera that's the problem, not the mic, so we can
// carry on with audio only.
export function isCameraError(err) {
  const name = err && err.name;
  return name === 'NotAllowedError' || name === 'OverconstrainedError' || name === 'NotFoundError';
}

// iOS only records mp4; Chrome and Firefox want webm. First one supported wins.
// Ask for AAC audio explicitly: given just avc1, Chrome muxes Opus into the mp4, which
// Safari on the Mac won't play on the Replay page.
export const RECORDER_MIMES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function pickRecorderMime(isTypeSupported) {
  for (const m of RECORDER_MIMES) {
    try { if (isTypeSupported(m)) return m; } catch { /* treat as unsupported */ }
  }
  return '';
}

// ---------- level ----------
// External mics on iOS can arrive ~30 dB under normal speech (and on one side of a stereo pair)
// once the phone's own voice processing is off. We bring speech up to a sensible level ourselves.

export const TARGET_DB = -22;   // where speech should sit, RMS
const GATE_DB = -75;            // quieter than this is room tone, not speech; don't chase it
const MAX_GAIN = 80;            // +38 dB, enough for the quietest mic we've seen
const MIN_GAIN = 0.25;          // -12 dB; a hot mic gets brought down rather than living on the limiter

export const toDb = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -Infinity);

export function rmsOf(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

// Tracks the speech level (falls fast when it gets loud, rises slowly) and returns the gain that
// puts it at TARGET_DB. Silence leaves everything where it was, so pauses don't pump the noise up.
// The tracked level is readable as `leveler.levelDb`: the lip lock compares each reading
// against it to tell the close voice (yours) from everything further away.
export function createLeveler({ target = TARGET_DB, gate = GATE_DB, maxGain = MAX_GAIN } = {}) {
  let levelDb = null;
  function next(rms) {
    const db = toDb(rms);
    if (db > gate) {
      if (levelDb === null) levelDb = db;
      else levelDb = db > levelDb ? levelDb + (db - levelDb) * 0.5 : levelDb + (db - levelDb) * 0.05;
    }
    if (levelDb === null) return null;
    const gain = 10 ** ((target - levelDb) / 20);
    return Math.min(maxGain, Math.max(MIN_GAIN, gain));
  }
  Object.defineProperty(next, 'levelDb', { get: () => levelDb });
  return next;
}
