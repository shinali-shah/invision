// Lines up per-frame face cues (from the pretrained model on the Replay page) with the transcript.
// Arithmetic only: every number here can be traced back to frames you can scrub to.

import { tokens } from '../nlp/text.js';

const REACTION_MS = 2500;
const FACING_DEG = 25;
// Nod thresholds are shared with public/replay.js (findNods), so the ticks match the counts.
// 8° because a phone held in a hand wobbles the measured pitch by 5-7° between frames at 5 fps
// (p90 on real footage), and real nods on the same footage were 9-20°.
const NOD_DEG = 8;
const NOD_MAX_MS = 1500;
const NOD_REF_MS = 1000;
const NOD_GAP_MS = 500;
const MAX_FRAMES = 20000;

const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const num = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function cleanFrames(frames) {
  if (!Array.isArray(frames)) return [];
  return frames
    .filter(f => f && Number.isFinite(f.t))
    .slice(0, MAX_FRAMES)
    .map(f => ({
      t: f.t,
      face: f.face === true,
      smile: num(f.smile, 0, 1),
      jawOpen: num(f.jawOpen, 0, 1),
      browUp: num(f.browUp, 0, 1),
      yaw: num(f.yaw, -180, 180),
      pitch: num(f.pitch, -180, 180),
    }))
    .sort((a, b) => a.t - b.t);
}

// How much the face is moving: change in the expression scores from one frame to the next.
// Also `steady`: the smile with one-frame blips taken out (talking makes the score jump for a
// single frame), the median of each face frame with its neighbours.
function withMotion(frames) {
  const faces = frames.filter(f => f.face);
  const at = new Map(faces.map((f, i) => [f, i]));
  let prev = null;
  return frames.map(f => {
    const motion = f.face && prev?.face
      ? Math.abs(f.smile - prev.smile) + Math.abs(f.jawOpen - prev.jawOpen) + Math.abs(f.browUp - prev.browUp)
      : null;
    prev = f;
    let steady = f.smile;
    if (f.face) {
      const i = at.get(f);
      const before = faces[i - 1];
      const after = faces[i + 1];
      if (before && after && f.t - before.t <= NOD_GAP_MS && after.t - f.t <= NOD_GAP_MS) {
        steady = [before.smile, f.smile, after.smile].sort((a, b) => a - b)[1];
      }
    }
    return { ...f, motion, steady };
  });
}

const facing = f => f.face && Math.abs(f.yaw) < FACING_DEG && Math.abs(f.pitch) < FACING_DEG;

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

// A nod: pitch swings at least NOD_DEG away from where it was a moment ago (either way) and
// comes back within NOD_MAX_MS. Returns transcript ms of the furthest point of each one.
// Keep in step with findNods in public/replay.js (a test checks they agree).
export function nodTimes(frames) {
  const out = [];
  const pts = frames.filter(f => f.face);
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

export const countNods = frames => nodTimes(frames).length;

function windowStats(frames, from, to) {
  const inside = frames.filter(f => f.t >= from && f.t <= to);
  const faces = inside.filter(f => f.face);
  if (!faces.length) return null;
  return {
    smile: mean(faces.map(f => f.smile)),
    smilePeak: Math.max(...faces.map(f => f.steady)),
    facingPct: inside.length ? inside.filter(facing).length / inside.length : null,
    nods: countNods(inside),
    animation: mean(faces.map(f => f.motion).filter(m => m != null)),
  };
}

const POSITIVE = new Set([
  'love', 'loved', 'great', 'amazing', 'awesome', 'excited', 'fun', 'happy', 'glad', 'nice', 'cool', 'beautiful',
  'favorite', 'favourite', 'enjoy', 'enjoyed', 'wonderful', 'best', 'proud', 'finally', 'haha', 'lol', 'yay',
  'encanta', 'encantó', 'feliz', 'bonito', 'bonita', 'genial', 'padre', 'chido', 'bueno', 'buenísimo', 'jaja', 'jajaja', 'risa',
]);
const NEGATIVE = new Set([
  'tired', 'hard', 'stressed', 'stress', 'worried', 'sad', 'bad', 'awful', 'terrible', 'hate', 'ugh', 'sucks',
  'difficult', 'rough', 'sick', 'lonely', 'scared', 'nervous', 'miss', 'lost', 'cansada', 'cansado', 'triste',
  'difícil', 'mal', 'preocupada', 'preocupado', 'duele', 'extraño',
]);

export function textTone(text) {
  let pos = 0;
  let neg = 0;
  for (const w of tokens(text)) {
    if (POSITIVE.has(w)) pos++;
    if (NEGATIVE.has(w)) neg++;
  }
  // "!" makes a positive line more so, but "Hi! I'm Maya." isn't upbeat by itself.
  if (pos && /!/.test(String(text ?? ''))) pos += 0.5;
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

// Compares what was said with what the face did. "mixed" just means the two didn't line up.
function congruence(tone, stats, baseline, words) {
  // "Nice to meet you too" is manners, not a signal either way.
  if (!stats || tone === 'neutral' || words < 6 || baseline.smile == null) return null;
  const lit = stats.smile >= baseline.smile + 0.05 || stats.smilePeak >= 0.4;
  const flat = stats.smile < baseline.smile + 0.02 && (baseline.animation == null || (stats.animation ?? 0) <= baseline.animation);
  if (tone === 'positive') return lit ? 'match' : flat ? 'mixed' : null;
  return stats.smile >= baseline.smile + 0.15 ? 'mixed' : 'match';
}

function summarize(list) {
  const rs = list.filter(Boolean);
  return { n: rs.length, smileDelta: round(mean(rs.map(r => r.smileDelta))), nods: round(mean(rs.map(r => r.nods)), 1) };
}

export function alignBehavior({ model, fps, frames, turns, userLabel, signals, hooks }) {
  const fs = withMotion(cleanFrames(frames));
  const faces = fs.filter(f => f.face);
  // Means, like the per-window numbers they get compared with. The smile score is skewed (mostly
  // low, with blips while talking), so a median here sat 6-8 points under every window's mean on
  // real footage and made every reaction read as a smile.
  const baseline = {
    smile: round(mean(faces.map(f => f.smile))),
    animation: round(mean(faces.map(f => f.motion).filter(m => m != null)), 3),
  };

  const rows = (turns ?? []).map(t => {
    const you = t.speaker === userLabel;
    const stats = windowStats(fs, t.startMs ?? 0, t.endMs ?? 0);
    const after = you ? windowStats(fs, t.endMs ?? 0, (t.endMs ?? 0) + REACTION_MS) : null;
    const tone = textTone(t.text);
    return {
      turnId: t.turnId,
      speaker: you ? 'you' : 'them',
      smile: round(stats?.smile),
      smilePeak: round(stats?.smilePeak),
      facingPct: round(stats?.facingPct),
      nods: stats ? stats.nods : null,
      animation: round(stats?.animation, 3),
      reaction: after && baseline.smile != null
        ? { smileDelta: round(after.smile - baseline.smile), nods: after.nods, facingPct: round(after.facingPct) }
        : null,
      textTone: tone,
      congruence: you ? null : congruence(tone, stats, baseline, String(t.text ?? '').split(/\s+/).filter(Boolean).length),
    };
  });

  const byTurn = new Map(rows.map(r => [r.turnId, r]));
  const followUpIds = new Set(
    (signals?.questions ?? []).some(q => q.isFollowUp !== null)
      ? signals.questions.filter(q => q.isFollowUp).map(q => q.turnId)
      : (hooks?.followUpDetector ?? []).filter(d => d.isFollowUp).map(d => d.turnId),
  );
  const yours = rows.filter(r => r.speaker === 'you');

  return {
    model: typeof model === 'string' ? model.slice(0, 80) : 'unknown',
    fps: Number.isFinite(fps) ? fps : null,
    frameCount: fs.length,
    faceSeenPct: fs.length ? round(faces.length / fs.length) : 0,
    baseline,
    turns: rows,
    stats: {
      afterFollowUps: summarize(yours.filter(r => followUpIds.has(r.turnId)).map(r => r.reaction)),
      afterOther: summarize(yours.filter(r => !followUpIds.has(r.turnId)).map(r => r.reaction)),
      missedBidReactions: (hooks?.missedBids ?? [])
        .map(b => ({ turnId: b.turnId, smileDelta: byTurn.get(b.replyTurnId)?.reaction?.smileDelta ?? null }))
        .filter(b => b.smileDelta != null),
    },
  };
}
