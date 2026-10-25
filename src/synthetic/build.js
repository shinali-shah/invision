// Builds the synthetic account: every conversation in conversations.js goes through the same code a
// real recording does (lip lock, rules, hooks, coach, reviewer, follow-up, face alignment, insight,
// pattern, weekly goal), with Muse Spark's answers written by hand and face frames made up to match.
// Anything a real agent would reject falls back exactly like it would live, and `problems` says so.

import { mkdirSync, writeFileSync, rmSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createLlm } from '../llm.js';
import { createLogger } from '../log.js';
import defaultResponders from '../mock/responders.js';
import { processConversation, refreshMemory } from '../pipeline.js';
import { labelTurns, inferLabels, speechTurns } from '../transcribe/crowd.js';
import { alignBehavior, cleanFrames } from '../behavior/align.js';
import { generateInsight } from '../agents/insight.js';
import { groundedIn } from '../agents/followUp.js';
import { SYNTHETIC_CONVERSATIONS, SYNTHETIC_GOALS } from './conversations.js';

const DAY = 86400000;
const MIN = 60000;
const FPS = 5;
const STEP_MS = 1000 / FPS;
const CUE_MS = 125;
const MODEL = 'mediapipe-face-landmarker@0.10.14';
const STEP_STATUS = { accept: 'accepted', change: 'changed', dismiss: 'dismissed' };

// Small seeded PRNG so a rebuild gives the same frames, timings and file sizes.
function rng(seed) {
  let a = 0;
  for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const words = text => text.trim().split(/\s+/).filter(Boolean).length;
const r3 = n => Math.round(n * 1000) / 1000;
const r1 = n => Math.round(n * 10) / 10;

// About 2.6 words a second, with the gaps people leave between lines.
export function toTurns(lines, rand) {
  let end = 0;
  return lines.map(([speaker, text, opts = {}], i) => {
    const ms = Math.round(words(text) * 380 + 500 + rand() * 400);
    const start = i === 0 ? 0 : opts.overlap ? end - opts.overlap : end + (opts.gap ?? Math.round(350 + rand() * 450));
    end = start + ms;
    return { turnId: i + 1, speaker, text, startMs: start, endMs: end, ...(opts.crowd ? { crowd: true } : {}) };
  });
}

// What the phone's lip lock would have sent: their mouth moving on their lines, the close mic on
// yours, neither on a bystander's.
function lipCues(turns, userLabel, rand) {
  const last = turns.at(-1).endMs + 1000;
  const cues = [];
  for (let t = 0; t <= last; t += CUE_MS) {
    const at = turns.find(x => t >= x.startMs && t < x.endMs);
    const face = rand() > 0.04;
    const theirs = !!at && !at.crowd && at.speaker !== userLabel && face && rand() > 0.12;
    const mine = !!at && !at.crowd && at.speaker === userLabel && rand() > 0.08;
    cues.push({ t, face, mouth: theirs, theirs, mine });
  }
  return cues;
}

// MediaPipe-shaped frames for the other person's face. Smile sits near the baseline with noise,
// rises or falls in the 2.5 s after your lines per `reactions`, blips while they talk; nods are short
// pitch dips; `away` turns the head past the 25° facing cut-off for that share of a window.
export function synthFrames(turns, userLabel, face, offsetMs, rand) {
  const lastMs = turns.at(-1).endMs + 3000;
  const shift = new Map();
  const yaw = new Map();
  const pitch = new Map();
  const window = t => turns.find(x => t >= x.startMs && t < x.endMs);

  for (const turn of turns) {
    const mine = turn.speaker === userLabel;
    const from = mine ? turn.endMs : turn.startMs;
    const to = mine ? turn.endMs + 2500 : turn.endMs;
    const delta = mine ? face.reactions?.[turn.turnId] : null;
    const away = face.away?.[turn.turnId] ?? 0;
    for (let t = Math.ceil(from / STEP_MS) * STEP_MS; t < to; t += STEP_MS) {
      if (delta != null) shift.set(t, delta);
      // the look-away sits in the middle of the window
      const f = (t - from) / Math.max(1, to - from);
      if (away && f > (1 - away) / 2 && f < (1 + away) / 2) yaw.set(t, 34 + rand() * 8);
    }
    const nods = face.nods?.[turn.turnId] ?? 0;
    for (let n = 0; n < nods; n++) {
      const at = from + ((n + 1) / (nods + 1)) * (to - from);
      // down 12-16° and back over ~0.6 s
      const depth = 12 + rand() * 4;
      [[-200, 0.5], [0, 1], [200, 0.55]].forEach(([d, k]) => pitch.set(Math.round((at + d) / STEP_MS) * STEP_MS, -depth * k));
    }
  }

  const frames = [];
  for (let videoMs = 0; videoMs <= lastMs + offsetMs; videoMs += STEP_MS) {
    const t = Math.round(videoMs - offsetMs);
    const at = window(t);
    const talking = !!at && at.speaker !== userLabel && !at.crowd;
    if (rand() < 0.035) {
      frames.push({ t, face: false, smile: 0, yaw: 0, pitch: 0, jawOpen: 0, browUp: 0 });
      continue;
    }
    const grid = Math.round(t / STEP_MS) * STEP_MS;
    let smile = face.baseline + (shift.get(grid) ?? 0) + (rand() - 0.5) * 0.05;
    if (talking && rand() < 0.15) smile += 0.12;
    frames.push({
      t,
      face: true,
      smile: r3(Math.min(1, Math.max(0, smile))),
      yaw: r1(yaw.get(grid) ?? (rand() - 0.5) * 10),
      pitch: r1(pitch.get(grid) ?? (rand() - 0.5) * 4),
      jawOpen: r3(talking ? 0.15 + rand() * 0.35 : rand() * 0.06),
      browUp: r3(0.05 + rand() * 0.1 + (talking && rand() < 0.2 ? 0.2 : 0)),
    });
  }
  return frames;
}

// Muse Spark's side of each agent call, written for this conversation; the rest use the offline mocks.
function respondersFor(spec, goals) {
  const pct = v => Math.abs(Math.round(v * 100));
  const plural = (n, one) => `${n === 2 ? 'twice' : `${n} ${one}${n === 1 ? '' : 's'}`}`;
  return {
    ...defaultResponders,
    classify: ({ questions }) => ({
      questions: (questions ?? []).map(turnId => ({
        turnId, isFollowUp: spec.classify.followUps.includes(turnId), storyShared: spec.classify.stories.includes(turnId),
      })),
      reflections: spec.classify.reflections,
    }),
    coach: ({ signals }) => spec.coach(signals),
    review: ({ note }) => ({ verdict: 'pass', text: note.text, suggestion: note.suggestion }),
    followUp: () => ({ text: spec.followUp.text, hooksUsed: [] }),
    nextStep: payload => (goals.length ? { goal: goals.shift() } : defaultResponders.nextStep(payload)),
    insight: payload => {
      const flagged = new Set((payload.awkward ?? []).filter(f => f.who === 'you').map(f => f.turnId));
      const turns = payload.turns ?? [];
      const moments = Object.entries(spec.insight.moments).map(([id, m]) => {
        const turn = turns.find(t => t.turnId === Number(id));
        if (!turn) return null;
        let observation = m.obs;
        const r = turn.reaction;
        if (observation) {
          // written for this moment (no video to measure)
        } else if (turn.speaker === 'you' && r) {
          const short = turn.text.length > 60 ? `${turn.text.slice(0, 57).replace(/\s+\S*$/, '')}…` : turn.text;
          const moved = r.smileDelta >= 0 ? `their smile rose ${pct(r.smileDelta)} points` : `their smile dropped ${pct(r.smileDelta)} points`;
          const extra = r.facingPct != null && r.facingPct < 0.7 ? ` and they faced you ${pct(r.facingPct)}% of the time` : r.nods ? ` and they nodded ${plural(r.nods, 'time')}` : '';
          observation = `After “${short}”, ${moved}${extra}.`;
          if (flagged.has(turn.turnId) && r.smileDelta > 0) observation += ' It came right after a flagged line, so it is not a sign it went well.';
        } else if (turn.speaker === 'them') {
          const n = turn.text.split(/\s+/).length;
          observation = `They answered in ${n} words${turn.nods ? ` and nodded ${plural(turn.nods, 'time')}` : ''}${turn.facingPct != null ? `, facing you ${pct(turn.facingPct)}% of the time` : ''}.`;
        } else {
          observation = `“${turn.text.slice(0, 80)}”`;
        }
        return { turnId: turn.turnId, title: m.title, observation, why: m.why };
      }).filter(Boolean);
      // No video: talk about the words only, and still say something about each candidate line.
      if (!moments.length) {
        for (const c of payload.rewriteCandidates ?? []) {
          moments.push({ turnId: c.turnId, title: 'A thread left hanging', observation: `They had just said “${c.theySaid.slice(0, 70)}…” and your next line moved on.`, why: 'One question about it first keeps the thread going.' });
        }
        const fu = payload.followUps?.[0];
        if (fu != null) moments.push({ turnId: fu, title: 'Building on their words', observation: `“${turns.find(t => t.turnId === fu)?.text ?? ''}” picked up what they had just said.`, why: 'Questions like this one are why the stories came out.' });
      }
      const fu = payload.stats?.afterFollowUps;
      const other = payload.stats?.afterOther;
      const backed = fu?.n && fu.smileDelta != null && (other?.smileDelta == null || fu.smileDelta > other.smileDelta + 0.03);
      const adviceCheck = payload.note?.suggestion ? [{
        advice: payload.note.suggestion,
        verdict: !fu?.n ? 'not yet' : backed ? 'backed' : 'partly',
        evidenceTurnIds: payload.followUps.slice(0, 3),
        reason: fu?.n
          ? `Their smile moved ${Math.round(fu.smileDelta * 100)} points after your ${fu.n} follow-ups vs ${other?.n ? `${Math.round((other.smileDelta ?? 0) * 100)} after your other ${other.n} lines` : 'no other lines on camera'}.`
          : 'There was no video, so only the words back it up.',
      }] : [];
      return { moments, adviceCheck, rewrites: spec.insight.rewrites };
    },
  };
}

// The pipeline stamps rows and logs with new Date(); running each step "at" its moment in the past
// makes every timestamp line up with the conversation it belongs to.
function createClock() {
  const Real = globalThis.Date;
  let now = null;
  class SyntheticDate extends Real {
    constructor(...args) { super(...(args.length ? args : [now ?? Real.now()])); }
    static now() { return now ?? Real.now(); }
  }
  return {
    set(ms) { now = ms; },
    advance(ms) { now += ms; },
    get: () => now,
    install() { globalThis.Date = SyntheticDate; },
    restore() { globalThis.Date = Real; now = null; },
  };
}

function ffmpegAvailable() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  'C\\:/Windows/Fonts/arial.ttf',
];

// A stand-in clip: dark card, who and when, and the line being said as a caption. Captions go through
// textfile= so nothing in the transcript needs escaping for the filter graph.
function renderVideo({ file, spec, turns, offsetMs, when }) {
  const font = FONT_CANDIDATES.find(f => { try { return statSync(f.replace('C\\:', 'C:')).isFile(); } catch { return false; } });
  const dir = mkdtempSync(join(tmpdir(), 'playback-synth-'));
  const durS = (turns.at(-1).endMs + 3000 + offsetMs) / 1000;
  const fontArg = font ? `fontfile='${font}':` : '';
  const filters = [];
  const write = (name, text) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p.replace(/\\/g, '/').replace(/:/g, '\\:');
  };
  filters.push(`drawtext=${fontArg}textfile='${write('title.txt', `${spec.otherName}  ·  ${when}`)}':fontcolor=0xE8ECEF:fontsize=22:x=24:y=20`);
  filters.push(`drawtext=${fontArg}textfile='${write('tag.txt', 'Synthetic recording')}':fontcolor=0x8A96A3:fontsize=16:x=24:y=52`);
  turns.forEach((t, i) => {
    const who = t.crowd ? 'Background' : t.speaker === spec.userLabel ? 'You' : spec.otherName.split(' ')[0];
    const text = t.text.length > 64 ? wrap(t.text, 64) : t.text;
    const p = write(`l${i}.txt`, `${who}: ${text}`);
    const a = (t.startMs + offsetMs) / 1000;
    const b = (t.endMs + offsetMs) / 1000;
    filters.push(`drawtext=${fontArg}textfile='${p}':fontcolor=white:fontsize=18:line_spacing=6:x=24:y=h-150:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`);
  });
  const webm = file.endsWith('.webm');
  const args = [
    '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x1F2933:s=640x360:r=10:d=${durS.toFixed(2)}`,
    '-vf', filters.join(','),
    ...(webm ? ['-c:v', 'libvpx', '-b:v', '200k'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']),
    file,
  ];
  const run = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  if (run.status !== 0) throw new Error(`ffmpeg failed for ${spec.key}: ${run.stderr?.slice(0, 300)}`);
  return statSync(file).size;
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > width) { out.push(line); line = w; } else line = `${line} ${w}`.trim();
  }
  if (line) out.push(line);
  return out.join('\n');
}

const at = (anchor, daysAgo, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(anchor - daysAgo * DAY);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const fmtWhen = ms => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Fills `store` with the synthetic account. `recordingsDir` gets the face frames, lip-lock cues and
 * (when ffmpeg is there and `videos` is on) a stand-in video for each recorded conversation.
 * Returns what was built and any place a real agent would have fallen back.
 */
export async function buildSynthetic({ store, recordingsDir, now = Date.now(), videos = true, quiet = true }) {
  const clock = createClock();
  const log = createLogger(store, { quiet });
  const goals = SYNTHETIC_GOALS.map(g => g.text);
  const steps = [];
  const problems = [];
  const built = [];
  const canRender = videos && recordingsDir && ffmpegAvailable();
  if (videos && recordingsDir && !canRender) problems.push('ffmpeg not found: recordings have metadata and face cues but no video file to play');
  if (recordingsDir) mkdirSync(recordingsDir, { recursive: true });

  clock.install();
  try {
    for (const spec of SYNTHETIC_CONVERSATIONS) {
      const rand = rng(spec.key);
      const start = at(now, spec.daysAgo, spec.at);
      clock.set(start);
      const llm = createLlm({ mock: true, responders: respondersFor(spec, goals) });

      // 1. Recording: consent, the transcript, the lip lock
      const convo = store.createConversation({ tag: spec.tag, otherName: spec.otherName });
      const raw = toTurns(spec.lines, rand);
      const cues = spec.lipLock ? lipCues(raw, spec.userLabel, rand) : [];
      const labelled = spec.lipLock
        ? labelTurns(raw.map(({ crowd, ...t }) => t), cues)
        : raw.map(({ crowd, ...t }) => t);
      const crowdIds = raw.filter(t => t.crowd).map(t => t.turnId);
      const gotCrowd = labelled.filter(t => t.source === 'crowd').map(t => t.turnId);
      if (crowdIds.join() !== gotCrowd.join()) problems.push(`${spec.key}: lip lock marked [${gotCrowd}] as background, expected [${crowdIds}]`);
      const picked = cues.length ? inferLabels(labelled) : null;
      if (picked && picked.userLabel !== spec.userLabel) problems.push(`${spec.key}: lip lock picked ${picked.userLabel} as your voice, expected ${spec.userLabel}`);
      const durMs = raw.at(-1).endMs;
      clock.advance(durMs + 4000);
      store.updateConversation(convo.id, { turns: labelled, userLabel: spec.userLabel });
      if (recordingsDir && cues.length) writeFileSync(join(recordingsDir, `${convo.id}.cues.json`), JSON.stringify(cues));
      log('transcribe', 'info', `${labelled.length} turns, speakers ${[...new Set(labelled.map(t => t.speaker))].join('/')}; audio discarded`);
      if (cues.length) {
        log('lips', 'info', `lip lock: ${cues.length} cues, ${gotCrowd.length} background line${gotCrowd.length === 1 ? '' : 's'}${picked ? `, your voice is ${picked.userLabel} (${Math.round(picked.agreement * 100)}% of ${picked.n} lines agree)` : ', could not pick your voice'}`);
      }

      // 2. Coaching: the whole analyse → coach → review → remember chain
      clock.advance(45000);
      let done = await processConversation({ store, llm, log, id: convo.id, reflection: spec.reflection });
      if (done.note?.status !== 'shown') problems.push(`${spec.key}: note ${done.note?.status} (${done.note?.reason})`);
      if (done.followUp?.source !== 'muse-spark') problems.push(`${spec.key}: follow-up fell back to the ${done.followUp?.source}`);
      const latest = store.latestNextStep();
      if (latest && !steps.some(s => s.id === latest.id)) steps.push(latest);

      // 3. Video and face cues
      let behavior = null;
      if (spec.video && spec.face) {
        clock.advance(4 * MIN);
        const ext = spec.video.mime === 'video/webm' ? 'webm' : 'mp4';
        let bytes = Math.round(durMs * 52 + rand() * 40000);
        if (canRender) bytes = renderVideo({ file: join(recordingsDir, `${convo.id}.${ext}`), spec, turns: raw, offsetMs: spec.video.offsetMs, when: fmtWhen(start) });
        const recording = { mime: spec.video.mime, ext, bytes, offsetMs: spec.video.offsetMs, uploadedAt: new Date().toISOString() };
        done = store.updateConversation(convo.id, { recording, behavior: null, insight: null });
        log('video', 'info', `saved ${(bytes / 1e6).toFixed(1)} MB recording for ${convo.id.slice(0, 8)} (stays on this Mac)`);

        clock.advance(2 * MIN);
        const frames = cleanFrames(synthFrames(raw, spec.userLabel, spec.face, spec.video.offsetMs, rand));
        behavior = alignBehavior({ model: MODEL, fps: FPS, frames, turns: speechTurns(done.turns), userLabel: done.userLabel, signals: done.signals, hooks: done.hooks });
        if (recordingsDir) writeFileSync(join(recordingsDir, `${convo.id}.frames.json`), JSON.stringify(frames));
        log('vision', 'info', `face cues aligned: ${behavior.frameCount} frames, face in ${Math.round(behavior.faceSeenPct * 100)}%`, behavior.stats);
        done = store.updateConversation(convo.id, { behavior });
      }

      // 4. Replay's takeaways and rewrites (asked for on open when there's no video)
      clock.advance(30000);
      const insight = await generateInsight({
        llm, note: done.note, behavior, hooks: done.hooks, signals: done.signals, turns: speechTurns(done.turns), userLabel: done.userLabel,
      });
      if (insight.source !== 'muse-spark') problems.push(`${spec.key}: insight fell back to the numbers`);
      const kept = new Set(insight.rewrites.map(r => r.turnId));
      for (const r of spec.insight.rewrites) if (!kept.has(r.turnId)) problems.push(`${spec.key}: rewrite for turn ${r.turnId} was rejected`);
      log('insight', insight.source === 'fallback' ? 'warn' : 'info', insight.source === 'fallback' ? 'insight from the numbers alone' : 'insight written');
      done = store.updateConversation(convo.id, { insight });

      // 5. The follow-up message: edited on the phone, sent, or still sitting as a draft
      const fu = spec.followUp;
      let followUp = done.followUp;
      if (fu.editedText) {
        clock.advance(Math.round((fu.sentAfterMin ?? 30) * MIN * 0.6));
        followUp = { ...followUp, text: fu.editedText, hooksUsed: groundedIn(fu.editedText, done.hooks), source: 'edited' };
      }
      if (fu.status === 'sent') {
        clock.set(start + durMs + (fu.sentAfterMin ?? 30) * MIN);
        followUp = { ...followUp, status: 'sent', sentAt: new Date().toISOString() };
        log('followUp', 'info', `sent to ${spec.otherName}`);
      }
      done = store.updateConversation(convo.id, { followUp });

      // 6. What the user did with the weekly goal
      for (const g of SYNTHETIC_GOALS) {
        for (const a of g.actions.filter(x => x.after === spec.key)) {
          const step = steps.find(s => s.text === g.text);
          if (!step) { problems.push(`${spec.key}: goal "${g.text.slice(0, 40)}…" was never proposed`); continue; }
          clock.advance(3 * 60 * MIN);
          const updated = store.updateNextStep(step.id, { status: STEP_STATUS[a.action], text: a.text });
          log('nextStep', 'info', `${updated.status}: ${updated.text}`);
        }
      }
      built.push({ key: spec.key, id: convo.id });
    }
    // One last pass so the pattern and goal reflect the whole history.
    clock.set(now - 30 * MIN);
    await refreshMemory({ store, llm: createLlm({ mock: true, responders: respondersFor(SYNTHETIC_CONVERSATIONS.at(-1), goals) }), log });
  } finally {
    clock.restore();
  }
  store.setKv('dataset', { name: 'synthetic', builtAt: new Date(now).toISOString(), conversations: built.length });
  return { built, problems };
}

// The rows the API serves, in one JSON document. Face frames and lip-lock cues stay in the recordings
// folder: they are rebuilt the same way every time and would make this file a megabyte.
export function exportSnapshot(store) {
  return {
    dataset: store.getKv('dataset'),
    pattern: store.getKv('pattern'),
    nextStep: store.latestNextStep(),
    nextSteps: store.listNextSteps(),
    conversations: store.listConversations(),
    logs: store.listLogs(1000).reverse(),
  };
}
