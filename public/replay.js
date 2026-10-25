// Replay page (Mac). Plays a conversation's video next to its transcript, runs
// MediaPipe Face Landmarker over the video in this browser, and shows where the
// coaching advice is or isn't backed by what happened on camera.
// Transcript text and names come from speech recognition and users, so every bit
// of data goes in via textContent, never innerHTML.

import { createFaceOverlay, drawMesh, contentRect, sizeCanvas } from './overlay.js';

const MODEL = 'mediapipe-face-landmarker@0.10.14';
const VENDOR = new URL('vendor/mediapipe/', location.href).href;
const FPS = 5;
const STEP_MS = 1000 / FPS;
// Same thresholds and nod detector as src/behavior/align.js, so the ticks match the per-turn
// counts (a test there checks findNods against the server's copy).
const FACING_DEG = 25;
const NOD_DEG = 8;
const NOD_MAX_MS = 1500;
const NOD_REF_MS = 1000;
const NOD_GAP_MS = 500;
const SEEK_TIMEOUT_MS = 4000;
const METERS_EVERY_MS = 100;
const PREROLL_S = 0.3;
const TAG_NAMES = { family: 'Family', friend: 'Friend', networking: 'Networking' };
const VERDICTS = { backed: 'Backed', partly: 'Partly', 'not yet': 'Not yet' };
const MARKS = {
  follow: { cls: 'fu', sym: '', label: 'Follow-up question' },
  missed: { cls: 'ms', sym: '', label: 'Missed moment' },
  tk1: { cls: 'tk', sym: '1', label: 'Try this next time' },
  tk2: { cls: 'tk', sym: '2', label: 'Keep doing this' },
  tk3: { cls: 'tk', sym: '3', label: 'Ask about it next time' },
  awk: { cls: 'awk', sym: '', label: 'Awkward moment' },
  ask: { cls: 'q', sym: '', label: 'You asked' },
  said: { cls: 'sd', sym: '', label: 'They brought up' },
  promise: { cls: 'pr', sym: '', label: 'You promised' },
};
const MARK_ORDER = ['tk1', 'tk2', 'tk3', 'awk', 'follow', 'missed', 'ask', 'said', 'promise'];
// The Figma's .tl-track (who's talking, with the moment dots above it) is DOM; the face cues
// underneath it are still a canvas.
const TRACK_TOP = 0;    // the dots overhang the tl-head margin, like the Figma
const TRACK_H = 26;
const MARK_W = 17;
const LANES = [
  { key: 'smile', label: 'Smile', h: 44 },
  { key: 'facing', label: 'Facing', h: 14 },
  { key: 'nods', label: 'Nods', h: 18 },
];
const LANE_GAP = 8;

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
  labelNeeded: false,   // the server said it can't tell which voice is the user's
  picking: null,        // { step, error } while saving a picked voice
  insightAsked: null,   // conversation id we already asked POST /insight for
  insightBusy: false,
  insightError: null,
  nods: [],             // transcript ms of each nod found in frames
  analysing: false,
  autoStarted: false,
  pendingUpload: null,  // frames we couldn't post yet
  uploading: false,
  runId: 0,
  activeTurn: null,
  liveFrames: [],       // recent live detections, for the nod meter
  metersAt: 0,          // when the live meters last changed; the mesh redraws far more often
  overlay: null,        // the live mesh (overlay.js), once init has the elements
  videoSrc: null,
  compare: { id: null, data: null }, // /compare, for the "Last time" numbers
  draftFor: null,       // conversation whose follow-up draft is in the modal's textarea
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
    err.needsLabel = !!(data && data.needsLabel);
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

// Until we know which voice is the user's, nothing on the page may say "you" or "them":
// that's how a rumour got praised once, with every line counted as hers.
function needsVoice() {
  const c = state.convo;
  if (!c) return false;
  return state.labelNeeded || (!c.userLabel && turnsOf(c).length >= 2);
}

// 'you' | 'them' | null (null until we know which voice is the user)
function sideOf(turn, bt) {
  if (needsVoice()) return null;
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
    if (others.length <= 1 && c.otherName && c.otherName !== 'them') return firstName();
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
  // follow-ups, missed moments and awkward flags all depend on knowing who's who
  if (needsVoice()) return new Map();
  for (const b of (c.hooks && c.hooks.missedBids) || []) add(b.turnId, 'missed');
  for (const f of awkward().flags) if (f.who === 'you') add(f.turnId, 'awk');
  // the quieter beats: every question you asked, the things they brought up, what you promised
  const followed = new Set([...out.entries()].filter(([, k]) => k.has('follow')).map(([id]) => id));
  for (const q of qs) if (!followed.has(q.turnId)) add(q.turnId, 'ask');
  const h = c.hooks || {};
  const mentioned = new Set((h.events || []).map((e) => e.turnId));
  for (const t of h.topics || []) for (const id of t.turnIds || []) mentioned.add(id);
  for (const id of mentioned) if (!out.has(id) || !out.get(id).has('missed')) add(id, 'said');
  for (const p of h.commitments || []) add(p.turnId, 'promise');
  // numbered like the cards: 1 try, 2 keep, 3 ask
  const { tryT, keep, ask } = threeTakeaways();
  [tryT, keep, ask].forEach((t, i) => { if (t) add(t.turnId, `tk${i + 1}`); });
  return out;
}

function awkward() {
  const a = state.convo && state.convo.hooks && state.convo.hooks.awkward;
  return {
    flags: a && Array.isArray(a.flags) ? a.flags : [],
    seams: a && Array.isArray(a.seams) ? a.seams : [],
  };
}

function missedCue(turnId) {
  const b = ((state.convo.hooks && state.convo.hooks.missedBids) || []).find((x) => x.turnId === turnId);
  return b && b.cue ? b.cue : null;
}

function markerTitle(turnId, kinds) {
  const three = threeTakeaways();
  const tks = [three.tryT, three.keep, three.ask];
  return MARK_ORDER.filter((k) => kinds.has(k)).map((k) => {
    if (k === 'missed') {
      const cue = missedCue(turnId);
      return cue ? `Missed moment: they mentioned “${cue}” and the next line moved on` : MARKS.missed.label;
    }
    if (k === 'awk') {
      return awkward().flags.filter((f) => f.who === 'you' && f.turnId === turnId)
        .map((f) => `${f.label}${f.evidence ? `: ${f.evidence}` : ''}`).join('\n') || MARKS.awk.label;
    }
    if (k.startsWith('tk')) {
      const t = tks[Number(k.slice(2)) - 1];
      return t && t.title ? `${MARKS[k].label}: ${t.title}` : MARKS[k].label;
    }
    if (k === 'ask') {
      const line = turnsOf(state.convo).find((t) => t.turnId === turnId);
      return line && line.text ? `You asked: “${line.text}”` : MARKS.ask.label;
    }
    if (k === 'said') {
      const h = state.convo.hooks || {};
      const what = [
        ...(h.events || []).filter((e) => e.turnId === turnId).map((e) => e.text),
        ...(h.topics || []).filter((t) => (t.turnIds || []).includes(turnId)).map((t) => t.term),
      ].filter(Boolean);
      return what.length ? `They brought up ${what.map((w) => `“${w}”`).join(', ')}: something to come back to` : MARKS.said.label;
    }
    if (k === 'promise') {
      const p = ((state.convo.hooks && state.convo.hooks.commitments) || []).find((x) => x.turnId === turnId);
      return p && p.text ? `You promised: “${p.text}”` : MARKS.promise.label;
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
    if (dip && f.t - dip.lastT > NOD_GAP_MS) dip = null; // lost the face mid-dip
    if (!dip) {
      const ref = refPitch(pts, i);
      if (ref !== null && Math.abs(f.pitch - ref) >= NOD_DEG) dip = { ref, start: f.t, peakT: f.t, max: Math.abs(f.pitch - ref), lastT: f.t };
      continue;
    }
    dip.lastT = f.t;
    const off = Math.abs(f.pitch - dip.ref);
    if (off > dip.max) { dip.max = off; dip.peakT = f.t; }
    if (off < NOD_DEG / 2) {
      if (f.t - dip.start <= NOD_MAX_MS) out.push(dip.peakT);
      dip = null;
    } else if (f.t - dip.start > NOD_MAX_MS) {
      dip = null; // a held tilt, not a nod
    }
  }
  return out;
}

// Median pitch over the second before frame i, only across frames with no gap between them:
// the pose the model settles on after re-finding a face isn't comparable to the one before.
function refPitch(pts, i) {
  const t = pts[i].t;
  const win = [];
  for (let j = i - 1; j >= 0 && pts[j].t >= t - NOD_REF_MS && pts[j + 1].t - pts[j].t <= NOD_GAP_MS; j--) win.push(pts[j].pitch);
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
      drawOverlay(v, res);
      updateMeters(frame, frame.t);
      updatePlayhead(videoMs);
      setProgress(i + 1, total);
      const secs = (performance.now() - started) / 1000;
      const speed = secs > 0 ? (videoMs / 1000) / secs : 0;
      $('word-status').textContent = 'Analyzing video…';
      $('analysis-meta').textContent = `Frame ${i + 1} of ${total}, ${speed >= 0.1 ? `${speed.toFixed(1)}× real time` : '…'}${delegate ? `, ${delegate}` : ''}`;
      if (i % 8 === 0 || i === total - 1) {
        state.nods = findNods(frames);
        drawLanes();
      }
    }
    state.nods = findNods(frames);
    if (!live()) return;

    const seen = frames.filter((f) => f.face).length;
    const secs = (performance.now() - started) / 1000;
    $('analysis-meta').textContent = `${frames.length} frames in ${secs.toFixed(1)} s, face in view ${Math.round((seen / frames.length) * 100)}%${delegate ? `, ${delegate}` : ''}`;
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
      if (state.overlay) state.overlay.sync();
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
  renderTakeaways();
  $('word-status').textContent = 'Lining the cues up with the transcript…';
  try {
    const body = { model: MODEL, fps: FPS, frames, recordingUploadedAt: recAt };
    const data = await postJson(`/api/conversations/${enc(state.id)}/behavior`, body);
    state.pendingUpload = null;
    // The video was replaced while the server was busy: these cues belong to the old one.
    if (!sameVideo(recAt)) return;
    if (data && data.behavior) state.convo.behavior = data.behavior;
    if (data && 'insight' in data) state.convo.insight = data.insight;
    // The server may have worked out the user's voice from the video; pick that up.
    if (!state.convo.userLabel) await refreshConvo();
    renderAll();
  } catch (err) {
    if (err.needsLabel && sameVideo(recAt)) {
      // keep the frames; they go up again once the user picks their voice
      state.labelNeeded = true;
      showAnalysisMsg('');
      renderAll();
      return;
    }
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
    // Both the stage echo and the response above rendered while uploading was still true, which
    // left the takeaways box saying "Writing…" for good.
    if (sameVideo(recAt)) renderTakeaways();
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
      ].filter(Boolean).join(', ');
    }
    if (seen === 0) showAnalysisMsg("No face found in this video. The camera needs to see the other person's face to measure smiling, facing or nodding.");
  } else if (state.pendingUpload && needsVoice()) {
    $('word-status').textContent = 'Cues ready';
    $('analysis-meta').textContent = 'Pick which voice is yours above and they get lined up with your lines.';
  } else if (!state.pendingUpload) {
    $('word-status').textContent = 'Not analysed yet';
    $('analysis-meta').textContent = 'Face Landmarker runs here in Chrome, 5 frames per second of video.';
  }
}

// ---------- overlay + meters ----------

function clearOverlay() {
  if (state.overlay) { state.overlay.clear(); return; }
  const c = $('overlay');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

// The analysis pass: paints the frame it just measured and the raw mesh over it, so the room
// sees the model working while the real player sits paused. Live playback goes through
// overlay.js instead, which smooths between frames.
function drawOverlay(source, res) {
  const canvas = $('overlay');
  const box = $('player');
  const W = box.clientWidth;
  const H = box.clientHeight;
  const ctx = sizeCanvas(canvas, W, H);
  ctx.clearRect(0, 0, W, H);
  const r = contentRect(W, H, source.videoWidth, source.videoHeight);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  try { ctx.drawImage(source, r.x, r.y, r.w, r.h); } catch { /* frame not ready */ }
  const pts = res && res.faceLandmarks && res.faceLandmarks[0];
  if (!pts) return;
  const xy = new Float32Array(pts.length * 2);
  pts.forEach((p, i) => { xy[i * 2] = p.x; xy[i * 2 + 1] = p.y; });
  drawMesh(ctx, xy, r, meshColors());
}

let meshColorCache = null;
function meshColors() {
  if (!meshColorCache) meshColorCache = { bone: cssVar('--bone') || '#f3ead8', marigold: cssVar('--marigold') || '#f4a51c' };
  return meshColorCache;
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

// One live detection from overlay.js (every presented frame while playing, or the still frame
// after a pause or seek). The mesh itself is drawn there; this keeps the meters and the nod
// window up to date, at a pace the eye can follow.
function onLiveFrame(res, mediaTime) {
  if (state.analysing) return;
  const frame = readFrame(res, mediaTime * 1000);
  const lf = state.liveFrames;
  if (lf.length && frame.t < lf[lf.length - 1].t) lf.length = 0; // jumped back
  lf.push(frame);
  while (lf.length && frame.t - lf[0].t > 2500) lf.shift();
  const now = performance.now();
  if (now - state.metersAt < METERS_EVERY_MS && !$('video').paused) return;
  state.metersAt = now;
  updateMeters(frame, frame.t);
}

const liveOverlayOn = () => hasVideo() && !state.analysing && $('live-toggle').checked;

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
  return { tops, height: y - LANE_GAP };
}

// Face cues only exist with a video; without one the track stands alone, like the Figma.
const showLanes = () => hasVideo() || !!(state.convo && state.convo.behavior);

function buildLaneLabels() {
  const box = document.querySelector('.tl-labels');
  put(box,
    el('span', { style: `height:${TRACK_TOP + TRACK_H}px`, text: 'Talk' }),
    ...LANES.map((l) => el('span', { class: 'lane', style: `height:${l.h}px;margin-top:${LANE_GAP}px`, text: l.label })));
}

function drawLanes() {
  const track = $('track');
  const canvas = $('lanes-canvas');
  const W = track.clientWidth;
  if (!W || !state.convo) return;
  const D = domainMs();
  renderSegments(D);
  renderMarkers(D);
  renderAxis(D);
  const lanes = showLanes();
  canvas.hidden = !lanes;
  for (const s of document.querySelectorAll('.tl-labels .lane')) s.hidden = !lanes;
  if (!lanes) return;

  const { tops, height } = laneTops();
  const ctx = sizeCanvas(canvas, W, height);
  canvas.style.height = `${height}px`;
  ctx.clearRect(0, 0, W, height);
  const x = (videoMs) => (videoMs / D) * W;
  const col = { ink: cssVar('--ink'), them: cssVar('--ink-3'), muted: cssVar('--ink-3'), lane: cssVar('--tint') };
  const smileH = LANES[0].h;
  const facingH = LANES[1].h;
  const nodsH = LANES[2].h;

  for (const l of LANES) {
    ctx.fillStyle = col.lane;
    roundRect(ctx, 0, tops[l.key], W, l.h, 6);
    ctx.fill();
  }

  const turns = turnsOf(state.convo);
  const bts = behaviorTurns();
  const fs = state.frames;
  const smileTop = tops.smile;
  const sy = (v) => smileTop + smileH - 3 - Math.max(0, Math.min(1, v)) * (smileH - 6);
  const b = state.convo.behavior;

  if (fs && fs.length) {
    // smile line, broken wherever the face drops out
    ctx.strokeStyle = col.them;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.fillStyle = withAlpha(col.them, 0.16);
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
    for (const f of fs) {
      if (!f.face) continue;
      ctx.fillStyle = facing(f) ? withAlpha(col.ink, 0.55) : withAlpha(col.muted, 0.25);
      ctx.fillRect(x(toVideoMs(f.t)), tops.facing + 2, Math.max(1, x(STEP_MS) + 0.5), facingH - 4);
    }

    // nod ticks
    ctx.strokeStyle = col.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const n of state.nods) {
      const nx = x(toVideoMs(n));
      ctx.moveTo(nx, tops.nods + 3);
      ctx.lineTo(nx, tops.nods + nodsH - 3);
    }
    ctx.stroke();
  } else if (b && bts.size) {
    // No per-frame data on this browser: per-turn steps from the server's numbers.
    for (const t of turns) {
      const bt = bts.get(t.turnId);
      if (!bt || bt.smile == null) continue;
      const x0 = x(toVideoMs(t.startMs));
      const w = Math.max(2, x(toVideoMs(t.endMs)) - x0);
      ctx.fillStyle = withAlpha(col.them, 0.3);
      ctx.fillRect(x0, sy(bt.smile), w, smileTop + smileH - 3 - sy(bt.smile));
      ctx.fillStyle = withAlpha(col.ink, Math.max(0.12, (bt.facingPct || 0) * 0.55));
      ctx.fillRect(x0, tops.facing + 2, w, facingH - 4);
      ctx.strokeStyle = col.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < (bt.nods || 0); i++) {
        const nx = x0 + (w * (i + 1)) / ((bt.nods || 0) + 1);
        ctx.moveTo(nx, tops.nods + 3);
        ctx.lineTo(nx, tops.nods + nodsH - 3);
      }
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = col.muted;
    ctx.font = `500 12px ${cssVar('--font-serif') || 'system-ui'}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('Face cues show up here once the video is analysed.', 10, smileTop + smileH / 2);
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
}

// Figma .tl-track: one segment per turn, yours in --you, theirs in ink-3.
function renderSegments(D) {
  const bts = behaviorTurns();
  put($('segs'), ...turnsOf(state.convo).map((t) => {
    const side = sideOf(t, bts.get(t.turnId));
    const s = toVideoMs(t.startMs);
    const e = Math.max(toVideoMs(t.endMs || t.startMs), s + 400);
    return el('i', {
      class: `seg ${side === 'you' ? 'me' : side === 'them' ? 'them' : 'unk'}`,
      style: `left:${(s / D) * 100}%;width:${((e - s) / D) * 100}%`,
    });
  }));
}

function niceStep(D, W) {
  const target = D / Math.max(2, W / 90);
  for (const s of [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]) if (s >= target) return s;
  return 600000;
}

function renderAxis(D) {
  const W = $('track').clientWidth;
  const step = niceStep(D, W);
  const kids = [];
  // skip a label that would sit on top of the end one
  for (let ms = 0; ms + step * 0.4 < D; ms += step) kids.push(el('span', { style: `left:${(ms / D) * 100}%`, text: fmtClock(ms) }));
  kids.push(el('span', { class: 'end', style: 'left:100%', text: fmtClock(D) }));
  put($('tl-axis'), ...kids);
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

// Figma .mark buttons above the track. A turn with several kinds gets a little row of dots.
function renderMarkers(D) {
  const box = $('markers');
  const W = $('track').clientWidth;
  const marks = markersByTurn(state.convo);
  const turns = new Map(turnsOf(state.convo).map((t) => [t.turnId, t]));
  const items = [...marks.entries()].filter(([id]) => turns.has(id)).map(([id, kinds]) => {
    const sorted = MARK_ORDER.filter((k) => kinds.has(k));
    return { id, t: turns.get(id), sorted, w: sorted.length * MARK_W, x: (toVideoMs(turns.get(id).startMs) / D) * W };
  }).sort((a, b) => a.x - b.x);
  // Push neighbours apart so close markers don't sit on top of each other.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    it.x = Math.max(it.x, it.w / 2);
    if (i) it.x = Math.max(it.x, items[i - 1].x + (items[i - 1].w + it.w) / 2 + 3);
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const limit = i === items.length - 1 ? W - it.w / 2 : items[i + 1].x - (items[i + 1].w + it.w) / 2 - 3;
    it.x = Math.min(it.x, limit);
  }
  put(box, ...items.map(({ id, t, sorted, x }) => el('span', { class: 'mark-set', style: `left:${Math.round(x)}px` },
    ...sorted.map((k) => {
      const title = `${markerTitle(id, new Set([k]))} at ${fmtClock(t.startMs)}`;
      return el('button', {
        class: `mark ${MARKS[k].cls}`,
        type: 'button',
        title,
        'aria-label': title,
        text: MARKS[k].sym,
        on: { click: (e) => { e.stopPropagation(); play(id); } },
      });
    }))));
}

function updatePlayhead(videoMsOverride) {
  const head = $('playhead');
  if (!state.convo || (!hasVideo())) { head.hidden = true; return; }
  const video = $('video');
  const ms = videoMsOverride ?? video.currentTime * 1000;
  const D = domainMs();
  head.hidden = false;
  const at = Math.max(0, Math.min(1, ms / D));
  head.style.left = `${at * 100}%`;
  head.classList.toggle('edge', at < 0.03); // keep the time chip inside the card
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
    ? `${fmtClock(videoMs - state.offsetMs)}, smile ${pct(f.smile)}%, ${facing(f) ? 'facing' : 'turned away'}`
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
  const box = $('script-scroll');
  for (const li of box.querySelectorAll('.line.active')) li.classList.remove('active');
  const li = box.querySelector(`.line[data-turn="${turnId}"]`);
  if (!li) return;
  li.classList.add('active');
  const top = li.offsetTop - box.offsetTop - box.clientHeight * 0.28;
  const rel = li.offsetTop - box.offsetTop;
  const visible = rel >= box.scrollTop + 8 && rel + li.offsetHeight <= box.scrollTop + box.clientHeight - 8;
  if (scroll || !visible) box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

// Takeaway and timeline buttons: seek the video and flash the line, like the Figma's play().
let flashTimer = null;
function play(turnId) {
  seekToTurn(turnId);
  const li = $('script-scroll').querySelector(`.line[data-turn="${turnId}"]`);
  if (!li) return;
  li.classList.remove('flash');
  void li.offsetWidth;
  li.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => li.classList.remove('flash'), 1800);
}

// smile delta 0..1 as signed points, e.g. +21 / −8
function pts(v) {
  if (!isNum(v)) return '—';
  const n = Math.round(v * 100);
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0';
}

// Their cues on one of their lines; shown on hover so the transcript stays readable.
function themCues(bt, b) {
  if (!b || !bt) return null;
  const chips = [];
  if (bt.smile == null) {
    chips.push(el('em', { class: 'tag cue dim', text: 'face not in view' }));
  } else {
    chips.push(el('em', { class: 'tag cue', title: `Mean smile over this line (peak ${pct(bt.smilePeak) ?? '—'}%). Their usual: ${pct(b.baseline && b.baseline.smile) ?? '—'}%.`, text: `smile ${pct(bt.smile)}%` }));
    if (isNum(bt.facingPct)) chips.push(el('em', { class: 'tag cue', title: 'Share of frames where their head pointed at the camera', text: `facing ${pct(bt.facingPct)}%` }));
    if (isNum(bt.nods)) chips.push(el('em', { class: 'tag cue', text: plural(bt.nods, 'nod') }));
  }
  if (bt.congruence === 'match' || bt.congruence === 'mixed') {
    const base = b.baseline || {};
    const tip = `Compared the tone of the words (${bt.textTone || 'neutral'}, from a word list) with their face on this line: `
      + `smile ${pct(bt.smile) ?? '—'}% vs their usual ${pct(base.smile) ?? '—'}%, `
      + `animation ${isNum(bt.animation) ? bt.animation.toFixed(2) : '—'} vs usual ${isNum(base.animation) ? base.animation.toFixed(2) : '—'}. `
      + (bt.congruence === 'match' ? 'They point the same way.' : "They don't point the same way.")
      + ' Observable cues only, not feelings or sincerity.';
    chips.push(el('em', { class: `tag cue ${bt.congruence}`, title: tip, text: `words + face: ${bt.congruence}` }));
  }
  return el('span', { class: 'cues' }, ...chips);
}

// Only reactions big enough to matter get a chip: "smiled +39", "smile −10, looked away".
function reactionChip(bt, heatReaction) {
  const r = bt && bt.reaction;
  const d = r && isNum(r.smileDelta) ? r.smileDelta : heatReaction;
  if (!isNum(d) || Math.abs(d) < 0.1) return null;
  const bits = [d > 0 ? `smiled ${pts(d)}` : `smile ${pts(d)}`];
  if (r && isNum(r.nods) && r.nods > 0) bits.push(plural(r.nods, 'nod'));
  if (r && isNum(r.facingPct) && r.facingPct < 0.5) bits.push('looked away');
  return el('em', {
    class: `tag react ${d > 0 ? 'up' : 'down'}`,
    title: 'Their smile over the 2.5 s after you stopped talking, against the moment you stopped (points out of 100)',
    text: bits.join(', '),
  });
}

function awkChip(f) {
  const why = `${f.label}: ${f.evidence || ''}`;
  return el('em', {
    class: `tag awk ${f.who === 'you' ? 'mine' : 'theirs'}`,
    title: f.evidence || f.label,
    tabindex: '0',
    on: { mouseenter: () => showWhy(why), mouseleave: () => showWhy(''), focus: () => showWhy(why), blur: () => showWhy('') },
    text: f.label || f.kind,
  });
}

// Short names for the one-line legend.
const LEGEND_SHORT = {
  'picked-up': 'picked up', 'follow-up': 'follow-up', topic: 'their topic', promise: 'promise', smile: 'smiling',
  missed: 'missed', filler: 'filler', flat: 'mixed signal',
};
const HEAT_NOTE = 'Highlighted words are the few that mattered. Hover or focus one to see why.';

// The Figma's heat-note doubles as the place a hovered word explains itself.
function showWhy(text) {
  const box = $('heat-note');
  box.classList.toggle('why', !!text);
  if (text) { put(box, text); return; }
  put(box, HEAT_NOTE, ...legendKeys());
}

function legendKeys() {
  const d = state.heat.data;
  const legend = d && Array.isArray(d.legend) ? d.legend : [];
  if (!legend.length) return [];
  const names = (good) => legend.filter((l) => !!l.good === good).map((l) => LEGEND_SHORT[l.kind] || l.label).join(', ');
  return [
    el('span', { class: 'heat-key good' }, el('i', { 'aria-hidden': 'true' }), names(true)),
    el('span', { class: 'heat-key bad' }, el('i', { 'aria-hidden': 'true' }), names(false)),
  ];
}

// Figma <mark data-reason>: only words the server tagged get colour; a bare score is too noisy to show.
function heatWords(words, legend) {
  const good = new Map(legend.map((l) => [l.kind, !!l.good]));
  const kids = [];
  words.forEach((w, i) => {
    if (i) kids.push(' ');
    const text = String(w.w ?? '');
    if (!w.kind) { kids.push(text); return; }
    const isGood = good.has(w.kind) ? good.get(w.kind) : w.score > 0;
    const label = (legend.find((l) => l.kind === w.kind) || {}).label || w.kind;
    const why = `“${text}”: ${w.why || label}`;
    kids.push(el('mark', {
      class: isGood ? '' : 'bad',
      'data-reason': w.why || label,
      tabindex: '0',
      on: {
        mouseenter: () => showWhy(why),
        mouseleave: () => showWhy(''),
        focus: () => showWhy(why),
        blur: () => showWhy(''),
        click: (e) => { e.stopPropagation(); showWhy(why); },
      },
      text,
    }));
  });
  return kids;
}

// One transcript: synced to the video, words marked from the heatmap when it's in.
function renderTranscript() {
  const c = state.convo;
  const turns = turnsOf(c);
  const list = $('script-scroll');
  showWhy('');
  if (!turns.length) {
    list.replaceChildren(el('li', { class: 'rp-empty', text: 'No transcript for this one.' }));
    return;
  }
  const labels = speakerLabels(turns);
  const bts = behaviorTurns();
  const marks = markersByTurn(c);
  const b = c.behavior;
  const d = state.heat.data;
  const heat = new Map((d && Array.isArray(d.turns) ? d.turns : []).map((t) => [t.turnId, t]));
  const legend = d && Array.isArray(d.legend) ? d.legend : [];
  const flags = needsVoice() ? [] : awkward().flags;
  const seams = new Map(needsVoice() ? [] : awkward().seams.map((x) => [x.turnId, x]));
  const tries = new Map(takeaways().filter((t) => t.kind === 'try' && t.tryInstead && Number.isInteger(t.turnId)).map((t) => [t.turnId, t]));
  list.replaceChildren(...turns.map((t) => {
    const bt = bts.get(t.turnId);
    const side = sideOf(t, bt);
    const ht = heat.get(t.turnId);
    const kinds = marks.get(t.turnId) || new Set();
    const tryT = tries.get(t.turnId);
    const sideCls = side === 'you' ? 'me' : side === 'them' ? 'them' : `spk-${Math.max(0, labels.indexOf(t.speaker))}`;
    const seam = seams.get(t.turnId);
    // a seam line shows only their half here; the merged-in half gets its own sub-line
    const words = seam ? [seam.theirs]
      : ht && Array.isArray(ht.words) && ht.words.length ? heatWords(ht.words, legend) : [t.text || ''];
    const awk = flags.filter((f) => f.turnId === t.turnId);
    // on a seam, your flags belong to the merged-in half
    const awkMain = seam ? awk.filter((f) => f.who !== 'you') : awk;
    const awkSeam = seam ? awk.filter((f) => f.who === 'you') : [];
    const tks = MARK_ORDER.filter((k) => k.startsWith('tk') && kinds.has(k));
    const crowd = t.source === 'crowd';
    const cls = ['line', sideCls, kinds.has('follow') ? 'is-fu' : '', kinds.has('missed') ? 'is-ms' : '', crowd ? 'is-crowd' : '', t.turnId === state.activeTurn ? 'active' : '']
      .filter(Boolean).join(' ');
    const seek = () => seekToTurn(t.turnId);
    return el('li', { class: cls, 'data-turn': t.turnId, id: `ln-${t.turnId}` },
      el('button', { class: 'line-time', type: 'button', title: 'Play this line', text: fmtClock(t.startMs), on: { click: seek } }),
      el('span', { class: 'line-who', text: speakerName(t, side, labels) }),
      el('p', { on: { click: seek } },
        ...words,
        crowd ? el('em', { class: 'tag crowd', title: 'The lip lock put this line down to someone else in the room', text: 'Background' }) : null,
        kinds.has('follow') ? el('em', { class: 'tag fu', text: 'Follow-up' }) : null,
        kinds.has('missed') ? el('em', { class: 'tag ms', title: markerTitle(t.turnId, new Set(['missed'])), text: 'Missed moment' }) : null,
        ...tks.map((k) => el('em', { class: 'tag tk', title: markerTitle(t.turnId, new Set([k])), text: `Takeaway ${k.slice(2)}` })),
        ...awkMain.map(awkChip),
        side === 'you' ? reactionChip(bt, ht && ht.reaction) : null,
      ),
      seam ? el('div', { class: 'seam' },
        el('p', {}, el('span', { class: 'rp-seam-who', text: 'You (merged)' }), seam.yours, ...awkSeam.map(awkChip)),
        el('p', { class: 'seam-note', text: 'Voice separation merged this into their line.' })) : null,
      side === 'them' ? themCues(bt, b) : null,
      tryT ? el('p', { class: 'tk-rewrite' }, el('b', { text: 'Try instead' }), `“${tryT.tryInstead}”`) : null,
    );
  }));
  if (state.activeTurn != null) setActive(state.activeTurn);
}

// The coaching note under the transcript (Figma .reflection-copy).
function renderNote() {
  const note = state.convo.note;
  const shown = !!(note && note.text && note.status !== 'dropped') && !needsVoice();
  $('reflection').hidden = !shown;
  if (!shown) return;
  $('note-text').textContent = note.text;
  const sugg = $('note-sugg');
  sugg.textContent = note.suggestion || '';
  sugg.parentElement.hidden = !note.suggestion;
}

// ---------- takeaways ----------

const TK_KINDS = ['try', 'keep', 'next'];
const TK_ORDER = { try: 0, keep: 1, next: 2 };

// What the server sent; until it sends takeaways, a stand-in made from the moments.
function takeaways() {
  const ins = state.convo && state.convo.insight;
  if (!ins || needsVoice()) return [];
  const kindOf = (k) => (TK_KINDS.includes(k) ? k : 'next');
  if (Array.isArray(ins.takeaways) && ins.takeaways.length) {
    return ins.takeaways.slice(0, 3).map((t) => ({ ...t, kind: kindOf(t.kind) }));
  }
  const bts = behaviorTurns();
  return (Array.isArray(ins.moments) ? ins.moments : []).slice(0, 3).map((m) => {
    const r = bts.get(m.turnId) && bts.get(m.turnId).reaction;
    return {
      kind: r && isNum(r.smileDelta) && r.smileDelta < 0 ? 'try' : 'keep',
      turnId: Number.isInteger(m.turnId) ? m.turnId : null,
      title: m.title || '',
      text: m.why || '',
      evidence: m.observation || null,
    };
  }).sort((a, b) => TK_ORDER[a.kind] - TK_ORDER[b.kind]);
}

const turnById = (id) => turnsOf(state.convo).find((t) => t.turnId === id) || null;
const firstOf = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

// The Figma's three cards: try / keep / ask. Each comes from the matching takeaway when the
// server wrote one, else from the nearest thing we measured, so the page is rarely blank.
function threeTakeaways() {
  const list = takeaways();
  const tryT = list.find((t) => t.kind === 'try') || null;
  let keep = list.find((t) => t.kind === 'keep') || null;
  if (!keep && state.convo.insight) {
    const bts = behaviorTurns();
    const warm = (state.convo.insight.moments || []).find((m) => {
      const r = bts.get(m.turnId) && bts.get(m.turnId).reaction;
      return r && isNum(r.smileDelta) && r.smileDelta > 0 && !(tryT && tryT.turnId === m.turnId);
    });
    if (warm) keep = { kind: 'keep', turnId: warm.turnId, title: warm.title || '', text: warm.why || '', evidence: warm.observation || null };
  }
  let ask = list.find((t) => t.kind === 'next') || null;
  if (!ask && !needsVoice()) {
    const h = state.convo.hooks || {};
    const ev = firstOf(h.events);
    const cm = firstOf(h.commitments);
    const tp = firstOf(h.topics);
    const hk = firstOf(state.convo.followUp && state.convo.followUp.hooksUsed);
    if (ev && ev.text) ask = { kind: 'next', turnId: ev.turnId, title: `Ask how it went: ${ev.text}` };
    else if (cm && cm.text) ask = { kind: 'next', turnId: cm.turnId, title: `Follow through: ${cm.text}` };
    else if (tp && tp.term) ask = { kind: 'next', turnId: firstOf(tp.turnIds), title: `Ask about ${tp.term}, the thing they kept coming back to.` };
    else if (hk) ask = { kind: 'next', turnId: null, title: `Ask about ${hk}. It came up last time.` };
  }
  return { tryT, keep, ask };
}

// The server joins evidence bits with middle dots; on screen they read better as a list.
const evidenceText = (s) => String(s).replace(/\s+·\s+/g, ', ');

function quoteLine(cls, who, text) {
  return text ? el('p', { class: cls }, el('b', { text: who }), text) : null;
}

function playButton(turnId) {
  if (!Number.isInteger(turnId) || !turnById(turnId)) return null;
  return el('button', { class: 'play', type: 'button', on: { click: () => play(turnId) } }, el('span', { 'aria-hidden': 'true', text: '▶' }), ' Play the moment');
}

function tryCard(t, first) {
  const turn = t && Number.isInteger(t.turnId) ? turnById(t.turnId) : null;
  const kids = [el('span', { class: 'label', text: '1 · Try this next time' })];
  if (!t) {
    kids.push(el('p', { class: 'tk-note tk-empty', text: 'Nothing to redo this time.' }));
  } else {
    kids.push(
      quoteLine('tk-them', first, t.theySaid || null),
      quoteLine('tk-you', 'You', t.said || (turn ? turn.text : null)),
      t.tryInstead ? el('p', { class: 'tk-rewrite' }, el('b', { text: 'Try instead' }), t.tryInstead) : null,
      t.text ? el('p', { class: 'tk-note', text: t.text }) : (t.title ? el('p', { class: 'tk-note', text: t.title }) : null),
      t.evidence ? el('p', { class: 'tk-note tk-evidence', text: evidenceText(t.evidence) }) : null,
      playButton(t.turnId),
    );
  }
  return el('article', { class: 'takeaway try' }, ...kids);
}

function keepCard(t, first) {
  const turn = t && Number.isInteger(t.turnId) ? turnById(t.turnId) : null;
  const kids = [el('span', { class: 'label', text: '2 · Keep doing this' })];
  if (!t) {
    kids.push(el('p', { class: 'tk-note tk-empty', text: 'No moment stood out yet.' }));
  } else {
    const side = turn ? sideOf(turn, behaviorTurns().get(turn.turnId)) : null;
    kids.push(
      t.said ? quoteLine('tk-you', 'You', t.said)
        : turn ? quoteLine(side === 'them' ? 'tk-them' : 'tk-you', side === 'them' ? first : 'You', turn.text) : null,
      el('p', { class: 'tk-note', text: t.text || t.title || '' }),
      t.evidence ? el('p', { class: 'tk-note tk-evidence', text: evidenceText(t.evidence) }) : null,
      playButton(t.turnId),
    );
  }
  return el('article', { class: 'takeaway keep' }, ...kids);
}

function askCard(t) {
  return el('article', { class: 'takeaway ask' },
    el('span', { class: 'label', text: '3 · Ask about it next time' }),
    el('p', { class: 'tk-note big', text: t ? (t.title || t.text || '') : 'Ask what’s new since you talked.' }),
    t && t.title && t.text ? el('p', { class: 'tk-note', text: t.text }) : null,
    el('button', { class: 'play', type: 'button', on: { click: () => openDraft() } }, el('span', { 'aria-hidden': 'true', text: '✉' }), ' Use in follow-up'),
  );
}

// Why there are no cards yet, or null when there's something to show.
function takeawaysPending() {
  const c = state.convo;
  if (needsVoice()) return { msg: 'Pick which voice is yours first. Until then we can’t tell your lines from theirs.' };
  if (state.uploading || state.insightBusy) return { msg: 'Writing takeaways…', busy: true };
  if (state.analysing || (hasVideo() && !c.behavior)) return { msg: 'Takeaways show up once the video is analysed.' };
  if (state.insightError) {
    return {
      msg: `Couldn't write takeaways: ${state.insightError}`,
      action: el('button', { class: 'rp-btn rp-btn-quiet', type: 'button', text: 'Try again', on: { click: () => { state.insightAsked = null; state.insightError = null; ensureInsight(); } } }),
    };
  }
  if (!turnsOf(c).length) return { msg: 'Nothing to learn from yet: this conversation has no transcript.' };
  return null;
}

function renderTakeaways() {
  const box = $('takeaways');
  const pending = takeawaysPending();
  if (pending) {
    put(box, el('p', { class: `rp-tk-empty${pending.busy ? ' busy' : ''}` }, pending.msg, pending.action || null));
    return;
  }
  const { tryT, keep, ask } = threeTakeaways();
  if (!tryT && !keep && !ask) {
    put(box, el('p', { class: 'rp-tk-empty', text: 'No takeaways this time.' }));
    return;
  }
  const first = firstName();
  put(box, tryCard(tryT, first), keepCard(keep, first), askCard(ask));
}

// No insight yet (no video, or an older conversation): ask for one, once per page view.
function ensureInsight() {
  const c = state.convo;
  if (!c || c.insight || state.insightAsked === c.id || needsVoice() || state.picking) return;
  if (state.analysing || state.uploading || (hasVideo() && !c.behavior) || !turnsOf(c).length) return;
  const id = c.id;
  state.insightAsked = id;
  state.insightBusy = true;
  state.insightError = null;
  renderTakeaways();
  postJson(`/api/conversations/${enc(id)}/insight`, {})
    .then((ins) => { if (state.convo && state.convo.id === id && ins && !state.convo.insight) state.convo.insight = ins; })
    .catch((err) => {
      if (err.needsLabel) state.labelNeeded = true;
      else state.insightError = err.message;
    })
    .finally(() => {
      state.insightBusy = false;
      if (state.convo && state.convo.id === id) renderAll();
    });
}

// ---------- score strip ----------

// "Last time" numbers come from /compare, fetched once per conversation.
function ensureCompare() {
  const id = state.id;
  if (state.compare.id === id) return state.compare.data;
  state.compare = { id, data: null };
  getJson(`/api/conversations/${enc(id)}/compare`)
    .then((d) => { if (state.compare.id === id && state.convo) { state.compare.data = d; renderScores(); } })
    .catch(() => { /* first conversation, or an older server: no "last time" */ });
  return null;
}

function lastTime(key) {
  const cmp = ensureCompare();
  const m = cmp && Array.isArray(cmp.metrics) ? cmp.metrics.find((x) => x.key === key) : null;
  return m && isNum(m.before) ? m.before : null;
}

// Your lines after which they smiled (+10 points or more) or nodded, follow-ups vs the rest.
function reactionCounts() {
  const bts = behaviorTurns();
  if (!bts.size) return null;
  const fu = new Set([...markersByTurn(state.convo).entries()].filter(([, k]) => k.has('follow')).map(([id]) => id));
  const tally = { fu: [0, 0], other: [0, 0] };
  for (const bt of bts.values()) {
    if (bt.speaker !== 'you' || !bt.reaction) continue;
    const r = bt.reaction;
    const warm = (isNum(r.smileDelta) && r.smileDelta >= 0.1) || (isNum(r.nods) && r.nods > 0);
    const slot = fu.has(bt.turnId) ? tally.fu : tally.other;
    slot[1] += 1;
    if (warm) slot[0] += 1;
  }
  return tally;
}

function renderScores() {
  const box = $('scores');
  const c = state.convo;
  if (needsVoice()) {
    box.hidden = true;
    $('cue-note').hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  $('cue-note').hidden = false;
  const fu = [...markersByTurn(c).values()].filter((k) => k.has('follow')).length;
  const missed = c.hooks && Array.isArray(c.hooks.missedBids) ? c.hooks.missedBids.length : 0;
  const share = c.signals && isNum(c.signals.userTalkShare) ? pct(c.signals.userTalkShare) : null;
  const prevFu = lastTime('followUps');
  const prevShare = lastTime('userTalkShare');
  const awk = c.hooks && c.hooks.awkward ? awkward().flags.filter((f) => f.who === 'you') : null;
  const seen = c.behavior && isNum(c.behavior.faceSeenPct) ? pct(c.behavior.faceSeenPct > 1 ? c.behavior.faceSeenPct / 100 : c.behavior.faceSeenPct) : null;
  const tally = reactionCounts();
  let after;
  let other;
  if (!hasVideo()) {
    after = 'No camera on this call';
    other = 'No camera on this call';
  } else if (!tally) {
    after = state.analysing ? 'Analysing the video…' : 'Not analysed yet';
    other = after;
  } else {
    after = tally.fu[1] ? `Smiled or nodded after ${tally.fu[0]} of ${plural(tally.fu[1], 'follow-up')}` : 'No follow-ups to react to';
    other = tally.other[1] ? `${tally.other[0]} of ${plural(tally.other[1], 'other line')}` : '—';
  }
  const cell = (cls, big, label, small, title) => el('div', { class: cls, title },
    el('b', { text: big }), el('span', { text: label }), el('small', { text: small }));
  box.classList.toggle('has-awk', !!awk);
  put(box,
    cell('fu', String(fu), 'Follow-ups', prevFu !== null ? `Last time: ${prevFu}` : 'Questions that built on their words'),
    cell(`ms${missed ? ' some' : ''}`, String(missed), 'Missed moments', 'Openings you moved past'),
    awk ? cell(`awk${awk.length ? '' : ' none'}`, String(awk.length), 'Awkward moments',
      awk.length ? [...new Set(awk.map((f) => f.label))].join(', ') : 'Nothing flagged',
      awk.map((f) => `${f.label}: ${f.evidence || ''}`).join('\n') || null) : null,
    cell('talk', share !== null ? `${share}%` : '—', 'You talked', prevShare !== null ? `Last time: ${pct(prevShare)}%` : 'Share of the talking'),
    el('div', { class: 'react' },
      el('span', { text: 'Reactions' }),
      el('small', {}, el('strong', { text: 'After your follow-ups: ' }), after),
      el('small', {}, el('strong', { text: 'After other lines: ' }), other),
      seen !== null ? el('small', { text: `Their face was in view ${seen}% of the video.` }) : null),
  );
}

// ---------- folded details ----------

function turnChip(turnId) {
  const t = turnsOf(state.convo).find((x) => x.turnId === turnId);
  if (!t) return null;
  const labels = speakerLabels(turnsOf(state.convo));
  const who = speakerName(t, sideOf(t, behaviorTurns().get(turnId)), labels);
  return el('button', {
    class: 'rp-seek', type: 'button',
    title: t.text ? `“${t.text.slice(0, 140)}${t.text.length > 140 ? '…' : ''}”` : null,
    on: { click: () => seekToTurn(turnId) },
  }, el('span', { class: 'rp-play', 'aria-hidden': 'true', text: '▶' }),
  el('span', { class: 'rp-seek-time', text: fmtClock(t.startMs) }),
  el('span', { class: 'rp-seek-who', text: who }));
}

function renderChecked() {
  const c = state.convo;
  const note = c.note;
  const shown = note && note.text && note.status !== 'dropped';
  const ins = c.insight;
  const rows = ins && Array.isArray(ins.adviceCheck) ? ins.adviceCheck : [];
  put($('checked'),
    shown ? el('blockquote', { class: 'rp-note' },
      el('p', { class: 'rp-note-text', text: note.text }),
      note.suggestion ? el('p', { class: 'rp-note-sugg', text: note.suggestion }) : null)
      : el('p', { class: 'rp-dim', text: !note ? 'No coaching note yet.' : note.reason === 'too_short' ? 'Too short to coach.' : 'No advice this time, just the counts.' }),
    ins ? el('p', { class: 'rp-kicker' }, 'Checked against the video ',
      el('span', { class: `rp-source ${ins.source === 'muse-spark' ? 'ai' : ''}`, text: ins.source === 'muse-spark' ? 'written by Muse Spark from the measured cues' : 'written by rules, no AI' })) : null,
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
    })) : el('p', { class: 'rp-dim', text: ins ? 'No advice to check this time.' : 'The check shows up with the takeaways.' }),
  );
}

// What the transcript layer found (no AI).
function renderHooks() {
  const box = $('hooks');
  const h = state.convo.hooks;
  const fold = $('fold-hooks');
  const list = (k) => (h && Array.isArray(h[k]) ? h[k] : []);
  const chip = (text, turnId, cls = '') => (Number.isInteger(turnId)
    ? el('button', { class: `rp-hook-chip ${cls}`.trim(), type: 'button', title: 'Play this moment', on: { click: () => seekToTurn(turnId) } }, text)
    : el('span', { class: `rp-hook-chip ${cls}`.trim(), text }));
  const groups = [
    ['Topics', list('topics').map((t) => chip(t.term, Array.isArray(t.turnIds) ? t.turnIds[0] : null))],
    ['Coming up', list('events').map((e) => chip(e.text, e.turnId))],
    ['You promised', list('commitments').map((c) => chip(c.text, c.turnId))],
    ['Missed moments', list('missedBids').map((b) => chip(b.cue, b.turnId, 'missed'))],
    ['Awkward moments', needsVoice() ? [] : awkward().flags.map((f) => {
      const c = chip(`${f.who === 'you' ? 'You' : 'Them'}: ${f.label}`, f.turnId, `awk ${f.who === 'you' ? 'mine' : ''}`.trim());
      if (f.evidence) c.title = f.evidence;
      return c;
    })],
  ].filter(([, items]) => items.length);
  const qs = list('followUpDetector');
  fold.hidden = !groups.length && !qs.length;
  put(box,
    ...groups.map(([label, items]) => el('div', { class: 'rp-hook-group' },
      el('span', { class: 'rp-hook-label', text: label }),
      el('span', { class: 'rp-hook-chips' }, ...items))),
    qs.length ? el('p', { class: 'rp-hook-group' },
      el('span', { class: 'rp-hook-label', text: 'Follow-up detector' }),
      el('span', { text: `${qs.filter((q) => q.isFollowUp).length} of ${qs.length} questions built on what they said` })) : null,
  );
}

// ---------- word heatmap data ----------

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
      renderTranscript();
    })
    .catch(() => { /* plain transcript is fine */ });
}

// ---------- page ----------

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

// "Conversation with Maya": the capitalised first name, or "them" when nobody typed one.
function firstName() {
  const n = state.convo && state.convo.otherName;
  if (!n || n === 'them') return 'them';
  return cap(n.trim().split(/\s+/)[0]);
}

function initialsOf(name) {
  if (!name || name === 'them') return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
}

// "Today, 10:30 AM" / "Yesterday, 4:15 PM" / "Oct 20, 12:40 PM", like the Figma's `when`.
function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return `Today, ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday, ${time}`;
  return `${fmtDate(iso)}, ${time}`;
}

function renderHeader() {
  const c = state.convo;
  const first = firstName();
  $('title').textContent = `Conversation with ${first}`;
  document.title = c ? `Replay of ${c.otherName || 'a conversation'}` : 'Playback Replay';
  $('side-title').textContent = first === 'them' ? 'How they responded' : `How ${first} responded`;
  const tag = $('tag');
  tag.hidden = !(c && c.tag);
  tag.textContent = c && c.tag ? TAG_NAMES[c.tag] || c.tag : '';
  const turns = turnsOf(c);
  const dur = turns.length ? fmtClock(Math.max(...turns.map((t) => t.endMs || t.startMs || 0))) : null;
  $('person-avatar').textContent = initialsOf(c.otherName);
  $('person-name').textContent = c.otherName && c.otherName !== 'them' ? cap(c.otherName) : 'Someone';
  $('person-meta').textContent = [fmtWhen(c.createdAt), dur].filter(Boolean).join(' · ');
  put($('tl-key'),
    el('i', { class: 'you' }), 'You',
    el('i', { class: 'them' }), first === 'them' ? 'Them' : first,
    el('i', { class: 'fu' }), 'Follow-up',
    el('i', { class: 'ms' }), 'Missed moment',
    el('i', { class: 'awk' }), 'Awkward',
    el('i', { class: 'q' }), 'Asked',
    el('i', { class: 'sd' }), 'They brought up',
    el('i', { class: 'pr' }), 'Promised',
    el('i', { class: 'tk' }), 'Takeaway');
}

// ---------- follow-up draft (Figma .modal) ----------

function openDraft() {
  const c = state.convo;
  if (!c) return;
  const fu = c.followUp;
  const first = firstName();
  $('modal-label').textContent = `Draft for ${first}`;
  $('modal-note').textContent = `Based on your conversation on ${fmtWhen(c.createdAt) || fmtDate(c.createdAt)}. Edit it before you send.`;
  const ta = $('followup-text');
  // keep the person's edits while the modal is closed and reopened on the same conversation
  if (state.draftFor !== c.id) {
    ta.value = fu && fu.text ? fu.text : '';
    state.draftFor = c.id;
  }
  $('modal-copy').textContent = 'Copy message';
  $('modal').hidden = false;
  ta.focus();
}

function closeDraft() {
  $('modal').hidden = true;
}

// ---------- privacy box ----------

function renderPrivacy(confirming = false) {
  const box = $('privacy-actions');
  if (confirming) {
    put(box, el('div', { class: 'confirm-row' },
      el('button', { class: 'button stop-button', type: 'button', text: 'Yes, delete it', on: { click: deleteConvo } }),
      el('button', { class: 'button ghost', type: 'button', text: 'Keep it', on: { click: () => renderPrivacy(false) } })));
  } else {
    put(box, el('button', { class: 'button ghost', type: 'button', text: 'Delete conversation', on: { click: () => renderPrivacy(true) } }));
  }
}

async function deleteConvo() {
  const id = state.id;
  put($('privacy-actions'), el('p', { class: 'rp-voice-busy', text: 'Deleting…' }));
  try {
    const res = await fetch(`/api/conversations/${enc(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Server said ${res.status}`);
    $('video').pause();
    abortAnalysis();
    clearOverlay();
    goBack();
  } catch (err) {
    put($('privacy-actions'),
      el('p', { class: 'rp-voice-error', text: `Couldn't delete it: ${err.message}` }),
      el('button', { class: 'button ghost', type: 'button', text: 'Try again', on: { click: () => renderPrivacy(true) } }));
  }
}

// "Back to overview". Inside the studio the shell owns the tabs, so it hears about it too;
// either way this frame goes back to the list.
function goBack() {
  if (window.self !== window.top) {
    try { window.parent.postMessage({ type: 'playback:back' }, location.origin); } catch { /* a shell on another origin */ }
  }
  location.href = listHref();
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
  $('live-toggle-wrap').hidden = !video;
  if (video) loadMainVideo();
  $('hero').classList.toggle('no-video', !video);
  renderVoicePicker();
  renderAnalysisBar();
  renderTakeaways();
  renderScores();
  renderTranscript();
  renderNote();
  renderChecked();
  renderHooks();
  ensureHeatmap();
  drawLanes();
  updatePlayhead();
  if (!state.analysing && !state.frames) updateMeters(null, 0);
  else if (!state.analysing && hasVideo()) updateMeters(frameAt($('video').currentTime * 1000 - state.offsetMs), $('video').currentTime * 1000 - state.offsetMs);

  if (video && !c.behavior && !state.analysing && !state.autoStarted && !state.pendingUpload) {
    state.autoStarted = true;
    analyse();
  }
  ensureInsight();
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
    if (!$('live-toggle').checked && state.frames) updateMeters(frameAt(t), t);
  }
  if (video.paused || video.ended) { ticking = false; return; }
  requestAnimationFrame(tick);
}

function startTicking() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(tick);
}

async function refreshConvo() {
  try {
    const c = await getJson(`/api/conversations/${enc(state.id)}`);
    if (state.convo && c.id === state.convo.id) {
      state.convo = c;
      if (c.userLabel) state.labelNeeded = false;
    }
  } catch { /* keep what we have */ }
}

// ---------- which voice is yours ----------

// The picker is the whole page until it's answered: takeaways, scores and the timeline would all be
// about the wrong person, so they stay out of the DOM rather than rendering empty.
function renderVoicePicker() {
  const box = $('voice');
  const c = state.convo;
  const waiting = needsVoice() || !!state.picking;
  for (const id of ['takeaways', 'timeline']) $(id).hidden = waiting;
  if (!waiting) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const p = state.picking;
  if (p && !p.error) {
    put(box,
      el('h2', { class: 'rp-voice-title', text: p.coaching ? 'Coaching you now' : 'Which voice is yours?' }),
      el('p', { class: 'rp-voice-busy', text: p.step }));
    return;
  }
  const turns = turnsOf(c).filter((t) => t.speaker && t.speaker !== 'unknown');
  const labels = speakerLabels(turns);
  put(box,
    el('span', { class: 'label rp-voice-kicker', text: 'Before anything is scored' }),
    el('h2', { class: 'rp-voice-title', text: 'Which voice is yours?' }),
    el('p', { class: 'rp-voice-lede', text: 'Nothing is scored until you pick: we only coach you, never them.' }),
    labels.length >= 2 ? el('p', { class: 'rp-voice-count', text: `${labels.length} voices heard, one is you` }) : null,
    labels.length >= 3 ? el('p', { class: 'rp-voice-crowd', text: 'Loud room? Lines from other people get filtered once you pick yours.' }) : null,
    p && p.error ? el('p', { class: 'rp-voice-error', text: p.error }) : null,
    el('ol', { class: 'rp-voice-lines' }, ...turns.map((t) => el('li', {},
      el('button', { class: 'rp-voice-line', type: 'button', 'aria-label': `That’s me: voice ${t.speaker}, “${t.text || ''}”`, on: { click: () => pickVoice(t.speaker) } },
        el('span', { class: `rp-voice-letter spk-${Math.max(0, labels.indexOf(t.speaker))}`, text: t.speaker }),
        el('span', { class: 'rp-voice-text', text: t.text || '' }),
        el('span', { class: 'rp-voice-pick', 'aria-hidden': 'true', text: 'That’s me' }),
      )))),
  );
}

async function pickVoice(label) {
  if (state.picking && !state.picking.error) return;
  const id = state.id;
  const step = (text, coaching = false) => { state.picking = { step: text, error: null, coaching }; renderVoicePicker(); };
  try {
    step('Saving your voice…');
    await postJson(`/api/conversations/${enc(id)}/user-label`, { label });
    step('Coaching… about 25 s', true);
    const c = await postJson(`/api/conversations/${enc(id)}/process`, { reflection: '' });
    if (state.id !== id) return;
    if (c && c.id === id) state.convo = { ...state.convo, ...c };
    if (!state.convo.userLabel) state.convo.userLabel = label;
    state.labelNeeded = false;
    // The old cues were lined up against the wrong voice (or not at all): send them again.
    const rec = state.convo.recording;
    const frames = state.pendingUpload || (state.frames && state.frames.length ? state.frames : null);
    state.picking = null;
    state.heat.key = null;
    if (rec && frames) {
      renderAll();
      await upload(frames, rec.uploadedAt);
    } else if (rec) {
      // no frames on hand: let the analysis run (again) and post with the right voice
      if (!state.analysing) {
        state.autoStarted = false;
        state.convo.behavior = null;
      }
      renderAll();
    } else {
      state.convo.insight = null;
      state.insightAsked = null;
      renderAll();
    }
  } catch (err) {
    state.picking = { step: '', error: `Couldn’t save that: ${err.message}` };
    renderVoicePicker();
  }
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
  // Figma .conversation rows: avatar, name, when, "View full"
  const row = (c) => {
    const dur = c.turns && c.turns.length ? fmtClock(Math.max(...c.turns.map((t) => t.endMs || 0))) : null;
    const status = c.recording ? (c.behavior ? 'Analysed' : 'Not analysed yet') : 'No video';
    return el('li', {},
      el('a', { class: 'conversation', href: convoHref(c.id) },
        el('span', { class: 'person-avatar', text: initialsOf(c.otherName) }),
        el('div', {},
          el('h3', { text: c.otherName && c.otherName !== 'them' ? cap(c.otherName) : 'Someone' }),
          el('span', { text: [fmtWhen(c.createdAt), TAG_NAMES[c.tag] || c.tag, dur, c.seeded ? 'sample' : null].filter(Boolean).join(' · ') })),
        el('span', { class: `rp-convo-status${c.behavior ? ' done' : ''}`, text: status }),
        el('span', { class: 'deck-chip' }, 'View full ', el('span', { 'aria-hidden': 'true', text: '→' })),
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
  renderPrivacy(false);
  const video = $('video');
  for (const ev of ['play', 'seeked', 'timeupdate']) video.addEventListener(ev, startTicking);
  state.overlay = createFaceOverlay({
    video,
    canvas: $('overlay'),
    box: $('player'),
    detect: (source, dtMs) => detect(source, clock + dtMs).then((out) => out.res),
    enabled: liveOverlayOn,
    onFrame: onLiveFrame,
    colors: meshColors,
    onError: (err) => {
      console.warn('live overlay off', err);
      $('live-toggle').checked = false;
    },
  });
  if (params.get('debug') === 'overlay') window.__overlayDebug = state.overlay.debug;
  video.addEventListener('error', () => {
    if (video.getAttribute('src')) showAnalysisMsg("Couldn't play the video. The file may still be uploading or was removed.", true);
  });
  $('live-toggle').addEventListener('change', () => state.overlay.sync());
  $('analyze-btn').addEventListener('click', () => analyse());
  $('rerun-btn').addEventListener('click', () => analyse());
  $('back-link').addEventListener('click', goBack);
  $('draft-btn').addEventListener('click', openDraft);
  $('modal-close').addEventListener('click', closeDraft);
  $('modal-cancel').addEventListener('click', closeDraft);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeDraft(); });
  $('modal-copy').addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText($('followup-text').value).catch(() => {});
    $('modal-copy').textContent = 'Copied';
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeDraft(); });
  const track = $('track');
  track.addEventListener('click', onTrackClick);
  track.addEventListener('mousemove', onTrackHover);
  track.addEventListener('mouseleave', () => { $('hover').hidden = true; });
  new ResizeObserver(() => drawLanes()).observe(track);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawLanes());

  if (state.id) loadConvo();
  else loadList();
  connect();
}

init();
