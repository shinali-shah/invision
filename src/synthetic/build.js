// Builds the SYNTHETIC demo account from conversations.js: thirteen conversations with Prat, Priya and
// Parth, Oct 12-24 2026. Each transcript goes through the real pipeline (rules, NLP hooks and awkward
// flags, face alignment, insight) with the offline mock agents standing in for Muse Spark, so signals,
// colours, notes, follow-ups and takeaways are measured, not written. Only the "try instead" rewrites
// of the three featured conversations are hand-written. Deterministic: one mulberry32 seed, fixed
// dates, fixed ids, a fixed clock. No video and no face-overlay files; the per-turn face cues live
// in each conversation's `behavior`.

import { createLlm } from '../llm.js';
import { createLogger } from '../log.js';
import defaultResponders from '../mock/responders.js';
import { processConversation, refreshMemory } from '../pipeline.js';
import { alignBehavior, cleanFrames } from '../behavior/align.js';
import { generateInsight } from '../agents/insight.js';
import { DEMO_CONVERSATIONS } from './conversations.js';

export const SEED = 20261012;
const MIN = 60000;
const FPS = 5;
const STEP_MS = 1000 / FPS;
const MODEL = 'mediapipe-face-landmarker@0.10.14 (synthetic)';
// Built "the morning after" the last conversation, so the data never depends on when you run it.
export const BUILT_AT = new Date(2026, 9, 25, 8, 0).getTime();

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A uuid-shaped id from the seeded stream, so rebuilds give the same ids.
function seededId(rand) {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

const words = text => text.trim().split(/\s+/).filter(Boolean).length;
const r3 = n => Math.round(n * 1000) / 1000;
const r1 = n => Math.round(n * 10) / 10;
const startOf = spec => {
  const [y, m, d] = spec.date;
  const [h, mi] = spec.at.split(':').map(Number);
  return new Date(y, m, d, h, mi).getTime();
};

// About 2.6 words a second with natural gaps; an overlap starts the line before the last one ended.
export function toTurns(lines, rand) {
  let end = 0;
  return lines.map(([speaker, text, opts = {}], i) => {
    const ms = Math.round(words(text) * 380 + 500 + rand() * 400);
    const start = i === 0 ? 0 : opts.overlap ? end - opts.overlap : end + Math.round(350 + rand() * 450);
    end = start + ms;
    return { turnId: i + 1, speaker, text, startMs: start, endMs: end };
  });
}

// How the teammate's face moves for each kind of conversation: resting smile, how much it lifts after
// the user's lines, nods per long answer, and how far they look away after a line that cooled.
const TONE = {
  good: { baseline: 0.24, lift: 0.1, nods: 2, away: 0 },
  bumps: { baseline: 0.19, lift: 0.05, nods: 1, away: 0.35 },
  rough: { baseline: 0.14, lift: 0.02, nods: 0, away: 0.55 },
};

// MediaPipe-shaped frames for the teammate's face at 5 fps. Every value moves smoothly (a slow random
// walk, no single-frame spikes) and stays in the ranges real footage gives: smile 0.05-0.6, yaw and
// pitch a few degrees, nods 12-15° down and back within 0.6 s, look-aways past the 25° facing cut-off.
export function synthFrames(turns, userLabel, spec, rand) {
  const tone = TONE[spec.mood];
  const cool = new Set(spec.cool ?? []);
  const lastMs = turns.at(-1).endMs + 3000;
  const target = new Map();
  const away = new Map();
  const nodAt = [];

  for (const turn of turns) {
    if (turn.speaker === userLabel) {
      // the 2.5 s after the user's line is what the reaction is measured on
      const lift = cool.has(turn.turnId) ? -0.07 : tone.lift;
      for (let t = turn.endMs; t < turn.endMs + 2500; t += STEP_MS) target.set(Math.round(t / STEP_MS), lift);
      if (cool.has(turn.turnId) && tone.away) {
        const span = 2500 * tone.away;
        for (let t = turn.endMs + (2500 - span) / 2; t < turn.endMs + (2500 + span) / 2; t += STEP_MS) away.set(Math.round(t / STEP_MS), true);
      }
    } else if (words(turn.text) >= 14) {
      for (let n = 0; n < tone.nods; n++) nodAt.push(turn.startMs + ((n + 1) / (tone.nods + 1)) * (turn.endMs - turn.startMs));
    }
  }

  const frames = [];
  let smile = tone.baseline;
  let yaw = 0;
  let pitch = 0;
  for (let i = 0, t = 0; t <= lastMs; i++, t += STEP_MS) {
    const talking = turns.some(x => x.speaker !== userLabel && t >= x.startMs && t < x.endMs);
    const goal = tone.baseline + (target.get(i) ?? 0) + (talking ? 0.03 : 0);
    // ease toward the goal, with a small drift; no frame jumps more than a few points
    smile += (goal - smile) * 0.35 + (rand() - 0.5) * 0.012;
    yaw += ((away.get(i) ? 33 : 0) - yaw) * 0.5 + (rand() - 0.5) * 0.8;
    const nod = nodAt.find(n => Math.abs(t - n) <= 300);
    const dip = nod != null ? -14 * Math.cos(((t - nod) / 300) * (Math.PI / 2)) : 0;
    pitch += (dip - pitch) * 0.8 + (rand() - 0.5) * 0.5;
    frames.push({
      t: Math.round(t),
      face: true,
      smile: r3(Math.min(0.6, Math.max(0.05, smile))),
      yaw: r1(yaw),
      pitch: r1(pitch),
      jawOpen: r3(talking ? 0.22 + 0.08 * Math.sin(i / 2) : 0.03),
      browUp: r3(0.1 + (talking ? 0.04 : 0)),
    });
  }
  return frames;
}

const MOOD = score => (score < 30 ? 'good' : score < 70 ? 'bumps' : 'rough');

// The offline mock agents, except that the featured conversations get their hand-written rewrites.
function respondersFor(spec) {
  return {
    ...defaultResponders,
    insight: payload => ({ ...defaultResponders.insight(payload), ...(spec.rewrites ? { rewrites: spec.rewrites } : {}) }),
  };
}

// The pipeline stamps rows and logs with new Date(); a fixed clock makes every timestamp, and so the
// whole database, the same on every run.
function createClock() {
  const Real = globalThis.Date;
  let now = 0;
  class FixedDate extends Real {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  return {
    set(ms) { now = ms; },
    advance(ms) { now += ms; },
    install() { globalThis.Date = FixedDate; },
    restore() { globalThis.Date = Real; },
  };
}

/**
 * Fills `store` with the thirteen demo conversations. Returns the plan (key, id, date, person, mood)
 * and `problems`: anything that came out differently from what the scenario says (a colour, a
 * rejected rewrite, an agent that fell back).
 */
export async function buildDemo({ store, seed = SEED, quiet = true }) {
  const rand = mulberry32(seed);
  const clock = createClock();
  const log = createLogger(store, { quiet });
  const problems = [];
  const built = [];
  // Marked up front: a server that opens the database mid-build must not add its sample calls.
  store.setKv('dataset', { name: 'synthetic', building: true });

  clock.install();
  try {
    for (const [index, spec] of DEMO_CONVERSATIONS.entries()) {
      const start = startOf(spec);
      clock.set(start);
      const llm = createLlm({ mock: true, responders: respondersFor(spec) });

      const convo = store.createConversation({ id: seededId(rand), tag: 'friend', otherName: spec.otherName, synthetic: true });
      const turns = toTurns(spec.lines, rand);
      const durMs = turns.at(-1).endMs;
      clock.advance(durMs + 4000);
      store.updateConversation(convo.id, { turns, userLabel: 'A' });
      log('transcribe', 'info', `${turns.length} turns, speakers A/B; audio discarded (synthetic)`);

      clock.advance(45000);
      let done = await processConversation({ store, llm, log, id: convo.id, reflection: spec.reflection });
      const score = done.hooks.awkward.score;
      if (MOOD(score) !== spec.mood) problems.push(`${spec.key}: meant to be ${spec.mood} but scored ${score} (${done.hooks.awkward.flags.map(f => `${f.who} ${f.kind}`).join(', ') || 'no flags'})`);
      if (done.note?.status !== 'shown') problems.push(`${spec.key}: note ${done.note?.status} (${done.note?.reason})`);
      if (done.followUp?.source !== 'muse-spark') problems.push(`${spec.key}: follow-up came from the ${done.followUp?.source}`);

      // Face cues from the scenario's tone; no video file, no frames file.
      clock.advance(2 * MIN);
      const frames = cleanFrames(synthFrames(turns, 'A', spec, rand));
      const behavior = alignBehavior({ model: MODEL, fps: FPS, frames, turns: done.turns, userLabel: 'A', signals: done.signals, hooks: done.hooks });
      log('vision', 'info', `face cues aligned: ${behavior.frameCount} frames, face in ${Math.round(behavior.faceSeenPct * 100)}% (synthetic)`, behavior.stats);
      done = store.updateConversation(convo.id, { behavior });

      clock.advance(30000);
      const insight = await generateInsight({ llm, note: done.note, behavior, hooks: done.hooks, signals: done.signals, turns: done.turns, userLabel: 'A' });
      const kept = new Set(insight.rewrites.map(r => r.turnId));
      for (const r of spec.rewrites ?? []) if (!kept.has(r.turnId)) problems.push(`${spec.key}: rewrite for turn ${r.turnId} was rejected`);
      done = store.updateConversation(convo.id, { insight });

      // The last two days' messages are still drafts (they show in Pending tasks); the rest were sent.
      const draft = index >= DEMO_CONVERSATIONS.length - 2;
      if (!draft) {
        clock.set(start + durMs + (20 + index * 7) * MIN);
        done = store.updateConversation(convo.id, { followUp: { ...done.followUp, status: 'sent', sentAt: new Date().toISOString() } });
        log('followUp', 'info', `sent to ${spec.otherName}`);
      }
      built.push({ key: spec.key, id: convo.id, createdAt: done.createdAt, otherName: spec.otherName, mood: spec.mood, score, outlier: spec.outlier });
    }
    clock.set(BUILT_AT);
    await refreshMemory({ store, llm: createLlm({ mock: true }), log });
  } finally {
    clock.restore();
  }
  store.setKv('dataset', { name: 'synthetic', label: 'SYNTHETIC DEMO DATA', seed, builtAt: new Date(BUILT_AT).toISOString(), conversations: built.length });
  return { built, problems };
}

// Everything the API serves, as one JSON document (used for the committed snapshot and the
// "same seed, same data" test).
export function exportSnapshot(store) {
  return {
    dataset: store.getKv('dataset'),
    pattern: store.getKv('pattern'),
    nextSteps: store.listNextSteps(),
    conversations: store.listConversations(),
    logs: store.listLogs(1000).reverse(),
  };
}
