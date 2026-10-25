// The live face mesh over the Replay player. Detection runs once per presented video frame
// (requestVideoFrameCallback), every landmark goes through a One Euro filter so the mesh sits
// still on a still face but doesn't trail a moving one, and the drawing is mapped onto the
// rectangle the video actually occupies inside its object-fit: contain box.
//
// replay.js owns the landmarker (and the monotonic timestamp clock the analysis pass shares),
// so it hands us a detect(source, dtMs) that returns the landmarker result.

const HOLD_MS = 150;        // keep the last mesh this long when a frame has no face
const FADE_MS = 250;        // then fade it out instead of blinking off
const SNAP_GAP_MS = 400;    // a face gone longer than this comes back without smoothing
const SLOW_DETECT_MS = 25;  // above this per frame, detect every 2nd frame
const SEEK_FRAME_WAIT_MS = 120;
const TESSELATION_EVERY = 3;

// One Euro filter (Casiez et al.): cutoff rises with speed, so a resting face gets heavy
// smoothing and a turning head gets almost none. Speed is measured in rendered pixels so the
// tuning doesn't change with the player size.
const MIN_CUTOFF = 1.0;     // Hz, when still
const BETA = 0.03;          // extra Hz per px/s
const D_CUTOFF = 1.0;

function alphaFor(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

class MeshSmoother {
  constructor() {
    this.n = 0;
    this.x = null;   // filtered position, normalised units
    this.dx = null;  // filtered velocity, normalised units/s
    this.live = false;
  }

  reset() { this.live = false; }

  // pts: landmarks as {x, y}; dt in seconds; scale: rendered px per normalised unit (w, h).
  // Returns the filtered coordinates, interleaved x,y, in normalised units.
  push(pts, dt, scaleW, scaleH) {
    const n = pts.length;
    if (!this.live || n !== this.n) {
      this.n = n;
      this.x = new Float32Array(n * 2);
      this.dx = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { this.x[i * 2] = pts[i].x; this.x[i * 2 + 1] = pts[i].y; }
      this.live = true;
      return this.x;
    }
    const step = Math.max(1e-3, dt);
    const aD = alphaFor(D_CUTOFF, step);
    const { x, dx } = this;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        const raw = k ? p.y : p.x;
        const v = (raw - x[j]) / step;
        dx[j] += aD * (v - dx[j]);
        const speedPx = Math.abs(dx[j]) * (k ? scaleH : scaleW);
        const a = alphaFor(MIN_CUTOFF + BETA * speedPx, step);
        x[j] += a * (raw - x[j]);
      }
    }
    return x;
  }
}

export function contentRect(boxW, boxH, vw, vh) {
  if (!vw || !vh) return { x: 0, y: 0, w: boxW, h: boxH };
  const s = Math.min(boxW / vw, boxH / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

export function sizeCanvas(canvas, w, h) {
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

let sets = null;
async function connectorSets() {
  if (sets) return sets;
  const { FaceLandmarker: F } = await import('./vendor/mediapipe/vision_bundle.mjs');
  const pairs = (list) => list.map((c) => [c.start, c.end]);
  sets = {
    tess: pairs(F.FACE_LANDMARKS_TESSELATION.filter((_, i) => i % TESSELATION_EVERY === 0)),
    oval: pairs(F.FACE_LANDMARKS_FACE_OVAL),
    bone: pairs([...F.FACE_LANDMARKS_LEFT_EYE, ...F.FACE_LANDMARKS_RIGHT_EYE, ...F.FACE_LANDMARKS_LEFT_EYEBROW, ...F.FACE_LANDMARKS_RIGHT_EYEBROW]),
    iris: pairs([...F.FACE_LANDMARKS_LEFT_IRIS, ...F.FACE_LANDMARKS_RIGHT_IRIS]),
    lips: pairs(F.FACE_LANDMARKS_LIPS),
  };
  return sets;
}

function strokeSet(ctx, edges, xy, r) {
  ctx.beginPath();
  for (const [a, b] of edges) {
    ctx.moveTo(r.x + xy[a * 2] * r.w, r.y + xy[a * 2 + 1] * r.h);
    ctx.lineTo(r.x + xy[b * 2] * r.w, r.y + xy[b * 2 + 1] * r.h);
  }
  ctx.stroke();
}

// xy: interleaved normalised landmark coordinates. r: the rendered video rect in CSS px.
// Line weights follow the face's rendered width and never go under one device pixel.
export function drawMesh(ctx, xy, r, { bone = '#f3ead8', marigold = '#f4a51c', alpha = 1 } = {}) {
  if (!sets || !xy || xy.length < 2 * 468) return;
  let minX = 1; let maxX = 0;
  for (let i = 0; i < xy.length; i += 2) { if (xy[i] < minX) minX = xy[i]; if (xy[i] > maxX) maxX = xy[i]; }
  const faceW = Math.max(1, (maxX - minX) * r.w);
  const dpr = window.devicePixelRatio || 1;
  const hair = 1 / dpr;
  const line = Math.max(hair, Math.min(2, faceW / 260));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.strokeStyle = bone;
  ctx.lineWidth = Math.max(hair, line * 0.5);
  ctx.globalAlpha = alpha * 0.22;
  strokeSet(ctx, sets.tess, xy, r);

  // a soft glow around the face oval, then the oval itself
  ctx.globalAlpha = alpha * 0.55;
  ctx.shadowColor = marigold;
  ctx.shadowBlur = Math.max(4, faceW / 18);
  ctx.strokeStyle = marigold;
  ctx.lineWidth = line * 1.2;
  strokeSet(ctx, sets.oval, xy, r);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = alpha * 0.8;
  ctx.strokeStyle = bone;
  ctx.lineWidth = line;
  strokeSet(ctx, sets.oval, xy, r);

  ctx.globalAlpha = alpha * 0.9;
  strokeSet(ctx, sets.bone, xy, r);
  ctx.lineWidth = Math.max(hair, line * 0.8);
  strokeSet(ctx, sets.iris, xy, r);

  ctx.strokeStyle = marigold;
  ctx.lineWidth = line * 1.25;
  ctx.globalAlpha = alpha;
  strokeSet(ctx, sets.lips, xy, r);
  ctx.restore();
}

// video: the player's <video>. canvas: the overlay over it. box: the element whose size both
// fill. detect(source, dtMs) -> Promise<result | null>. enabled() says whether to run at all.
// onFrame(result, mediaTimeSec) fires per detection; onError(err) when detection gives up.
export function createFaceOverlay({ video, canvas, box, detect, enabled, onFrame, onError, colors }) {
  const smoother = new MeshSmoother();
  let ctx = null;
  let rect = contentRect(0, 0, 0, 0);
  let drawn = null;            // last filtered mesh we put on screen
  let lastFaceAt = 0;          // performance.now() of the last detection with a face
  let lastMediaTime = -1;
  let lastDetectMedia = -1;
  let detectMs = 0;            // EMA of detectForVideo cost
  let skipNext = false;
  let busy = false;
  let vfcHandle = 0;
  let rafHandle = 0;
  let seekToken = 0;
  let fading = 0;
  let destroyed = false;
  const stats = { detections: 0, draws: 0, skipped: 0, dropped: 0, decimated: false, delegateMs: 0 };
  const samples = [];          // debug trail of drawn nose positions

  const hasVfc = typeof video.requestVideoFrameCallback === 'function';

  function layout() {
    const W = box.clientWidth;
    const H = box.clientHeight;
    ctx = sizeCanvas(canvas, W, H);
    rect = contentRect(W, H, video.videoWidth, video.videoHeight);
  }

  function clearCanvas() {
    if (!ctx) layout();
    ctx.clearRect(0, 0, box.clientWidth, box.clientHeight);
  }

  function paint(alpha) {
    if (!drawn) return;
    clearCanvas();
    drawMesh(ctx, drawn, rect, { ...(colors ? colors() : {}), alpha });
    stats.draws += 1;
    if (samples.length < 4000) samples.push({ at: performance.now(), vt: video.currentTime, nose: [drawn[2], drawn[3]] });
  }

  function clear() {
    cancelAnimationFrame(fading);
    fading = 0;
    drawn = null;
    smoother.reset();
    lastMediaTime = -1;
    lastDetectMedia = -1;
    clearCanvas();
  }

  // After HOLD_MS without a face, fade the held mesh out over FADE_MS.
  function fadeOut(now) {
    const gone = now - lastFaceAt;
    if (gone < HOLD_MS) { paint(1); return; }
    const a = 1 - (gone - HOLD_MS) / FADE_MS;
    if (a <= 0) { drawn = null; smoother.reset(); clearCanvas(); return; }
    paint(a);
    if (!fading) fading = requestAnimationFrame((t) => { fading = 0; if (!drawn || !enabled()) return; if (performance.now() - lastFaceAt >= HOLD_MS) fadeOut(t); });
  }

  // One frame: run the model (unless decimated), filter, draw.
  async function step(mediaTime, { force = false } = {}) {
    if (destroyed || busy || !enabled() || video.readyState < 2) return;
    if (!force && mediaTime <= lastMediaTime) return; // the same frame again, or a backwards hop we didn't ask for
    const dt = lastMediaTime < 0 || mediaTime < lastMediaTime ? 1 / 30 : mediaTime - lastMediaTime;
    lastMediaTime = mediaTime;
    if (!force && stats.decimated && skipNext) {
      skipNext = false;
      stats.skipped += 1;
      if (drawn) paint(1); // hold the filtered mesh on the in-between frame
      return;
    }
    skipNext = true;
    busy = true;
    try {
      const dtMs = Math.max(1, Math.round((force || lastDetectMedia < 0 ? 1 / 30 : mediaTime - lastDetectMedia) * 1000));
      lastDetectMedia = mediaTime;
      const t0 = performance.now();
      let res = await detect(video, dtMs);
      // After a seek the model still looks where the face was on the previous frame and comes
      // back empty once; a second pass on the same frame runs the detector afresh.
      if (force && !(res && res.faceLandmarks && res.faceLandmarks[0]) && !destroyed && enabled()) res = await detect(video, 1);
      const cost = performance.now() - t0;
      stats.detections += 1;
      // the first couple of calls carry the model's warm-up, not the per-frame cost
      if (stats.detections > 2) {
        detectMs = detectMs ? detectMs * 0.8 + cost * 0.2 : cost;
        stats.delegateMs = detectMs;
        stats.decimated = detectMs > SLOW_DETECT_MS;
      }
      if (destroyed || !enabled()) return;
      if (ctx === null || canvas.width === 0) layout();
      const pts = res && res.faceLandmarks && res.faceLandmarks[0];
      const now = performance.now();
      if (pts) {
        if (force || now - lastFaceAt > SNAP_GAP_MS) smoother.reset();
        drawn = smoother.push(pts, dt, rect.w, rect.h);
        lastFaceAt = now;
        cancelAnimationFrame(fading);
        fading = 0;
        paint(1);
      } else {
        stats.dropped += 1;
        if (drawn) fadeOut(now);
      }
      if (onFrame) onFrame(res, mediaTime);
    } catch (err) {
      clear();
      if (onError) onError(err);
    } finally {
      busy = false;
    }
  }

  function loop() {
    stopLoop();
    if (destroyed || video.paused || video.ended) return;
    if (hasVfc) {
      vfcHandle = video.requestVideoFrameCallback((_, meta) => { vfcHandle = 0; step(meta.mediaTime); loop(); });
    } else {
      rafHandle = requestAnimationFrame(() => { rafHandle = 0; step(video.currentTime); loop(); });
    }
  }

  function stopLoop() {
    if (vfcHandle) { video.cancelVideoFrameCallback(vfcHandle); vfcHandle = 0; }
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = 0; }
  }

  // Paused or just seeked: one detection on the frame now showing. Right after a seek the
  // element can still hand the model the old frame, so wait for the new one to be presented
  // (rVFC fires for that even while paused), with a short fallback if it never does.
  function refresh() {
    const token = ++seekToken;
    smoother.reset();
    const go = () => { if (token === seekToken && !destroyed) step(video.currentTime, { force: true }); };
    if (!hasVfc || !video.paused) { go(); return; }
    let timer = 0;
    const h = video.requestVideoFrameCallback(() => { clearTimeout(timer); go(); });
    timer = setTimeout(() => { video.cancelVideoFrameCallback(h); go(); }, SEEK_FRAME_WAIT_MS);
  }

  const onPlay = () => { if (!enabled()) return; smoother.reset(); lastMediaTime = -1; loop(); };
  const onPause = () => { stopLoop(); if (enabled()) refresh(); };
  const onSeeking = () => { seekToken += 1; lastMediaTime = -1; smoother.reset(); };
  const onSeeked = () => { if (video.paused && enabled()) refresh(); };
  const onEmptied = () => { stopLoop(); clear(); };
  const onMeta = () => { layout(); if (drawn) paint(1); };
  video.addEventListener('play', onPlay);
  video.addEventListener('playing', onPlay);
  video.addEventListener('pause', onPause);
  video.addEventListener('ended', onPause);
  video.addEventListener('seeking', onSeeking);
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('emptied', onEmptied);
  video.addEventListener('loadedmetadata', onMeta);
  const ro = new ResizeObserver(() => { layout(); if (drawn) paint(1); });
  ro.observe(box);
  const onFs = () => { layout(); if (drawn) paint(1); };
  document.addEventListener('fullscreenchange', onFs);
  connectorSets().then(() => { if (drawn) paint(1); }).catch((err) => { if (onError) onError(err); });

  return {
    refresh,
    clear,
    // the toggle flipped, or analysis finished: pick up where the video is
    sync() {
      if (!enabled()) { stopLoop(); clear(); return; }
      if (video.paused || video.ended) refresh(); else loop();
    },
    // for measurements: what was drawn, and how often
    debug: {
      stats: () => ({ ...stats, detectMs: +detectMs.toFixed(2), rect: { ...rect }, canvas: { w: canvas.width, h: canvas.height }, hasVfc }),
      samples: () => samples.slice(),
      drawn: () => (drawn ? Array.from(drawn) : null),
    },
    destroy() {
      destroyed = true;
      stopLoop();
      ro.disconnect();
      document.removeEventListener('fullscreenchange', onFs);
      for (const [ev, fn] of [['play', onPlay], ['playing', onPlay], ['pause', onPause], ['ended', onPause], ['seeking', onSeeking], ['seeked', onSeeked], ['emptied', onEmptied], ['loadedmetadata', onMeta]]) video.removeEventListener(ev, fn);
    },
  };
}
