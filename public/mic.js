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
    let s = input[lo] + (input[hi] - input[lo]) * frac;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
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
