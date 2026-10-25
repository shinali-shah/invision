// Lip lock. The phone sends cue samples while it records: is there a face, is its mouth moving
// (`theirs`), is the mic hearing the close loud voice (`mine`). Lined up with the diarized turns
// that says whose line each one is, and which ones belong to nobody at the table.

const LOW = 0.6;            // "both low" means under minOverlap * LOW; in between we don't judge
const MIN_COVERED = 0.5;    // the cue track has to reach at least this much of a turn to say anything
const MIN_FACE = 0.5;       // same for a face being in view before a line can be called crowd
const MAX_CROWD_MS = 10000; // a bystander doesn't hold the floor this long; past it we just don't know
const MAX_SPAN_MS = 1000;   // a hole in the cue track (tab hidden) is not coverage

const round2 = n => Math.round(n * 100) / 100;

// Each sample stands for the time until the next one.
function spans(cues) {
  const xs = (Array.isArray(cues) ? cues : []).filter(c => c && Number.isFinite(c.t)).sort((a, b) => a.t - b.t);
  const gaps = xs.slice(1).map((c, i) => c.t - xs[i].t).filter(g => g > 0).sort((a, b) => a - b);
  const typical = gaps.length ? gaps[gaps.length >> 1] : 125;
  return xs.map((c, i) => {
    const next = xs[i + 1];
    const len = Math.min(MAX_SPAN_MS, next ? next.t - c.t : typical);
    return { from: c.t, to: c.t + len, face: !!c.face, theirs: !!c.theirs, mine: !!c.mine };
  });
}

function coverage(turn, spanList) {
  const dur = turn.endMs - turn.startMs;
  const sum = { covered: 0, face: 0, theirs: 0, mine: 0 };
  for (const s of spanList) {
    const o = Math.min(s.to, turn.endMs) - Math.max(s.from, turn.startMs);
    if (o <= 0) continue;
    sum.covered += o;
    if (s.face) sum.face += o;
    if (s.theirs) sum.theirs += o;
    if (s.mine) sum.mine += o;
  }
  return { covered: sum.covered / dur, face: sum.face / dur, theirs: sum.theirs / dur, mine: sum.mine / dur, dur };
}

function judge(turn, spanList, minOverlap) {
  if (!Number.isFinite(turn.startMs) || !Number.isFinite(turn.endMs) || turn.endMs <= turn.startMs) return ['unknown', 0];
  const c = coverage(turn, spanList);
  if (c.covered < MIN_COVERED) return ['unknown', 0];
  if (c.theirs >= minOverlap && c.theirs > c.mine) return ['them', round2(Math.min(1, c.theirs - c.mine))];
  if (c.mine >= minOverlap && c.mine > c.theirs) return ['you', round2(Math.min(1, c.mine - c.theirs))];
  if (c.theirs >= minOverlap || c.mine >= minOverlap) return ['unknown', 0]; // dead heat
  const low = minOverlap * LOW;
  if (c.theirs >= low || c.mine >= low) return ['unknown', 0];
  // Nobody we can see or hear up close said this. Only call it if we could actually see.
  if (c.face < MIN_FACE || c.dur > MAX_CROWD_MS) return ['unknown', 0];
  return ['crowd', round2((1 - Math.max(c.theirs, c.mine)) * c.face)];
}

export function labelTurns(turns, cues, { minOverlap = 0.5 } = {}) {
  const spanList = spans(cues);
  return (Array.isArray(turns) ? turns : []).map(turn => {
    const [source, confidence] = judge(turn, spanList, minOverlap);
    return { ...turn, source, confidence };
  });
}

// Which diarizer letter is the user? Each letter leans the way most of its labelled lines went.
export function inferLabels(turns, { minTurns = 3, minAgreement = 0.7 } = {}) {
  const tally = new Map(); // letter -> { you, them }
  let n = 0;
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !t.speaker || t.speaker === 'unknown' || (t.source !== 'you' && t.source !== 'them')) continue;
    const row = tally.get(t.speaker) ?? { you: 0, them: 0 };
    row[t.source]++;
    tally.set(t.speaker, row);
    n++;
  }
  if (n < minTurns) return null;
  let agree = 0;
  const you = [];
  const them = [];
  for (const [letter, row] of tally) {
    agree += Math.max(row.you, row.them);
    if (row.you > row.them) you.push([letter, row.you]);
    else if (row.them > row.you) them.push([letter, row.them]);
  }
  const agreement = round2(agree / n);
  if (agreement < minAgreement || you.length !== 1) return null;
  const biggest = xs => xs.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { userLabel: you[0][0], otherLabel: biggest(them), agreement, n };
}

// A Muse session that had to be reopened mid-recording hands out fresh letters, so its labels
// arrive suffixed (A#2). Each later letter leans the way the camera said its lines went and is
// mapped onto the first session's letter for that side; with no camera evidence the suffix is
// just dropped and we trust the diarizer to have kept the same order.
const SESSION = /#\d+$/;

function lean(turns) {
  const tally = new Map();
  for (const t of turns) {
    if (!t.speaker || t.speaker === 'unknown' || (t.source !== 'you' && t.source !== 'them')) continue;
    const row = tally.get(t.speaker) ?? { you: 0, them: 0 };
    row[t.source]++;
    tally.set(t.speaker, row);
  }
  const side = new Map();
  for (const [letter, row] of tally) side.set(letter, row.you > row.them ? 'you' : row.them > row.you ? 'them' : null);
  return side;
}

export function mergeSessions(turns) {
  const xs = Array.isArray(turns) ? turns : [];
  if (!xs.some(t => SESSION.test(t.speaker ?? ''))) return xs;
  const first = lean(xs.filter(t => !SESSION.test(t.speaker ?? '')));
  const letterFor = want => [...first].find(([, s]) => s === want)?.[0] ?? null;
  const home = { you: letterFor('you'), them: letterFor('them') };
  const later = lean(xs.filter(t => SESSION.test(t.speaker ?? '')));
  return xs.map(t => {
    if (!SESSION.test(t.speaker ?? '')) return t;
    const side = later.get(t.speaker);
    const target = side ? home[side] : null;
    return { ...t, speaker: target ?? t.speaker.replace(SESSION, '') };
  });
}

// The lines worth analysing: everything that isn't background.
export function speechTurns(turns) {
  return (Array.isArray(turns) ? turns : []).filter(t => t && t.source !== 'crowd');
}
