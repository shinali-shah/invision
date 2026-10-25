// Replay page (Mac). Plays a conversation's video next to its transcript, runs
// MediaPipe Face Landmarker over the video in this browser, and shows where the
// coaching advice is or isn't backed by what happened on camera.
// Transcript text and names come from speech recognition and users, so every bit
// of data goes in via textContent, never innerHTML.

const MODEL = 'mediapipe-face-landmarker@0.10.14';
const VENDOR = new URL('vendor/mediapipe/', location.href).href;
const FPS = 5;
const STEP_MS = 1000 / FPS;
// Same thresholds as src/behavior/align.js, so the ticks match the per-turn counts.
const FACING_DEG = 25;
const NOD_DEG = 5;
const NOD_MAX_MS = 1500;
const SEEK_TIMEOUT_MS = 4000;
const LIVE_EVERY_MS = 100;
const PREROLL_S = 0.3;
const TAG_NAMES = { family: 'Family', friend: 'Friend', networking: 'Networking' };
const VERDICTS = { backed: 'Backed', partly: 'Partly', 'not yet': 'Not yet' };
const MARKS = {
  follow: { sym: '✓', label: 'Follow-up question' },
  missed: { sym: '⚠', label: 'Missed moment' },
  cited: { sym: '★', label: 'Cited by the coaching note' },
  insight: { sym: '◆', label: 'Insight' },
};
const LANES = [
  { key: 'talk', label: "Who's talking", h: 30 },
  { key: 'smile', label: 'Smile', h: 56 },
  { key: 'facing', label: 'Facing', h: 16 },
  { key: 'nods', label: 'Nods', h: 20 },
  { key: 'marks', label: 'Moments', h: 30 },
];
const LANE_GAP = 8;
const AXIS_H = 18;

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

const state = {
  id: null,
  convo: null,
  offsetMs: 0,
  durMs: null,          // video length, once the browser knows it
  frames: null,         // BehaviorFrame[] for the lanes and meters
  framesFrom: null,     // 'server' | 'cache' | 'run'
  framesAsked: null,    // which analysis we last asked the server for frames for
  recKey: null,         // which upload of the video the frames belong to
  heat: { key: null, data: null },
  nods: [],             // transcript ms of each nod found in frames
  analysing: false,
  autoStarted: false,
  pendingUpload: null,  // frames we couldn't post yet
  uploading: false,
  runId: 0,
  activeTurn: null,
  liveFrames: [],       // recent live detections, for the nod meter
  lastLiveAt: 0,
  liveBusy: false,
  lastResult: null,     // last landmarker result drawn on the overlay
  videoSrc: null,
};

// ---------- helpers ----------

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid != null && kid !== false) node.append(kid);
  return node;
}

// replaceChildren would print a stray null as the text "null"
function put(node, ...kids) {
  node.replaceChildren(...kids.filter((k) => k != null && k !== false));
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v) => (isNum(v) ? Math.round(v * 100) : null);
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function signed(v, dp = 2) {
  if (!isNum(v)) return '—';
  const s = Math.abs(v).toFixed(dp);
  if (Number(s) === 0) return `±${s}`;
  return v > 0 ? `+${s}` : `−${s}`;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(`${path} ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach the server. Check it's running and try again.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Server said ${res.status}. Try again.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- conversation bits ----------

const turnsOf = (c) => (c && Array.isArray(c.turns) ? c.turns : []);
const hasVideo = () => !!(state.convo && state.convo.recording);
const toVideoMs = (t) => t + state.offsetMs;

function speakerLabels(turns) {
  const seen = [];
  for (const t of turns) if (t.speaker && t.speaker !== 'unknown' && !seen.includes(t.speaker)) seen.push(t.speaker);
  return seen;
}

function behaviorTurns() {
  const b = state.convo && state.convo.behavior;
  return new Map((b && Array.isArray(b.turns) ? b.turns : []).map((t) => [t.turnId, t]));
}

// 'you' | 'them' | null (null until the phone says which voice is the user)
function sideOf(turn, bt) {
  if (bt && (bt.speaker === 'you' || bt.speaker === 'them')) return bt.speaker;
  const label = state.convo && state.convo.userLabel;
  if (!label) return null;
  return turn.speaker === label ? 'you' : 'them';
}

function speakerName(turn, side, labels) {
  if (side === 'you') return 'You';
  const c = state.convo;
  if (side === 'them') {
    const others = labels.filter((l) => l !== c.userLabel);
    if (others.length <= 1 && c.otherName) return c.otherName;
  }
  if (!turn.speaker || turn.speaker === 'unknown') return 'Unclear';
  return `Speaker ${turn.speaker}`;
}

function otherName() {
  const n = state.convo && state.convo.otherName;
  return n && n !== 'them' ? n : 'they';
}

// turnId -> Set of marker kinds
function markersByTurn(c) {
  const out = new Map();
  const add = (turnId, kind) => {
    if (!Number.isInteger(turnId)) return;
    if (!out.has(turnId)) out.set(turnId, new Set());
    out.get(turnId).add(kind);
  };
  const qs = c.signals && Array.isArray(c.signals.questions) ? c.signals.questions : [];
  const classified = qs.some((q) => typeof q.isFollowUp === 'boolean');
  if (classified) {
    for (const q of qs) if (q.isFollowUp) add(q.turnId, 'follow');
  } else if (c.hooks && Array.isArray(c.hooks.followUpDetector)) {
    for (const q of c.hooks.followUpDetector) if (q.isFollowUp) add(q.turnId, 'follow');
  }
  for (const b of (c.hooks && c.hooks.missedBids) || []) add(b.turnId, 'missed');
  const note = c.note;
  if (note && note.text && note.status !== 'dropped') for (const id of note.citedTurnIds || []) add(id, 'cited');
  for (const m of (c.insight && c.insight.moments) || []) add(m.turnId, 'insight');
  return out;
}

function missedCue(turnId) {
  const b = ((state.convo.hooks && state.convo.hooks.missedBids) || []).find((x) => x.turnId === turnId);
  return b && b.cue ? b.cue : null;
}

function markerTitle(turnId, kinds) {
  return [...kinds].map((k) => {
    if (k === 'missed') {
      const cue = missedCue(turnId);
      return cue ? `Missed moment: they mentioned “${cue}” and the next line moved on` : MARKS.missed.label;
    }
    if (k === 'insight') {
      const m = state.convo.insight.moments.find((x) => x.turnId === turnId);
      return m && m.title ? `Insight: ${m.title}` : MARKS.insight.label;
    }
    return MARKS[k].label;
  }).join('\n');
}

// ---------- frames: lanes data ----------

const cacheKey = (id) => `replay-frames:${id}`;

function saveFramesLocally(frames, recAt) {
  try {
    localStorage.setItem(cacheKey(state.id), JSON.stringify({
      recording: recAt,
      frames,
    }));
  } catch { /* storage full or blocked; the lanes fall back to per-turn bars */ }
}

function loadFramesLocally() {
  try {
    const d = JSON.parse(localStorage.getItem(cacheKey(state.id)) || 'null');
    const rec = state.convo.recording && state.convo.recording.uploadedAt;
    if (d && Array.isArray(d.frames) && d.recording === rec) return d.frames;
  } catch { /* nothing usable */ }
  return null;
}

function setFrames(frames, from) {
  state.frames = frames && frames.length ? frames : null;
  state.framesFrom = state.frames ? from : null;
  state.nods = state.frames ? findNods(state.frames) : [];
}

// Pick the best per-frame data we have: this browser's own run, what the server
// kept, else what this browser cached last time.
function syncFrames() {
  const c = state.convo;
  const recKey = c && c.recording ? String(c.recording.uploadedAt || c.recording.bytes || '') : null;
  if (recKey !== state.recKey) {
    // a new video (or none): anything we had belongs to the old one
    state.recKey = recKey;
    state.framesAsked = null;
    state.autoStarted = false;
    abortAnalysis();
    document.body.classList.remove('is-analysing');
    clearOverlay();
    setFrames(null, null);
  }
  if (state.analysing || state.framesFrom === 'run') return;
  const b = c && c.behavior;
  if (!b) { setFrames(null, null); return; }
  if (state.framesFrom === 'server') return;
  if (!state.frames) setFrames(loadFramesLocally(), 'cache');
  const ask = `${recKey}|${b.frameCount}`;
  if (state.framesAsked === ask) return;
  state.framesAsked = ask;
  getJson(`/api/conversations/${enc(state.id)}/behavior/frames`)
    .then((d) => {
      if (state.analysing || state.framesFrom === 'run' || state.framesAsked !== ask) return;
      if (d && Array.isArray(d.frames) && d.frames.length) {
        setFrames(d.frames, 'server');
        drawLanes();
      }
    })
    .catch(() => { /* older server or no file: the cache or per-turn bars will do */ });
}

// A nod: pitch swings at least NOD_DEG away from where it was a moment ago (either
// way) and comes back within NOD_MAX_MS. Returns transcript ms of the furthest point.
function findNods(frames) {
  const out = [];
  const pts = frames.filter((f) => f.face);
  let dip = null;
  for (let i = 0; i < pts.length; i++) {
    const f = pts[i];
    if (dip && f.t - dip.lastT > 3 * STEP_MS) dip = null; // lost the face mid-dip
    if (!dip) {
      const ref = refPitch(pts, i);
      if (ref !== null && Math.abs(f.pitch - ref) >= NOD_DEG) dip = { ref, start: f.t, minT: f.t, max: Math.abs(f.pitch - ref), lastT: f.t };
      continue;
    }
    dip.lastT = f.t;
    const off = Math.abs(f.pitch - dip.ref);
    if (off > dip.max) { dip.max = off; dip.minT = f.t; }
    if (off < NOD_DEG / 2) {
      if (f.t - dip.start <= NOD_MAX_MS) out.push(dip.minT);
      dip = null;
    } else if (f.t - dip.start > NOD_MAX_MS) {
      dip = null; // a held tilt, not a nod
    }
  }
  return out;
}

// Median pitch over the second before frame i.
function refPitch(pts, i) {
  const t = pts[i].t;
  const win = [];
  for (let j = i - 1; j >= 0 && pts[j].t >= t - 1000; j--) win.push(pts[j].pitch);
  if (win.length < 2) return null;
  win.sort((a, b) => a - b);
  return win[Math.floor(win.length / 2)];
}

function frameAt(t) {
  const fs = state.frames;
  if (!fs) return null;
  let lo = 0;
  let hi = fs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fs[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const best = lo > 0 && Math.abs(fs[lo - 1].t - t) < Math.abs(fs[lo].t - t) ? fs[lo - 1] : fs[lo];
  return Math.abs(best.t - t) <= STEP_MS * 1.5 ? best : null;
}

const facing = (f) => f && f.face && Math.abs(f.yaw) < FACING_DEG && Math.abs(f.pitch) < FACING_DEG;

// ---------- face landmarker ----------

let landmarkerP = null;
let clock = 0;
// detectForVideo needs timestamps that only go up, across the analysis run and live playback.
const stamp = (target) => (clock = Math.max(clock + 1, Math.round(target)));

function createLandmarker(delegate) {
  return (async () => {
    const { FaceLandmarker, FilesetResolver } = await import('./vendor/mediapipe/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(`${VENDOR}wasm`);
    const options = (d) => ({
      baseOptions: { modelAssetPath: `${VENDOR}face_landmarker.task`, delegate: d },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    if (delegate === 'GPU') {
      try {
        return { lm: await FaceLandmarker.createFromOptions(fileset, options('GPU')), delegate: 'GPU' };
      } catch (err) {
        console.warn('Face Landmarker on GPU failed, using CPU', err);
      }
    }
    return { lm: await FaceLandmarker.createFromOptions(fileset, options('CPU')), delegate: 'CPU' };
  })();
}

// A failed build must not stay cached, or nothing works until a reload.
function useLandmarker(delegate) {
  const p = createLandmarker(delegate);
  landmarkerP = p;
  p.catch(() => { if (landmarkerP === p) landmarkerP = null; });
  return p;
}

function getLandmarker() {
  return landmarkerP || useLandmarker('GPU');
}

async function detect(source, target) {
  const p = getLandmarker();
  const L = await p;
  try {
    return { res: L.lm.detectForVideo(source, stamp(target)), delegate: L.delegate };
  } catch (err) {
    // Some GPUs build the graph fine and then fail on the first frame.
    if (L.delegate !== 'GPU') throw err;
    console.warn('GPU detection failed, retrying on CPU', err);
    // whoever fails first swaps in the CPU build; anyone else just waits for it
    if (landmarkerP === p) {
      try { L.lm.close(); } catch { /* already gone */ }
      useLandmarker('CPU');
    }
    const C = await getLandmarker();
    return { res: C.lm.detectForVideo(source, stamp(target)), delegate: C.delegate };
  }
}

// Head pose from facialTransformationMatrixes[0]. That 4x4 maps the canonical face
// model into camera space (camera at the origin looking down -Z, +Y up, +X to the
// image's right). MediaPipe packs it column-major: element (row r, col c) is
// data[c * 4 + r] and the translation is data[12..14]. The face's forward axis is
// rotation column 2, f = (data[8], data[9], data[10]); straight at the camera f ≈ (0, 0, 1).
//   yaw   = atan2(f.x, f.z)                 > 0: face turned toward the image's right
//   pitch = atan2(f.y, hypot(f.x, f.z))     > 0: chin up, < 0: looking down (a nod dips negative)
// Both are ratios, so any scale in the matrix cancels out.
function headPose(matrix) {
  const m = matrix && matrix.data;
  if (!m || m.length < 16) return null;
  // If it ever arrives row-major, the translation sits in the last column instead.
  const rowMajor = Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) > Math.abs(m[12]) + Math.abs(m[13]) + Math.abs(m[14]);
  const fx = rowMajor ? m[2] : m[8];
  const fy = rowMajor ? m[6] : m[9];
  const fz = m[10];
  const deg = 180 / Math.PI;
  return { yaw: Math.atan2(fx, fz) * deg, pitch: Math.atan2(fy, Math.hypot(fx, fz)) * deg };
}

function readFrame(res, videoMs) {
  const t = Math.round(videoMs - state.offsetMs);
  const cats = res && res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
  const pose = res && headPose(res.facialTransformationMatrixes && res.facialTransformationMatrixes[0]);
  if (!res || !res.faceLandmarks || !res.faceLandmarks.length || !cats || !pose) {
    return { t, face: false, smile: 0, yaw: 0, pitch: 0, jawOpen: 0, browUp: 0 };
  }
  const score = (name) => {
    const c = cats.find((x) => x.categoryName === name);
    return c ? c.score : 0;
  };
  return {
    t,
    face: true,
    smile: r3((score('mouthSmileLeft') + score('mouthSmileRight')) / 2),
    yaw: r1(pose.yaw),
    pitch: r1(pose.pitch),
    jawOpen: r3(score('jawOpen')),
    browUp: r3(score('browInnerUp')),
  };
}

// ---------- video ----------

function recordingUrl() {
  const r = state.convo.recording;
  return `/api/conversations/${enc(state.id)}/recording?v=${enc(r.uploadedAt || r.bytes || '')}`;
}

function once(target, event, ms) {
  return new Promise((resolve) => {
    let timer = null;
    const done = (ok) => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
      resolve(ok);
    };
    const onEvent = () => done(true);
    const onError = () => done(false);
    target.addEventListener(event, onEvent);
    target.addEventListener('error', onError);
    if (ms) timer = setTimeout(() => done(false), ms);
  });
}

function seek(v, sec) {
  const p = once(v, 'seeked', SEEK_TIMEOUT_MS);
  v.currentTime = sec;
  return p;
}

// MediaRecorder webm files carry no duration, so Chrome reports Infinity until it has
// seen the end. Seeking far past the end makes it go and look.
async function ensureDuration(v) {
  if (isNum(v.duration) && v.duration > 0) return v.duration;
  await new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener('durationchange', onChange);
      resolve();
    };
    const onChange = () => { if (isNum(v.duration)) done(); };
    v.addEventListener('durationchange', onChange);
    timer = setTimeout(done, 6000);
    v.currentTime = 1e7;
  });
  // Only rewind if we're still parked at the end; a user seek during the probe wins.
  if (!isNum(v.duration) || v.currentTime >= v.duration - 0.05) await seek(v, 0);
  return isNum(v.duration) && v.duration > 0 ? v.duration : null;
}

let mainReady = null;
function loadMainVideo() {
  const video = $('video');
  const src = recordingUrl();
  if (state.videoSrc === src) return mainReady;
  state.videoSrc = src;
  state.durMs = null;
  video.src = src;
  mainReady = (async () => {
    const ok = await once(video, 'loadedmetadata', 20000);
    if (!ok) {
      showAnalysisMsg("Couldn't load the video from the server.", true);
      return false;
    }
    const d = await ensureDuration(video);
    if (state.videoSrc !== src) return false;
    state.durMs = d ? d * 1000 : null;
    drawLanes();
    updatePlayhead();
    return true;
  })();
  return mainReady;
}

async function seekToTurn(turnId, { play = true } = {}) {
  const turn = turnsOf(state.convo).find((t) => t.turnId === turnId);
  if (!turn) return;
  setActive(turnId, { scroll: true });
  if (!hasVideo() || state.analysing) return;
  await mainReady;
  if (state.analysing) return;
  const video = $('video');
  video.currentTime = Math.max(0, toVideoMs(turn.startMs) / 1000 - PREROLL_S);
  if (play) video.play().catch(() => {});
}

// ---------- analysis ----------

function showAnalysisMsg(text, isError = false, action = null) {
  const box = $('analysis-msg');
  box.hidden = !text;
  box.classList.toggle('error', isError);
  put(box, text || '', action || '');
}

function setProgress(done, total) {
  $('progress').hidden = false;
  $('progress-fill').style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
}

// Bumping runId makes any analysis still in flight drop out at its next frame.
function abortAnalysis() {
  state.runId += 1;
  state.analysing = false;
}

async function analyse() {
  if (state.analysing || !hasVideo()) return;
  const run = ++state.runId;
  const recAt = state.convo.recording.uploadedAt;
  // a re-upload bumps runId through syncFrames, but check the video itself too
  const live = () => state.runId === run && !!state.convo && !!state.convo.recording && state.convo.recording.uploadedAt === recAt;
  state.analysing = true;
  state.pendingUpload = null;
  const main = $('video');
  main.pause();
  renderAnalysisBar();
  showAnalysisMsg('');
  $('word-status').textContent = 'Loading the face model…';
  setProgress(0, 1);
  document.body.classList.add('is-analysing');

  const frames = [];
  state.frames = frames;
  state.framesFrom = 'run';
  state.nods = [];
  let delegate = '';
  const v = document.createElement('video');
  try {
    await getLandmarker();
    if (!live()) return;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = recordingUrl();
    if (!(await once(v, 'loadedmetadata', 20000))) throw new Error("Couldn't load the video for analysis.");
    const dur = await ensureDuration(v);
    if (!dur) throw new Error("Couldn't work out how long the video is.");
    const durMs = dur * 1000;
    if (!state.durMs) state.durMs = durMs;

    const total = Math.max(1, Math.ceil(durMs / STEP_MS));
    const base = clock + 1000;
    const started = performance.now();
    for (let i = 0; i < total; i++) {
      if (!live()) return;
      const videoMs = i * STEP_MS;
      const ok = await seek(v, videoMs / 1000);
      if (!live()) return;
      let res = null;
      if (ok && v.readyState >= 2) {
        const out = await detect(v, base + videoMs);
        res = out.res;
        delegate = out.delegate;
      }
      const frame = readFrame(res, videoMs);
      frames.push(frame);
      drawOverlay(v, res, { withImage: true });
      updateMeters(frame, frame.t);
      updatePlayhead(videoMs);
      setProgress(i + 1, total);
      const secs = (performance.now() - started) / 1000;
      const speed = secs > 0 ? (videoMs / 1000) / secs : 0;
      $('word-status').textContent = 'Analyzing video…';
      $('analysis-meta').textContent = `frame ${i + 1} of ${total} · ${speed >= 0.1 ? `${speed.toFixed(1)}× real time` : '…'}${delegate ? ` · ${delegate}` : ''}`;
      if (i % 8 === 0 || i === total - 1) {
        state.nods = findNods(frames);
        drawLanes();
      }
    }
    state.nods = findNods(frames);
    if (!live()) return;

    const seen = frames.filter((f) => f.face).length;
    const secs = (performance.now() - started) / 1000;
    $('analysis-meta').textContent = `${frames.length} frames in ${secs.toFixed(1)} s · face in view ${Math.round((seen / frames.length) * 100)}%${delegate ? ` · ${delegate}` : ''}`;
    saveFramesLocally(frames, recAt);
    state.analysing = false;
    clearOverlay();
    if (!seen) {
      showAnalysisMsg("No face found in this video. The camera needs to see the other person's face to measure smiling, facing or nodding.");
    }
    await upload(frames, recAt);
  } catch (err) {
    if (!live()) { clearOverlay(); return; }
    console.error('analysis failed', err);
    state.analysing = false;
    clearOverlay();
    showAnalysisMsg(`Analysis stopped: ${err && err.message ? err.message : 'something went wrong'}.`, true,
      el('button', { class: 'rp-btn rp-btn-quiet', type: 'button', text: 'Try again', on: { click: () => analyse() } }));
  } finally {
    v.removeAttribute('src');
    v.load();
    if (!live()) clearOverlay();
    if (state.runId === run) {
      state.analysing = false;
      document.body.classList.remove('is-analysing');
      renderAnalysisBar();
      drawLanes();
      updatePlayhead();
    }
  }
}

const sameVideo = (recAt) => !!(state.convo && state.convo.recording && state.convo.recording.uploadedAt === recAt);

async function upload(frames, recAt) {
  if (!sameVideo(recAt)) return;
  state.pendingUpload = frames;
  state.uploading = true;
  showAnalysisMsg('');
  renderAnalysisBar();
  $('word-status').textContent = 'Lining the cues up with the transcript…';
  try {
    const body = { model: MODEL, fps: FPS, frames, recordingUploadedAt: recAt };
    const data = await postJson(`/api/conversations/${enc(state.id)}/behavior`, body);
    state.pendingUpload = null;
    // The video was replaced while the server was busy: these cues belong to the old one.
    if (!sameVideo(recAt)) return;
    if (data && data.behavior) state.convo.behavior = data.behavior;
    if (data && 'insight' in data) state.convo.insight = data.insight;
    renderAll();
  } catch (err) {
    if (err.status === 409 || !sameVideo(recAt)) {
      // the server has a newer video; renderAll will pick it up and analyse that one
      state.pendingUpload = null;
      showAnalysisMsg('The video was replaced while this ran, so these cues were dropped.');
      return;
    }
    showAnalysisMsg(`Couldn't save the cues: ${err.message}`, true,
      el('button', { class: 'rp-btn rp-btn-quiet', type: 'button', text: 'Send again', on: { click: () => upload(frames, recAt) } }));
  } finally {
    state.uploading = false;
    renderAnalysisBar();
  }
}

function renderAnalysisBar() {
  const box = $('analysis');
  const video = hasVideo();
  box.hidden = !video;
  if (!video) return;
  const b = state.convo.behavior;
  const busy = state.analysing;
  const uploading = state.uploading;
  $('analyze-btn').hidden = busy || !!b || uploading;
  $('analyze-btn').disabled = busy;
  $('rerun-btn').hidden = busy || !b || uploading;
  $('live-toggle-wrap').hidden = busy;
  if (!busy) $('progress').hidden = true;
  if (busy || uploading) return;
  if (b) {
    const seen = pct(b.faceSeenPct > 1 ? b.faceSeenPct / 100 : b.faceSeenPct);
    $('word-status').textContent = 'Analysed';
    if (!$('analysis-meta').textContent || state.framesFrom !== 'run') {
      $('analysis-meta').textContent = [
        isNum(b.frameCount) ? `${b.frameCount} frames` : null,
        seen !== null ? `face in view ${seen}%` : null,
        b.model ? String(b.model).replace('mediapipe-face-landmarker@', 'Face Landmarker ') : null,
      ].filter(Boolean).join(' · ');
    }
    if (seen === 0) showAnalysisMsg("No face found in this video. The camera needs to see the other person's face to measure smiling, facing or nodding.");
  } else if (!state.pendingUpload) {
    $('word-status').textContent = 'Not analysed yet';
    $('analysis-meta').textContent = 'Face Landmarker runs here in Chrome, 5 frames per second of video.';
  }
}

// ---------- overlay + meters ----------

function contentRect(boxW, boxH, vw, vh) {
  if (!vw || !vh) return { x: 0, y: 0, w: boxW, h: boxH };
  const s = Math.min(boxW / vw, boxH / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

function sizeCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function clearOverlay() {
  const c = $('overlay');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  state.lastResult = null;
}

// Landmark dots plus a corner-bracket box. withImage paints the analysed frame too,
// so the room sees the model working while the real player sits paused.
function drawOverlay(source, res, { withImage = false } = {}) {
  const canvas = $('overlay');
  const box = $('player');
  const W = box.clientWidth;
  const H = box.clientHeight;
  const ctx = sizeCanvas(canvas, W, H);
  ctx.clearRect(0, 0, W, H);
  const r = contentRect(W, H, source.videoWidth, source.videoHeight);
  if (withImage) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    try { ctx.drawImage(source, r.x, r.y, r.w, r.h); } catch { /* frame not ready */ }
  }
  state.lastResult = res;
  const pts = res && res.faceLandmarks && res.faceLandmarks[0];
  if (!pts) return;
  const them = cssVar('--them-hi') || '#86bba6';
  const you = cssVar('--you-hi') || '#ebb04f';
  let minX = 1; let minY = 1; let maxX = 0; let maxY = 0;
  ctx.fillStyle = them;
  ctx.globalAlpha = 0.85;
  const dot = Math.max(1, r.w / 420);
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    ctx.fillRect(r.x + p.x * r.w - dot / 2, r.y + p.y * r.h - dot / 2, dot, dot);
  }
  ctx.globalAlpha = 1;
  const pad = 0.04;
  const x0 = r.x + Math.max(0, minX - pad) * r.w;
  const y0 = r.y + Math.max(0, minY - pad) * r.h;
  const x1 = r.x + Math.min(1, maxX + pad) * r.w;
  const y1 = r.y + Math.min(1, maxY + pad) * r.h;
  const arm = Math.min(x1 - x0, y1 - y0) * 0.22;
  ctx.strokeStyle = you;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
    ctx.moveTo(cx + dx * arm, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * arm);
  }
  ctx.stroke();
}

// frame: BehaviorFrame or null. t: transcript ms (for the nod flash).
function updateMeters(frame, t) {
  const meters = $('meters');
  meters.hidden = !hasVideo() || (!frame && !state.frames && !state.analysing);
  if (meters.hidden) return;
  const set = (id, val, fill, cls) => {
    const m = $(id);
    m.querySelector('.rp-meter-val').textContent = val;
    m.classList.toggle('off', cls === 'off');
    m.classList.toggle('on', cls === 'on');
    if (fill !== undefined) {
      const f = m.querySelector('.rp-meter-fill');
      if (f) f.style.width = `${Math.round(Math.max(0, Math.min(1, fill)) * 100)}%`;
      const d = m.querySelector('.rp-meter-dot');
      if (d) d.style.left = `${50 + Math.max(-1, Math.min(1, fill)) * 45}%`;
    }
  };
  if (!frame || !frame.face) {
    const word = frame ? 'no face' : '—';
    set('m-smile', word, 0, 'off');
    set('m-facing', word, 0, 'off');
    set('m-nod', word, undefined, 'off');
    return;
  }
  set('m-smile', `${pct(frame.smile)}%`, frame.smile, frame.smile >= 0.3 ? 'on' : null);
  const f = facing(frame);
  set('m-facing', f ? 'facing' : `turned ${Math.round(Math.abs(frame.yaw))}°`, frame.yaw / 45, f ? 'on' : null);
  const nodding = state.nods.some((n) => n <= t && t - n < 900) || liveNod(t);
  set('m-nod', nodding ? 'nod' : '—', undefined, nodding ? 'on' : null);
}

function liveNod(t) {
  if (state.liveFrames.length < 4) return false;
  const nods = findNods(state.liveFrames);
  return nods.some((n) => n <= t && t - n < 900);
}

// Live overlay while the real video plays: throttled, never during an analysis run.
async function liveDetect() {
  const video = $('video');
  if (state.liveBusy || state.analysing || !$('live-toggle').checked || video.readyState < 2) return;
  const now = performance.now();
  if (now - state.lastLiveAt < LIVE_EVERY_MS) return;
  state.liveBusy = true;
  const at = state.lastLiveAt;
  state.lastLiveAt = now;
  try {
    const { res } = await detect(video, clock + Math.max(1, at ? now - at : LIVE_EVERY_MS));
    if (state.analysing) return;
    const videoMs = video.currentTime * 1000;
    const frame = readFrame(res, videoMs);
    const lf = state.liveFrames;
    if (lf.length && frame.t < lf[lf.length - 1].t) lf.length = 0; // jumped back
    lf.push(frame);
    while (lf.length && frame.t - lf[0].t > 2500) lf.shift();
    drawOverlay(video, res);
    updateMeters(frame, frame.t);
  } catch (err) {
    console.warn('live overlay off', err);
    $('live-toggle').checked = false;
    clearOverlay();
  } finally {
    state.liveBusy = false;
  }
}

// ---------- timeline ----------

function domainMs() {
  const turns = turnsOf(state.convo);
  const lastTurn = turns.length ? Math.max(...turns.map((t) => toVideoMs(t.endMs || t.startMs || 0))) : 0;
  const fs = state.frames;
  const lastFrame = fs && fs.length ? toVideoMs(fs[fs.length - 1].t) + STEP_MS : 0;
  return Math.max(state.durMs || 0, lastTurn, lastFrame, 1000);
}

function laneTops() {
  const tops = {};
  let y = 0;
  for (const l of LANES) {
    tops[l.key] = y;
    y += l.h + LANE_GAP;
  }
  return { tops, axisTop: y - LANE_GAP + 4, height: y - LANE_GAP + 4 + AXIS_H };
}

function buildLaneLabels() {
  const box = document.querySelector('.rp-lane-labels');
  put(box, ...LANES.map((l) => el('span', { style: `height:${l.h}px;margin-bottom:${LANE_GAP}px`, text: l.label })));
  box.style.paddingBottom = `${AXIS_H + 4 - LANE_GAP}px`;
}

function drawLanes() {
  const track = $('track');
  const canvas = $('lanes-canvas');
  const W = track.clientWidth;
  if (!W || !state.convo) return;
  const { tops, axisTop, height } = laneTops();
  track.style.height = `${height}px`;
  const ctx = sizeCanvas(canvas, W, height);
  canvas.style.height = `${height}px`;
  ctx.clearRect(0, 0, W, height);

  const D = domainMs();
  const x = (videoMs) => (videoMs / D) * W;
  const col = {
    you: cssVar('--you'), them: cssVar('--them'), line: cssVar('--line'), muted: cssVar('--muted'),
    lane: cssVar('--surface'), ink: cssVar('--ink'), smile: cssVar('--smile') || cssVar('--you'),
  };

  for (const l of LANES) {
    ctx.fillStyle = col.lane;
    roundRect(ctx, 0, tops[l.key], W, l.h, 6);
    ctx.fill();
  }

  const turns = turnsOf(state.convo);
  const bts = behaviorTurns();

  // who's talking: you on top, them underneath
  const talkTop = tops.talk;
  const half = LANES[0].h / 2;
  for (const t of turns) {
    const side = sideOf(t, bts.get(t.turnId));
    const x0 = x(toVideoMs(t.startMs));
    const w = Math.max(2, x(toVideoMs(t.endMs)) - x0);
    ctx.fillStyle = side === 'you' ? col.you : side === 'them' ? col.them : col.muted;
    const y = side === 'you' ? talkTop + 3 : side === 'them' ? talkTop + half + 1 : talkTop + half / 2 + 2;
    roundRect(ctx, x0, y, w, half - 4, 3);
    ctx.fill();
  }

  const fs = state.frames;
  const smileTop = tops.smile;
  const smileH = LANES[1].h;
  const sy = (v) => smileTop + smileH - 3 - Math.max(0, Math.min(1, v)) * (smileH - 6);
  const b = state.convo.behavior;

  if (fs && fs.length) {
    // smile line, broken wherever the face drops out
    ctx.strokeStyle = col.smile;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.fillStyle = withAlpha(col.smile, 0.16);
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        ctx.beginPath();
        run.forEach((f, i) => (i ? ctx.lineTo(x(toVideoMs(f.t)), sy(f.smile)) : ctx.moveTo(x(toVideoMs(f.t)), sy(f.smile))));
        ctx.stroke();
        ctx.lineTo(x(toVideoMs(run[run.length - 1].t)), smileTop + smileH - 3);
        ctx.lineTo(x(toVideoMs(run[0].t)), smileTop + smileH - 3);
        ctx.closePath();
        ctx.fill();
      } else if (run.length === 1) {
        ctx.fillRect(x(toVideoMs(run[0].t)) - 1, sy(run[0].smile) - 1, 3, 3);
      }
      run = [];
    };
    let prev = null;
    for (const f of fs) {
      if (!f.face || (prev && f.t - prev.t > 2.5 * STEP_MS)) flush();
      if (f.face) run.push(f);
      prev = f;
    }
    flush();

    // facing band
    const fy = tops.facing;
    const fh = LANES[2].h;
    for (const f of fs) {
      if (!f.face) continue;
      ctx.fillStyle = facing(f) ? col.them : withAlpha(col.muted, 0.35);
      ctx.fillRect(x(toVideoMs(f.t)), fy + 2, Math.max(1, x(STEP_MS) + 0.5), fh - 4);
    }

    // nod ticks
    ctx.strokeStyle = col.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const n of state.nods) {
      const nx = x(toVideoMs(n));
      ctx.moveTo(nx, tops.nods + 3);
      ctx.lineTo(nx, tops.nods + LANES[3].h - 3);
    }
    ctx.stroke();
  } else if (b && bts.size) {
    // No per-frame data on this browser: per-turn steps from the server's numbers.
    for (const t of turns) {
      const bt = bts.get(t.turnId);
      if (!bt || bt.smile == null) continue;
      const x0 = x(toVideoMs(t.startMs));
      const w = Math.max(2, x(toVideoMs(t.endMs)) - x0);
      ctx.fillStyle = withAlpha(col.smile, 0.3);
      ctx.fillRect(x0, sy(bt.smile), w, smileTop + smileH - 3 - sy(bt.smile));
      ctx.fillStyle = withAlpha(col.them, Math.max(0.12, bt.facingPct || 0));
      ctx.fillRect(x0, tops.facing + 2, w, LANES[2].h - 4);
      ctx.strokeStyle = col.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < (bt.nods || 0); i++) {
        const nx = x0 + (w * (i + 1)) / ((bt.nods || 0) + 1);
        ctx.moveTo(nx, tops.nods + 3);
        ctx.lineTo(nx, tops.nods + LANES[3].h - 3);
      }
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = col.muted;
    ctx.font = `italic 13px ${cssVar('--serif') || 'Georgia, serif'}`;
    ctx.textBaseline = 'middle';
    const msg = hasVideo() ? 'Face cues show up here once the video is analysed.' : 'No video, so no face cues.';
    ctx.fillText(msg, 10, smileTop + smileH / 2);
  }

  // their usual smile, dashed
  const base = b && b.baseline && b.baseline.smile;
  if (isNum(base)) {
    ctx.strokeStyle = col.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, sy(base));
    ctx.lineTo(W, sy(base));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // time axis
  ctx.fillStyle = col.muted;
  ctx.font = `500 11px ${cssVar('--sans') || 'system-ui'}`;
  ctx.textBaseline = 'top';
  const step = niceStep(D, W);
  for (let ms = 0; ms <= D; ms += step) {
    const tx = x(ms);
    ctx.fillRect(tx, axisTop - 4, 1, 4);
    const label = fmtClock(ms);
    const lw = ctx.measureText(label).width;
    ctx.fillText(label, Math.min(W - lw, Math.max(0, tx - lw / 2)), axisTop + 1);
  }

  renderMarkers(tops.marks, LANES[4].h, D);
}

function niceStep(D, W) {
  const target = D / Math.max(2, W / 90);
  for (const s of [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]) if (s >= target) return s;
  return 600000;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function withAlpha(color, a) {
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) {
    const n = parseInt(c.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return `color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent)`;
}

function renderMarkers(top, h, D) {
  const box = $('markers');
  box.style.top = `${top}px`;
  box.style.height = `${h}px`;
  const marks = markersByTurn(state.convo);
  const turns = new Map(turnsOf(state.convo).map((t) => [t.turnId, t]));
  const order = ['follow', 'missed', 'cited', 'insight'];
  put(box, ...[...marks.entries()].filter(([id]) => turns.has(id)).map(([id, kinds]) => {
    const t = turns.get(id);
    const sorted = order.filter((k) => kinds.has(k));
    const title = `${fmtClock(t.startMs)} · ${markerTitle(id, kinds)}`;
    return el('button', {
      class: `rp-marker ${sorted.map((k) => `mk-${k}`).join(' ')}`,
      type: 'button',
      style: `left:clamp(12px, ${(toVideoMs(t.startMs) / D) * 100}%, calc(100% - 12px))`,
      title,
      'aria-label': title,
      on: { click: (e) => { e.stopPropagation(); seekToTurn(id); } },
    }, ...sorted.map((k) => el('span', { class: `rp-mk mk-${k}`, text: MARKS[k].sym })));
  }));
}

function updatePlayhead(videoMsOverride) {
  const head = $('playhead');
  if (!state.convo || (!hasVideo())) { head.hidden = true; return; }
  const video = $('video');
  const ms = videoMsOverride ?? video.currentTime * 1000;
  const D = domainMs();
  head.hidden = false;
  head.style.left = `${Math.max(0, Math.min(1, ms / D)) * 100}%`;
  $('playhead-time').textContent = fmtClock(ms - state.offsetMs);
}

function trackMs(e) {
  const r = $('track').getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * domainMs();
}

async function onTrackClick(e) {
  if (!state.convo) return;
  const videoMs = trackMs(e);
  const t = videoMs - state.offsetMs;
  if (hasVideo() && !state.analysing) {
    await mainReady;
    $('video').currentTime = videoMs / 1000;
    updatePlayhead(videoMs);
  } else {
    const turn = turnAt(t);
    if (turn) setActive(turn.turnId, { scroll: true });
  }
}

function onTrackHover(e) {
  const hover = $('hover');
  if (!state.convo) return;
  const videoMs = trackMs(e);
  const r = $('track').getBoundingClientRect();
  hover.hidden = false;
  hover.style.left = `${e.clientX - r.left}px`;
  const f = frameAt(videoMs - state.offsetMs);
  hover.textContent = f && f.face
    ? `${fmtClock(videoMs - state.offsetMs)} · smile ${pct(f.smile)}% · ${facing(f) ? 'facing' : 'turned away'}`
    : fmtClock(videoMs - state.offsetMs);
}

// ---------- transcript ----------

function turnAt(t) {
  const turns = turnsOf(state.convo);
  let best = null;
  for (const turn of turns) {
    if (turn.startMs <= t) best = turn;
    else break;
  }
  return best;
}

function setActive(turnId, { scroll = false } = {}) {
  if (state.activeTurn === turnId && !scroll) return;
  state.activeTurn = turnId;
  const list = $('lines');
  for (const li of list.querySelectorAll('.rp-line.active')) li.classList.remove('active');
  const li = list.querySelector(`.rp-line[data-turn="${turnId}"]`);
  if (!li) return;
  li.classList.add('active');
  const box = $('script-scroll');
  const top = li.offsetTop - box.clientHeight * 0.28;
  const visible = li.offsetTop >= box.scrollTop + 8 && li.offsetTop + li.offsetHeight <= box.scrollTop + box.clientHeight - 8;
  if (scroll || !visible) box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function cueChips(turn, side, bt, b) {
  if (!b || !bt) return null;
  const chips = [];
  if (side === 'them') {
    if (bt.smile == null) {
      chips.push(el('span', { class: 'rp-chip dim', text: 'face not in view' }));
    } else {
      chips.push(el('span', { class: 'rp-chip', title: `Mean smile over this line (peak ${pct(bt.smilePeak) ?? '—'}%). Their usual: ${pct(b.baseline && b.baseline.smile) ?? '—'}%.`, text: `smile ${pct(bt.smile)}%` }));
      if (isNum(bt.facingPct)) chips.push(el('span', { class: 'rp-chip', title: 'Share of frames where their head pointed at the camera', text: `facing ${pct(bt.facingPct)}%` }));
      if (isNum(bt.nods)) chips.push(el('span', { class: 'rp-chip', text: plural(bt.nods, 'nod') }));
    }
    if (bt.congruence === 'match' || bt.congruence === 'mixed') {
      const base = b.baseline || {};
      const tip = `Compared the tone of the words (${bt.textTone || 'neutral'}, from a word list) with their face on this line: `
        + `smile ${pct(bt.smile) ?? '—'}% vs their usual ${pct(base.smile) ?? '—'}%, `
        + `animation ${isNum(bt.animation) ? bt.animation.toFixed(2) : '—'} vs usual ${isNum(base.animation) ? base.animation.toFixed(2) : '—'}. `
        + (bt.congruence === 'match' ? 'They point the same way.' : "They don't point the same way.")
        + ' Observable cues only, not feelings or sincerity.';
      chips.push(el('span', { class: `rp-chip cong ${bt.congruence}`, title: tip, tabindex: '0', text: bt.congruence }));
    }
  } else if (side === 'you') {
    const r = bt.reaction;
    if (r && isNum(r.smileDelta)) {
      const bits = [`they smiled ${signed(r.smileDelta)} after this`];
      if (isNum(r.nods) && r.nods > 0) bits.push(plural(r.nods, 'nod'));
      chips.push(el('span', {
        class: `rp-chip react ${r.smileDelta > 0.02 ? 'up' : r.smileDelta < -0.02 ? 'down' : ''}`.trim(),
        title: 'Change in their smile over the 2.5 s after you stopped talking, against the moment you stopped',
        text: bits.join(' · '),
      }));
    } else if (r === null) {
      chips.push(el('span', { class: 'rp-chip dim', text: 'no face in view after this' }));
    }
  }
  return chips.length ? el('span', { class: 'rp-chips' }, ...chips) : null;
}

function renderTranscript() {
  const c = state.convo;
  const turns = turnsOf(c);
  const list = $('lines');
  if (!turns.length) {
    list.replaceChildren(el('li', { class: 'rp-empty', text: 'No transcript for this one.' }));
    return;
  }
  const labels = speakerLabels(turns);
  const bts = behaviorTurns();
  const marks = markersByTurn(c);
  const b = c.behavior;
  list.replaceChildren(...turns.map((t) => {
    const bt = bts.get(t.turnId);
    const side = sideOf(t, bt);
    const kinds = marks.get(t.turnId);
    const sideCls = side ? `is-${side}` : `spk-${Math.max(0, labels.indexOf(t.speaker))}`;
    return el('li', { class: `rp-line ${sideCls}${t.turnId === state.activeTurn ? ' active' : ''}`, 'data-turn': t.turnId },
      el('button', { class: 'rp-line-btn', type: 'button', on: { click: () => seekToTurn(t.turnId) } },
        el('span', { class: 'rp-who' },
          el('span', { text: speakerName(t, side, labels) }),
          el('span', { class: 'rp-time', text: fmtClock(t.startMs) }),
        ),
        el('span', { class: 'rp-said' },
          kinds ? el('span', { class: 'rp-line-marks', title: markerTitle(t.turnId, kinds) },
            ...['follow', 'missed', 'cited', 'insight'].filter((k) => kinds.has(k)).map((k) => el('span', { class: `rp-mk mk-${k}`, text: MARKS[k].sym }))) : null,
          el('span', { class: 'rp-said-text', text: t.text || '' }),
          cueChips(t, side, bt, b),
        ),
      ),
    );
  }));
}

// ---------- the proof + advice ----------

function renderProof() {
  const box = $('proof');
  const c = state.convo;
  const b = c.behavior;
  const head = el('p', { class: 'rp-kicker', text: 'Did the advice hold up? The numbers' });
  if (!hasVideo()) {
    put(box, head, el('p', { class: 'rp-proof-empty', text: 'No video for this conversation, so there are no on-camera reactions to compare.' }));
    return;
  }
  if (!b || !b.stats) {
    put(box, head, el('p', { class: 'rp-proof-empty', text: state.analysing
      ? 'Measuring their reactions…'
      : 'Analyse the video to see how they reacted after your follow-up questions compared with your other lines.' }));
    return;
  }
  const s = b.stats;
  const af = s.afterFollowUps || {};
  const ao = s.afterOther || {};
  const name = otherName();
  const nameCap = name.charAt(0).toUpperCase() + name.slice(1);
  let line;
  if (af.n > 0 && isNum(af.smileDelta)) {
    line = el('p', { class: 'rp-proof-line' },
      `After your follow-up questions ${name} smiled `,
      el('strong', { class: af.smileDelta > 0 ? 'up' : 'flat', text: signed(af.smileDelta) }),
      ` on average (n=${af.n})`,
      isNum(ao.smileDelta) && ao.n > 0 ? ` vs ${signed(ao.smileDelta)} after your other lines (n=${ao.n}).` : '.',
    );
  } else if (af.n > 0) {
    line = el('p', { class: 'rp-proof-line', text: `${nameCap}'s face wasn't in view after your follow-up questions, so there's nothing to compare yet.` });
  } else {
    line = el('p', { class: 'rp-proof-line', text: isNum(ao.smileDelta) && ao.n > 0
      ? `No follow-up questions this time. After your lines ${name} smiled ${signed(ao.smileDelta)} on average (n=${ao.n}).`
      : 'No follow-up questions this time, so there is nothing to compare yet.' });
  }

  const bars = (af.n > 0 && isNum(af.smileDelta)) || (ao.n > 0 && isNum(ao.smileDelta))
    ? deltaBars([
      { label: 'After follow-ups', v: af.n > 0 ? af.smileDelta : null, n: af.n, nods: af.nods, cls: 'follow' },
      { label: 'After other lines', v: ao.n > 0 ? ao.smileDelta : null, n: ao.n, nods: ao.nods, cls: 'other' },
    ])
    : null;

  const nodBits = [];
  if (af.n > 0 && isNum(af.nods)) nodBits.push(`${fmtAvg(af.nods)} nods after follow-ups`);
  if (ao.n > 0 && isNum(ao.nods)) nodBits.push(`${fmtAvg(ao.nods)} after other lines`);
  const missed = Array.isArray(s.missedBidReactions) ? s.missedBidReactions.filter((m) => isNum(m.smileDelta)) : [];
  const missedAvg = missed.length ? missed.reduce((a, m) => a + m.smileDelta, 0) / missed.length : null;
  const small = (af.n || 0) < 3 || (ao.n || 0) < 3;

  put(box, 
    head,
    line,
    bars,
    nodBits.length ? el('p', { class: 'rp-proof-sub', text: `Nods: ${nodBits.join(' vs ')}, on average.` }) : null,
    missedAvg !== null ? el('p', { class: 'rp-proof-sub', text: `After your replies to missed moments: ${signed(missedAvg)} (n=${missed.length}).` }) : null,
    el('p', { class: 'rp-proof-foot', text: [
      'Smile change in the 2.5 s after you stopped talking.',
      small ? 'Small sample, so read it as a hint, not proof.' : null,
    ].filter(Boolean).join(' ') }),
  );
}

const fmtAvg = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function deltaBars(rows) {
  const max = Math.max(0.1, ...rows.map((r) => Math.abs(r.v || 0)));
  return el('div', { class: 'rp-dbars' }, ...rows.map((r) => {
    const w = isNum(r.v) ? (Math.abs(r.v) / max) * 50 : 0;
    const style = isNum(r.v) && r.v < 0 ? `right:50%;width:${w}%` : `left:50%;width:${w}%`;
    return el('div', { class: `rp-dbar ${r.cls}` },
      el('span', { class: 'rp-dbar-label', text: r.label }),
      el('span', { class: 'rp-dbar-track' },
        el('span', { class: 'rp-dbar-zero' }),
        el('span', { class: `rp-dbar-fill${isNum(r.v) && r.v < 0 ? ' neg' : ''}`, style })),
      el('span', { class: 'rp-dbar-val', text: isNum(r.v) ? signed(r.v) : '—' }),
    );
  }));
}

function turnChip(turnId) {
  const t = turnsOf(state.convo).find((x) => x.turnId === turnId);
  if (!t) return null;
  const labels = speakerLabels(turnsOf(state.convo));
  const who = speakerName(t, sideOf(t, behaviorTurns().get(turnId)), labels);
  return el('button', {
    class: 'rp-seek', type: 'button',
    title: t.text ? `“${t.text.slice(0, 140)}${t.text.length > 140 ? '…' : ''}”` : null,
    on: { click: () => seekToTurn(turnId) },
  }, el('span', { class: 'rp-play', 'aria-hidden': 'true', text: '▶' }), `${fmtClock(t.startMs)} · ${who}`);
}

function renderAdvice() {
  const c = state.convo;
  const note = c.note;
  const shown = note && note.text && note.status !== 'dropped';
  $('note').hidden = !shown;
  if (shown) {
    $('note-text').textContent = note.text;
    $('note-sugg').textContent = note.suggestion || '';
  }
  const none = $('note-none');
  none.hidden = !!shown;
  none.textContent = !note
    ? 'No coaching note yet. It appears once the phone finishes coaching.'
    : note.reason === 'too_short' ? 'Too short to coach.' : 'No advice this time, just the counts.';

  const ins = c.insight;
  const check = $('check');
  const source = ins ? el('span', { class: `rp-source ${ins.source === 'muse-spark' ? 'ai' : ''}`, text: ins.source === 'muse-spark' ? 'Written by Muse Spark from the measured cues' : 'Written by rules, no AI' }) : null;
  const rows = ins && Array.isArray(ins.adviceCheck) ? ins.adviceCheck : [];
  if (!ins) {
    const waiting = c.behavior && state.uploading ? 'Muse Spark is checking the advice against the cues…'
      : c.behavior ? 'No check yet.'
        : hasVideo() ? 'The check shows up after the video is analysed.' : 'Needs a video to check against.';
    put(check, 
      el('p', { class: 'rp-kicker', text: 'Checked against the video' }),
      el('p', { class: 'rp-dim', text: waiting }),
    );
  } else {
    put(check, 
      el('p', { class: 'rp-kicker' }, 'Checked against the video ', source),
      rows.length ? el('ol', { class: 'rp-checks' }, ...rows.map((r) => {
        const v = VERDICTS[r.verdict] ? r.verdict : 'not yet';
        return el('li', { class: 'rp-check-row' },
          el('span', { class: `rp-verdict v-${v.replace(' ', '-')}`, text: VERDICTS[v] }),
          el('div', { class: 'rp-check-body' },
            el('p', { class: 'rp-check-advice', text: r.advice || '' }),
            r.reason ? el('p', { class: 'rp-check-reason', text: r.reason }) : null,
            Array.isArray(r.evidenceTurnIds) && r.evidenceTurnIds.length
              ? el('div', { class: 'rp-seeks' }, ...r.evidenceTurnIds.map(turnChip)) : null,
          ),
        );
      })) : el('p', { class: 'rp-dim', text: 'No advice to check this time.' }),
    );
  }

  renderHooks();

  const moments = ins && Array.isArray(ins.moments) ? ins.moments : [];
  const mbox = $('moments');
  if (!moments.length) {
    put(mbox, 
      el('p', { class: 'rp-kicker', text: 'Moments worth replaying' }),
      el('p', { class: 'rp-dim', text: ins ? 'Nothing stood out this time.' : 'These show up after the video is analysed.' }),
    );
    return;
  }
  put(mbox, 
    el('p', { class: 'rp-kicker', text: 'Moments worth replaying' }),
    el('ol', { class: 'rp-moment-list' }, ...moments.map((m) => {
      const t = turnsOf(c).find((x) => x.turnId === m.turnId);
      return el('li', {},
        el('button', { class: 'rp-moment', type: 'button', on: { click: () => seekToTurn(m.turnId) } },
          el('span', { class: 'rp-moment-head' },
            el('span', { class: 'rp-mk mk-insight', 'aria-hidden': 'true', text: '◆' }),
            el('span', { class: 'rp-moment-title', text: m.title || 'Moment' }),
            t ? el('span', { class: 'rp-moment-time' }, el('span', { class: 'rp-play', 'aria-hidden': 'true', text: '▶' }), fmtClock(t.startMs)) : null,
          ),
          m.observation ? el('span', { class: 'rp-moment-obs', text: m.observation }) : null,
          m.why ? el('span', { class: 'rp-moment-why', text: m.why }) : null,
        ),
      );
    })),
  );
}

// What the transcript layer found (no AI). Mostly for conversations without video,
// but it's the same data the markers come from, so it stays on for all of them.
function renderHooks() {
  const box = $('hooks');
  const h = state.convo.hooks;
  if (!h) { box.hidden = true; box.replaceChildren(); return; }
  const list = (k) => (Array.isArray(h[k]) ? h[k] : []);
  const chip = (text, turnId, cls = '') => (Number.isInteger(turnId)
    ? el('button', { class: `rp-hook-chip ${cls}`.trim(), type: 'button', title: 'Play this moment', on: { click: () => seekToTurn(turnId) } }, text)
    : el('span', { class: `rp-hook-chip ${cls}`.trim(), text }));
  const groups = [
    ['Topics', list('topics').map((t) => chip(t.term, Array.isArray(t.turnIds) ? t.turnIds[0] : null))],
    ['Coming up', list('events').map((e) => chip(e.text, e.turnId))],
    ['You promised', list('commitments').map((c) => chip(c.text, c.turnId))],
    ['Missed moments', list('missedBids').map((b) => chip(b.cue, b.turnId, 'missed'))],
  ].filter(([, items]) => items.length);
  const qs = list('followUpDetector');
  if (!groups.length && !qs.length) { box.hidden = true; box.replaceChildren(); return; }
  put(box,
    el('p', { class: 'rp-kicker' }, 'What we picked up ', el('span', { class: 'rp-source', text: 'from the transcript, no AI' })),
    ...groups.map(([label, items]) => el('div', { class: 'rp-hook-group' },
      el('span', { class: 'rp-hook-label', text: label }),
      el('span', { class: 'rp-hook-chips' }, ...items))),
    qs.length ? el('p', { class: 'rp-hook-group' },
      el('span', { class: 'rp-hook-label', text: 'Follow-up detector' }),
      el('span', { text: `${qs.filter((q) => q.isFollowUp).length} of ${qs.length} questions built on what they said` })) : null,
  );
  box.hidden = false;
}

// ---------- word heatmap ----------

// Refetch only when something the scores depend on changed.
function heatKey(c) {
  const b = c.behavior;
  return [state.recKey, b ? b.frameCount : '', b ? b.faceSeenPct : '', c.userLabel,
    c.hooks ? JSON.stringify(c.hooks).length : 0, turnsOf(c).length].join('|');
}

function ensureHeatmap() {
  const c = state.convo;
  const key = heatKey(c);
  if (state.heat.key === key) return;
  state.heat.key = key;
  getJson(`/api/conversations/${enc(state.id)}/heatmap`)
    .then((d) => {
      if (state.heat.key !== key) return;
      state.heat.data = d;
      renderHeatmap();
    })
    .catch(() => {
      if (state.heat.key !== key) return;
      state.heat.data = null;
      renderHeatmap();
    });
}

// score -1..1 -> a background tint; strong scores get more colour
function tint(score, good) {
  const a = Math.round(Math.min(1, Math.abs(score)) * 42 + 10);
  return `background:color-mix(in srgb, var(${good ? '--good' : '--bad'}) ${a}%, transparent)`;
}

function showWhy(text) {
  $('heat-why').textContent = text || 'Hover or tap a coloured word to see why. Click a line to play it.';
}

function renderHeatmap() {
  const box = $('heat');
  const d = state.heat.data;
  const turns = d && Array.isArray(d.turns) ? d.turns : [];
  if (!turns.length) { box.hidden = true; return; }
  box.hidden = false;
  const legend = Array.isArray(d.legend) ? d.legend : [];
  const good = new Map(legend.map((l) => [l.kind, !!l.good]));
  put($('heat-legend'),
    ...legend.map((l) => el('li', { class: `rp-heat-key ${l.good ? 'good' : 'bad'}` },
      el('span', { class: 'rp-heat-sw', 'aria-hidden': 'true' }), l.label || l.kind)),
    !hasVideo() ? el('li', { class: 'rp-heat-key dim', text: 'No video, so no face cues in these scores' }) : null,
  );
  const name = (sp) => (sp === 'you' ? 'You' : state.convo.otherName && state.convo.otherName !== 'them' ? state.convo.otherName : 'Them');
  put($('heat-lines'), ...turns.map((t) => {
    const words = Array.isArray(t.words) ? t.words : [];
    const r = isNum(t.reaction) ? t.reaction : null;
    const border = r === null ? '' : `border-left-color:color-mix(in srgb, var(${r >= 0 ? '--good' : '--bad'}) ${Math.round(Math.min(1, Math.abs(r) / 0.3) * 80 + 20)}%, var(--line))`;
    const kids = [];
    words.forEach((w, i) => {
      if (i) kids.push(' ');
      const scored = isNum(w.score) && w.score !== 0;
      if (!scored && !w.why) { kids.push(String(w.w ?? '')); return; }
      const isGood = w.kind && good.has(w.kind) ? good.get(w.kind) : w.score > 0;
      const why = w.why || (w.kind ? (legend.find((l) => l.kind === w.kind) || {}).label : '') || '';
      kids.push(el('span', {
        class: `rp-heat-w ${isGood ? 'good' : 'bad'}`,
        style: scored ? tint(w.score, isGood) : null,
        title: why || null,
        tabindex: why ? '0' : null,
        on: {
          mouseenter: () => showWhy(why ? `“${w.w}”: ${why}` : ''),
          focus: () => showWhy(why ? `“${w.w}”: ${why}` : ''),
          click: (e) => { e.stopPropagation(); showWhy(why ? `“${w.w}”: ${why}` : ''); },
        },
        text: String(w.w ?? ''),
      }));
    });
    return el('li', { class: `rp-heat-line is-${t.speaker === 'you' ? 'you' : 'them'}`, style: border || null },
      el('button', {
        class: 'rp-heat-who', type: 'button', title: 'Play this line',
        on: { click: () => seekToTurn(t.turnId) },
      },
      el('span', { text: name(t.speaker) }),
      el('span', { class: 'rp-time' }, el('span', { class: 'rp-play', 'aria-hidden': 'true', text: '▶ ' }), fmtClock(t.startMs || 0))),
      el('p', { class: 'rp-heat-text', on: { click: () => seekToTurn(t.turnId) } }, ...kids,
        r !== null ? el('span', { class: `rp-chip react ${r > 0.02 ? 'up' : r < -0.02 ? 'down' : ''}`.trim(), text: `they smiled ${signed(r)} after this` }) : null),
    );
  }));
}

// ---------- page ----------

function renderHeader() {
  const c = state.convo;
  $('title').textContent = c ? `With ${c.otherName && c.otherName !== 'them' ? c.otherName : 'them'}${c.createdAt ? ` · ${fmtDate(c.createdAt)}` : ''}` : '';
  document.title = c ? `Replay · ${c.otherName || 'conversation'}` : 'Playback Replay';
  const tag = $('tag');
  tag.hidden = !(c && c.tag);
  tag.textContent = c && c.tag ? TAG_NAMES[c.tag] || c.tag : '';
}

function renderAll() {
  const c = state.convo;
  if (!c) return;
  state.offsetMs = c.recording && isNum(c.recording.offsetMs) ? c.recording.offsetMs : 0;
  syncFrames();
  renderHeader();
  const video = hasVideo();
  $('novideo').hidden = video;
  $('video').hidden = !video;
  $('player').classList.toggle('empty', !video);
  $('live-toggle-wrap').hidden = !video;
  if (video) loadMainVideo();
  renderAnalysisBar();
  renderTranscript();
  renderProof();
  renderAdvice();
  ensureHeatmap();
  drawLanes();
  updatePlayhead();
  if (!state.analysing && !state.frames) updateMeters(null, 0);
  else if (!state.analysing && hasVideo()) updateMeters(frameAt($('video').currentTime * 1000 - state.offsetMs), $('video').currentTime * 1000 - state.offsetMs);

  if (video && !c.behavior && !state.analysing && !state.autoStarted && !state.pendingUpload) {
    state.autoStarted = true;
    analyse();
  }
}

// Per animation frame while playing: playhead, active line, meters, live overlay.
let ticking = false;
function tick() {
  const video = $('video');
  if (!state.convo || !hasVideo()) { ticking = false; return; }
  if (!state.analysing) {
    const videoMs = video.currentTime * 1000;
    const t = videoMs - state.offsetMs;
    updatePlayhead(videoMs);
    // a touch early, so the line lights up as the seek preroll lands
    const turn = turnAt(t + 350);
    if (turn && turn.turnId !== state.activeTurn) setActive(turn.turnId);
    const live = $('live-toggle').checked;
    if (live && !video.paused) liveDetect();
    else if (!live && state.frames) updateMeters(frameAt(t), t);
    if (!live && state.lastResult) clearOverlay();
  }
  if (video.paused || video.ended) { ticking = false; return; }
  requestAnimationFrame(tick);
}

function startTicking() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(tick);
}

async function loadConvo() {
  try {
    const c = await getJson(`/api/conversations/${enc(state.id)}`);
    state.convo = c;
    $('v-convo').hidden = false;
    renderAll();
  } catch (err) {
    showGone(err.status === 404 ? 'That conversation is gone. It may have been deleted.' : "Couldn't load this conversation. Is the server running?");
  }
}

function showGone(text) {
  $('v-convo').hidden = true;
  $('analyze-btn').hidden = true;
  const box = $('v-error');
  box.hidden = false;
  put(box, text, ' ', el('a', { href: listHref(), text: 'See all replays' }));
}

function listHref() {
  const theme = new URLSearchParams(location.search).get('theme');
  return theme ? `replay.html?theme=${enc(theme)}` : 'replay.html';
}

function convoHref(id) {
  const theme = new URLSearchParams(location.search).get('theme');
  return `replay.html?id=${enc(id)}${theme ? `&theme=${enc(theme)}` : ''}`;
}

// ---------- list ----------

async function loadList() {
  $('v-list').hidden = false;
  document.title = 'Playback Replays';
  let all;
  try {
    all = await getJson('/api/conversations');
  } catch {
    $('convos-video').replaceChildren(el('li', { class: 'rp-empty', text: "Couldn't load conversations. Is the server running?" }));
    return;
  }
  const list = (Array.isArray(all) ? all : []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const withVideo = list.filter((c) => c.recording);
  const plain = list.filter((c) => !c.recording && Array.isArray(c.turns) && c.turns.length);
  const row = (c) => {
    const dur = c.turns && c.turns.length ? fmtClock(Math.max(...c.turns.map((t) => t.endMs || 0))) : null;
    const status = c.recording ? (c.behavior ? 'Analysed' : 'Not analysed yet') : 'No video';
    return el('li', {},
      el('a', { class: 'rp-convo-link', href: convoHref(c.id) },
        el('span', { class: 'rp-convo-name', text: c.otherName && c.otherName !== 'them' ? c.otherName : 'Someone' }),
        el('span', { class: 'rp-convo-meta', text: [fmtDate(c.createdAt), TAG_NAMES[c.tag] || c.tag, dur, c.seeded ? 'sample' : null].filter(Boolean).join(' · ') }),
        el('span', { class: `rp-convo-status${c.behavior ? ' done' : ''}`, text: status }),
      ),
    );
  };
  $('convos-video').replaceChildren(...(withVideo.length
    ? withVideo.map(row)
    : [el('li', { class: 'rp-empty', text: 'No conversations with video yet. Turn on Camera on the phone before recording.' })]));
  $('no-video-head').hidden = !plain.length;
  $('convos-plain').replaceChildren(...plain.map(row));
}

// ---------- socket ----------

let attempt = 0;
let pillTimer = null;
let listTimer = null;

function handle(msg) {
  if (msg.type === 'hello') {
    $('mock-badge').hidden = !msg.mock;
    return;
  }
  if (!state.id) {
    if (msg.type === 'conversation' || msg.type === 'deleted') {
      clearTimeout(listTimer);
      listTimer = setTimeout(loadList, 300);
    }
    return;
  }
  if (msg.type === 'conversation' && msg.conversation && msg.conversation.id === state.id) {
    const c = msg.conversation;
    const prev = state.convo || {};
    if (!c.turns && prev.turns) c.turns = prev.turns;
    // A late update without the analysis shouldn't wipe what we just got back from POST /behavior.
    if (c.behavior === undefined) c.behavior = prev.behavior ?? null;
    if (c.insight === undefined) c.insight = prev.insight ?? null;
    state.convo = c;
    $('v-convo').hidden = false;
    $('v-error').hidden = true;
    renderAll();
  } else if (msg.type === 'deleted' && msg.conversationId === state.id) {
    $('video').pause();
    abortAnalysis();
    clearOverlay();
    showGone('This conversation was just deleted, along with its video.');
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws/stage`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    attempt = 0;
    clearTimeout(pillTimer);
    pillTimer = null;
    $('conn-pill').hidden = true;
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    try { handle(msg); } catch (err) { console.error('replay message failed', msg.type, err); }
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => { /* onclose follows */ };
}

function scheduleReconnect() {
  if (!pillTimer) pillTimer = setTimeout(() => { $('conn-pill').hidden = false; }, 1200);
  const delay = Math.min(10000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
  attempt += 1;
  setTimeout(connect, delay);
}

// ---------- boot ----------

function init() {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  state.id = params.get('id');

  fetch('/api/health', { cache: 'no-store' }).then((r) => r.json())
    .then((h) => { $('mock-badge').hidden = !(h && h.mock); })
    .catch(() => {});

  buildLaneLabels();
  const video = $('video');
  for (const ev of ['play', 'seeked', 'timeupdate']) video.addEventListener(ev, startTicking);
  video.addEventListener('seeked', () => {
    // Paused and scrubbing: one detection so the overlay matches the frame.
    if (video.paused && $('live-toggle').checked && !state.analysing) { state.lastLiveAt = 0; liveDetect(); }
  });
  video.addEventListener('error', () => {
    if (video.getAttribute('src')) showAnalysisMsg("Couldn't play the video. The file may still be uploading or was removed.", true);
  });
  $('live-toggle').addEventListener('change', (e) => {
    if (!e.target.checked) clearOverlay();
    else if (hasVideo()) { state.lastLiveAt = 0; liveDetect(); }
  });
  $('analyze-btn').addEventListener('click', () => analyse());
  $('rerun-btn').addEventListener('click', () => analyse());
  const track = $('track');
  track.addEventListener('click', onTrackClick);
  track.addEventListener('mousemove', onTrackHover);
  track.addEventListener('mouseleave', () => { $('hover').hidden = true; });
  new ResizeObserver(() => {
    drawLanes();
    if (state.lastResult && !state.analysing) drawOverlay($('video'), state.lastResult);
  }).observe(track);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawLanes());

  if (state.id) loadConvo();
  else loadList();
  connect();
}

init();
