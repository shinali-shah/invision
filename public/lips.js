// Lip lock. The camera already points at the other person, so their mouth moving says "they're
// talking"; the mic is on you, so the loudest thing it hears is you. Both are turned into
// on/off cues with a bit of hysteresis and sent to the server next to the audio, where they
// decide whose line each diarized turn is and which lines belong to the crowd.
//
// The gates and readMouth are DOM-free so node --test can import this file.

export const FPS = 8;
export const BATCH_MS = 500;
export const LOST_MS = 2000;           // no face this long → "Point at them"

// Mouth motion is the mean frame-to-frame change of the mouth score over the last ~300 ms.
// At 8 fps speech swings the jaw score by 0.1 or more between frames; a listener's face drifts
// by well under 0.03 (speaker.js saw real talkers above 0.005 per frame even at 5 fps, with a
// still face a fraction of that). On at 0.06, off below 0.03, and a hold so pauses between
// words don't flicker.
export const MOUTH_ON = 0.06;
export const MOUTH_OFF = 0.03;
export const MOUTH_WINDOW_MS = 300;
export const MOUTH_HOLD_MS = 400;

// Your voice sits at the level the leveler tracks (it rises fast when loud, falls slowly). The
// other person a metre away lands 6-15 dB under that on a mic worn by you, crowd further still.
export const VOICE_NEAR_DB = 8;        // within this of the tracked level → yours
export const VOICE_FAR_DB = 12;        // once locked, stays yours down to here
export const VOICE_HOLD_MS = 300;
const VOICE_GATE_DB = -75;             // room tone, same as mic.js

const r3 = (n) => Math.round(n * 1000) / 1000;

export function createMouthGate() {
  let win = [];          // { t, mouth } inside the window
  let on = false;
  let lastActive = -Infinity;
  let lastT = -Infinity;
  return {
    push({ t, face, mouth }) {
      if (!face) { win = []; on = false; lastActive = -Infinity; lastT = t; return false; }
      // A clock that runs backwards would leave the old samples in the window for as long as it
      // takes the new one to catch up, and the hold would never run out. Start over instead.
      if (t < lastT) { win = []; on = false; lastActive = -Infinity; }
      lastT = t;
      win.push({ t, mouth });
      win = win.filter((s) => t - s.t <= MOUTH_WINDOW_MS);
      let motion = 0;
      if (win.length >= 3) {
        let sum = 0;
        for (let i = 1; i < win.length; i++) sum += Math.abs(win[i].mouth - win[i - 1].mouth);
        motion = sum / (win.length - 1);
      }
      if (motion >= MOUTH_OFF) lastActive = t;
      if (!on && motion >= MOUTH_ON) on = true;
      else if (on && t - lastActive > MOUTH_HOLD_MS) on = false;
      return on;
    },
  };
}

export function createVoiceGate() {
  let on = false;
  let lastNear = -Infinity;
  return {
    push(t, db, levelDb) {
      if (levelDb == null || !(db > VOICE_GATE_DB)) {
        if (on && t - lastNear > VOICE_HOLD_MS) on = false;
        return on;
      }
      const under = levelDb - db;
      if (under <= VOICE_NEAR_DB) { on = true; lastNear = t; }
      else if (on && under <= VOICE_FAR_DB) lastNear = t;
      else if (on && t - lastNear > VOICE_HOLD_MS) on = false;
      return on;
    },
    get state() { return on; },
  };
}

// jawOpen blendshape, or the inner-lip gap relative to face height (x3 puts the two on the same
// scale), whichever is bigger. The box is the outer lips in normalized image units.
export function readMouth(res) {
  const lm = res && res.faceLandmarks && res.faceLandmarks[0];
  if (!lm || lm.length < 300) return { face: false, mouth: 0, box: null };
  const cats = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
  const jaw = cats ? (cats.find((c) => c.categoryName === 'jawOpen') || {}).score || 0 : 0;
  const faceH = Math.max(1e-3, lm[152].y - lm[10].y);
  const gap = Math.max(0, lm[14].y - lm[13].y) / faceH;
  const x = Math.min(lm[61].x, lm[291].x);
  const y = lm[0].y;
  return {
    face: true,
    mouth: r3(Math.max(jaw, gap * 3)),
    box: { x: r3(x), y: r3(y), w: r3(Math.abs(lm[291].x - lm[61].x)), h: r3(Math.max(0, lm[17].y - lm[0].y)) },
  };
}

// ---------- browser side ----------

const WIDTH = 320; // analysis canvas; plenty for one face at arm's length

async function loadLandmarker() {
  const { FaceLandmarker, FilesetResolver } = await import('./vendor/mediapipe/vision_bundle.mjs');
  const vendor = new URL('vendor/mediapipe/', import.meta.url).href;
  const fileset = await FilesetResolver.forVisionTasks(`${vendor}wasm`);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${vendor}face_landmarker.task`, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('Lip lock: GPU landmarker failed, trying CPU', err);
    return FaceLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

// video: the preview element already playing the camera track.
// timeBase(): wall-clock ms of transcript 0, or null until audio has started.
// send(samples): a batch of cues for the socket. onState({ status, box }): for the reticle and pill.
// Returns { stop(), level(db, levelDb) }; level() is fed from the mic's meter tick.
export function startLipLock({ video, timeBase, send, onState, fps = FPS }) {
  const mouthGate = createMouthGate();
  const voiceGate = createVoiceGate();
  let stopped = false;
  let raf = 0;
  let landmarker = null;
  let canvas = null;
  let ctx2d = null;
  let lastRun = 0;
  let lastStamp = 0;
  let lastFaceAt = performance.now();
  let lastSent = performance.now();
  let batch = [];
  let failures = 0;
  let status = null;

  const setState = (next, box) => {
    if (next !== status) status = next;
    try { onState && onState({ status, box: box || null }); } catch { /* UI only */ }
  };

  const flush = () => {
    if (!batch.length) return;
    const samples = batch;
    batch = [];
    try { send(samples); } catch { /* socket gone; the cues are a bonus */ }
  };

  // The gates only care how far apart their samples are, so they run on performance.now()
  // throughout. The transcript clock is for the cues alone: it isn't there until audio starts,
  // and switching a gate over to it mid-run threw its window and its hold off for half a minute.
  const level = (db, levelDb) => {
    voiceGate.push(performance.now(), db, levelDb);
  };

  const step = (now) => {
    if (stopped) return;
    raf = requestAnimationFrame(step);
    if (now - lastRun < 1000 / fps) return;
    lastRun = now;
    // Before loadedmetadata the element is 0×0 and there's nothing to draw yet.
    if (!landmarker || video.readyState < 2 || !video.videoWidth) return;
    // iOS swaps the track's width and height when the phone turns; a canvas cut for the old
    // shape would squash the face and the model would start missing it.
    const h = Math.max(1, Math.round((WIDTH * video.videoHeight) / video.videoWidth));
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = h;
      ctx2d = canvas.getContext('2d', { willReadFrequently: false });
    } else if (canvas.height !== h) {
      canvas.height = h;
    }
    let res;
    try {
      ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      // detectForVideo wants strictly increasing timestamps
      lastStamp = Math.max(lastStamp + 1, Math.round(now));
      res = landmarker.detectForVideo(canvas, lastStamp);
      failures = 0;
    } catch (err) {
      // A few bad frames happen on GPU swaps; a run of them means the model is gone.
      if (++failures >= 5) { console.warn('Lip lock: detection keeps failing, turning it off', err); turnOff(); }
      return;
    }
    const m = readMouth(res);
    if (m.face) lastFaceAt = now;
    const theirs = mouthGate.push({ t: now, face: m.face, mouth: m.mouth });
    setState(m.face ? (theirs ? 'locked' : 'tracking') : now - lastFaceAt > LOST_MS ? 'lost' : 'tracking', m.box);
    const base = timeBase();
    if (base == null) return; // no transcript clock yet; nothing to line these up with
    batch.push({ t: Math.round(Date.now() - base), face: m.face, mouth: m.mouth, theirs, mine: voiceGate.state });
    if (now - lastSent >= BATCH_MS) { lastSent = now; flush(); }
  };

  const turnOff = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    flush();
    if (landmarker) { try { landmarker.close(); } catch { /* already gone */ } landmarker = null; }
    setState('off', null);
  };

  loadLandmarker().then((lm) => {
    if (stopped) { try { lm.close(); } catch { /* ignore */ } return; }
    landmarker = lm;
    lastFaceAt = performance.now();
    setState('tracking', null);
    raf = requestAnimationFrame(step);
  }, (err) => {
    console.warn('Lip lock unavailable', err);
    setState('off', null);
    stopped = true;
  });

  return {
    level,
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      flush();
      if (landmarker) { try { landmarker.close(); } catch { /* ignore */ } landmarker = null; }
    },
  };
}
