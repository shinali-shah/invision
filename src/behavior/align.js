// Lines up per-frame face cues (from the pretrained model on the Replay page) with the transcript.
// Arithmetic only: every number here can be traced back to frames you can scrub to.

import { tokens } from '../nlp/text.js';

const REACTION_MS = 2500;
const FACING_DEG = 25;
const NOD_DEG = 5;
const NOD_MS = 1500;
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
function withMotion(frames) {
  let prev = null;
  return frames.map(f => {
    const motion = f.face && prev?.face
      ? Math.abs(f.smile - prev.smile) + Math.abs(f.jawOpen - prev.jawOpen) + Math.abs(f.browUp - prev.browUp)
      : null;
    prev = f;
    return { ...f, motion };
  });
}

const facing = f => f.face && Math.abs(f.yaw) < FACING_DEG && Math.abs(f.pitch) < FACING_DEG;

// A nod is the head pitching one way by a few degrees and coming back, within a second and a half.
export function countNods(frames) {
  const pts = frames.filter(f => f.face);
  let nods = 0;
  let i = 0;
  while (i < pts.length) {
    const start = pts[i];
    let j = i + 1;
    let far = null;
    for (; j < pts.length && pts[j].t - start.t <= NOD_MS; j++) {
      const d = pts[j].pitch - start.pitch;
      if (!far && Math.abs(d) >= NOD_DEG) far = Math.sign(d);
      if (far && Math.abs(pts[j].pitch - start.pitch) < NOD_DEG / 2) break;
    }
    if (far && j < pts.length && pts[j].t - start.t <= NOD_MS) {
      nods++;
      i = j + 1;
    } else {
      i++;
    }
  }
  return nods;
}

function windowStats(frames, from, to) {
  const inside = frames.filter(f => f.t >= from && f.t <= to);
  const faces = inside.filter(f => f.face);
  if (!faces.length) return null;
  return {
    smile: mean(faces.map(f => f.smile)),
    smilePeak: Math.max(...faces.map(f => f.smile)),
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
  if (/!/.test(String(text ?? ''))) pos += 0.5;
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
  const baseline = {
    smile: round(median(faces.map(f => f.smile))),
    animation: round(median(faces.map(f => f.motion).filter(m => m != null)), 3),
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
