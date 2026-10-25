// Word-level view of a conversation: which words carried it and which got dropped.
// Built from the same hooks, signals and face cues the rest of the app uses, so every
// coloured word has a reason you can read.

import { contentWords, stem } from './text.js';

const MAX_PER_LINE = 3;

const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'erm', 'hmm', 'like', 'basically', 'literally', 'eh', 'este', 'osea', 'o sea']);

export const LEGEND = [
  { kind: 'picked-up', label: 'They said it and you picked it up', good: true },
  { kind: 'follow-up', label: 'Your follow-up built on their words', good: true },
  { kind: 'topic', label: 'Something they kept coming back to', good: true },
  { kind: 'promise', label: 'A promise you made: follow through', good: true },
  { kind: 'smile', label: 'They were smiling as this was said', good: true },
  { kind: 'missed', label: 'They opened up here and the next line moved on', good: false },
  { kind: 'filler', label: 'Filler', good: false },
  { kind: 'flat', label: 'Upbeat words, flat face (mixed signal)', good: false },
];

const bare = raw => raw.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');

// Smile at a moment, from the closest face frame within 400 ms.
function smileAt(frames, t) {
  let best = null;
  for (const f of frames) {
    if (!f.face) continue;
    const d = Math.abs(f.t - t);
    if (d <= 400 && (!best || d < best.d)) best = { d, smile: f.smile };
  }
  return best?.smile ?? null;
}

export function buildHeatmap({ turns, userLabel, hooks, signals, behavior, frames = [] }) {
  const ts = Array.isArray(turns) ? turns : [];
  const topicStems = new Set((hooks?.topics ?? []).flatMap(t => [...contentWords(t.term)]));
  const missed = new Map((hooks?.missedBids ?? []).map(b => [b.turnId, b]));
  const commitments = new Set((hooks?.commitments ?? []).map(c => c.turnId));
  const followUpOverlap = new Map((hooks?.followUpDetector ?? []).filter(d => d.isFollowUp).map(d => [d.turnId, new Set(d.overlap.map(stem))]));
  const isFollowUp = new Set((signals?.questions ?? []).filter(q => q.isFollowUp).map(q => q.turnId));
  const cues = new Map((behavior?.turns ?? []).map(b => [b.turnId, b]));
  const baseline = behavior?.baseline?.smile ?? null;

  // Words the user later echoed back from their lines: the threads they actually pulled on.
  const pickedUp = new Map(); // turnId of their line -> Set of stems
  ts.forEach((t, i) => {
    if (t.speaker !== userLabel) return;
    const prev = ts.slice(0, i).reverse().find(p => p.speaker !== userLabel);
    if (!prev) return;
    const mine = contentWords(t.text);
    const shared = [...contentWords(prev.text)].filter(s => mine.has(s));
    if (shared.length) pickedUp.set(prev.turnId, new Set([...(pickedUp.get(prev.turnId) ?? []), ...shared]));
  });

  return {
    legend: LEGEND,
    turns: ts.map(t => {
      const you = t.speaker === userLabel;
      const raw = String(t.text ?? '').split(/\s+/).filter(Boolean);
      const span = Math.max(0, (t.endMs ?? 0) - (t.startMs ?? 0));
      const cue = cues.get(t.turnId);
      const bid = missed.get(t.turnId);
      const bidStems = bid ? contentWords(bid.cue) : new Set();

      const words = raw.map((w, i) => {
        const b = bare(w);
        const s = b.length >= 4 ? stem(b) : b;
        const mark = (score, kind, why) => ({ w, score, kind, why });

        if (you) {
          if (FILLERS.has(b)) return mark(-0.35, 'filler', 'Filler word');
          if (followUpOverlap.get(t.turnId)?.has(s) || (isFollowUp.has(t.turnId) && topicStems.has(s))) {
            return mark(0.8, 'follow-up', 'Your question built on what they just said');
          }
          if (commitments.has(t.turnId) && b.length >= 4) return mark(0.45, 'promise', 'You promised this; the brief will remind you');
          return mark(0, null, null);
        }

        if (pickedUp.get(t.turnId)?.has(s)) return mark(0.8, 'picked-up', 'You picked this up in your next line');
        if (bid && (bidStems.has(s) || (b.length >= 4 && contentWords(b).size && topicStems.has(s)))) {
          return mark(-0.8, 'missed', 'They opened up here; your next line moved on');
        }
        // Rough word timing: spread the turn evenly over its words.
        const at = (t.startMs ?? 0) + (raw.length > 1 ? (span * i) / (raw.length - 1) : 0);
        const smile = frames.length ? smileAt(frames, at) : null;
        if (smile != null && baseline != null && smile >= baseline + 0.2 && contentWords(b).size) {
          return mark(0.6, 'smile', `Smiling here (${Math.round(smile * 100)}%)`);
        }
        if (topicStems.has(s)) return mark(0.5, 'topic', 'They kept coming back to this');
        if (cue?.congruence === 'mixed' && cue.textTone === 'positive' && raw.length >= 6 && b.length >= 4 && contentWords(b).size) {
          return mark(-0.3, 'flat', 'Upbeat words, but the face cues stayed flat');
        }
        return mark(0, null, null);
      });

      // A few strong colours per line read as advice; a wall of tints reads as noise.
      const keep = new Set(words.map((w, i) => [Math.abs(w.score), i]).filter(([v]) => v > 0)
        .sort((a, b) => b[0] - a[0]).slice(0, MAX_PER_LINE).map(([, i]) => i));
      words.forEach((w, i) => { if (!keep.has(i)) Object.assign(w, { score: 0, kind: null, why: null }); });

      return {
        turnId: t.turnId,
        speaker: you ? 'you' : 'them',
        startMs: t.startMs ?? 0,
        endMs: t.endMs ?? 0,
        reaction: you ? cue?.reaction?.smileDelta ?? null : null,
        words,
      };
    }),
  };
}
