import { contentWords } from '../nlp/text.js';

// Muse Spark reads the aligned cues next to the transcript and the note, and says which moments
// mattered and whether the note's advice is backed by what happened on camera. It only gets
// numbers we computed, and anything it claims has to point at a real turn.

const SCHEMA = {
  type: 'object',
  properties: {
    moments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turnId: { type: 'integer' },
          title: { type: 'string' },
          observation: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['turnId', 'title', 'observation', 'why'],
        additionalProperties: false,
      },
    },
    adviceCheck: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          advice: { type: 'string' },
          verdict: { type: 'string', enum: ['backed', 'partly', 'not yet'] },
          evidenceTurnIds: { type: 'array', items: { type: 'integer' } },
          reason: { type: 'string' },
        },
        required: ['advice', 'verdict', 'evidenceTurnIds', 'reason'],
        additionalProperties: false,
      },
    },
    rewrites: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turnId: { type: 'integer' },
          title: { type: 'string' },
          tryInstead: { type: 'string' },
          because: { type: 'string' },
        },
        required: ['turnId', 'title', 'tryInstead', 'because'],
        additionalProperties: false,
      },
    },
  },
  required: ['moments', 'adviceCheck', 'rewrites'],
  additionalProperties: false,
};

const SYSTEM = [
  'You help the user learn from a conversation they recorded with video. You get the transcript, the coaching note they were given,',
  'hooks found in the text (topics, missed bids, promises), and face cues measured by a pretrained model for the other person:',
  'smile (0-1), facing the camera, nods, and for each of the user\'s lines the other person\'s reaction in the 2.5 seconds after it',
  '(smileDelta is relative to their own baseline).',
  '',
  'Return:',
  '- moments: 2 to 4 turns worth replaying. title is 2-5 words. observation states what was said and what the cues did, with the numbers.',
  '  why says what the user can learn from it, in one sentence, second person.',
  '- adviceCheck: one row per piece of advice in the note (its suggestion, and any advice in its text). verdict is "backed" if the cues',
  '  support it (e.g. reactions after follow-ups were warmer than after other lines), "partly" if mixed, "not yet" if the video gives no support.',
  '  evidenceTurnIds are the turns that show it. reason is one sentence with the numbers.',
  '- rewrites: for each turnId in `rewriteCandidates` worth fixing (most important first, at most 3), the line the user could have said',
  '  instead. tryInstead is something a person would actually say out loud, under 20 words, usually a question, and it must pick up a',
  '  specific word or detail from what the other person had just said (`theySaid`). title is 2-5 words naming the habit',
  '  ("Stay with their story"). because is one sentence, second person, why this would have worked better.',
  '',
  'Face cues are null when there was no video; then talk only about the words.',
  '',
  'Rules:',
  '- Cues are observable behaviour only. Never say or imply what the other person felt, meant, or whether they were sincere, bored, fake or',
  '  lying. Say "smiled", "looked away", "nodded", not "was happy" or "lost interest".',
  '- Only use numbers present in the input. Only use turnIds present in turns.',
  '- Coach the user, never grade the other person.',
  '- Write like a person, not a log: never use field names (smileDelta, facingPct, congruence). Say "their smile rose 33 points",',
  '  "they faced you only 23% of the time", "they nodded twice". Keep each observation under 30 words.',
].join('\n');

const FIELD_NAMES = /\b(smileDelta|facingPct|smilePeak|congruence|textTone)\b/;
const BANNED = /\b(fake|faking|lying|lied|liar|genuine|genuinely|insincere|sincere|pretend\w*|bored|annoyed|uninterested|disinterested|didn['’]t care|lost interest|was happy|was sad|they felt|she felt|he felt)\b/i;

const pct = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
const signed = v => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}`);

// No model: pick the moments the numbers point at, and check the advice against the follow-up stats.
export function fallbackInsight({ note, behavior, hooks, turns }) {
  const rows = behavior?.turns ?? [];
  const text = new Map((turns ?? []).map(t => [t.turnId, t.text]));
  const moments = [];
  const add = (turnId, title, observation, why) => {
    if (turnId != null && !moments.some(m => m.turnId === turnId)) moments.push({ turnId, title, observation, why });
  };

  const best = rows.filter(r => r.reaction).sort((a, b) => b.reaction.smileDelta - a.reaction.smileDelta)[0];
  if (best && best.reaction.smileDelta > 0) {
    add(best.turnId, 'What landed', `After you said “${text.get(best.turnId) ?? ''}”, their smile went ${signed(best.reaction.smileDelta)} points over their baseline.`,
      'Do more of what you did here.');
  }
  for (const b of hooks?.missedBids ?? []) {
    const reply = rows.find(r => r.turnId === b.replyTurnId);
    add(b.turnId, 'A thread left hanging', `They talked about ${b.cue || 'something personal'} and your next line moved on${reply?.reaction ? ` (smile ${signed(reply.reaction.smileDelta)} after it)` : ''}.`,
      'Next time ask one question about it before changing topic.');
  }
  const mixed = rows.find(r => r.congruence === 'mixed');
  if (mixed) {
    add(mixed.turnId, 'Words and face apart', `The words were upbeat but the face cues stayed near baseline (smile ${pct(mixed.smile)}).`,
      'Worth a gentle follow-up rather than assuming it went well.');
  }

  const s = behavior?.stats;
  const advice = [note?.suggestion].filter(Boolean);
  const adviceCheck = advice.map(a => {
    const fu = s?.afterFollowUps;
    const other = s?.afterOther;
    if (!fu?.n || fu.smileDelta == null) {
      return { advice: a, verdict: 'not yet', evidenceTurnIds: [], reason: 'No follow-up questions with a visible face to compare yet.' };
    }
    const gap = other?.n && other.smileDelta != null ? fu.smileDelta - other.smileDelta : fu.smileDelta;
    const ids = rows.filter(r => r.speaker === 'you' && r.reaction).slice(0, 3).map(r => r.turnId);
    return {
      advice: a,
      verdict: gap > 0.03 ? 'backed' : gap > -0.03 ? 'partly' : 'not yet',
      evidenceTurnIds: ids,
      reason: `After your follow-ups their smile moved ${signed(fu.smileDelta)} (n=${fu.n}) vs ${signed(other?.smileDelta)} after other lines (n=${other?.n ?? 0}).`,
    };
  });

  return { moments: moments.slice(0, 4), adviceCheck, source: 'fallback' };
}

// Your lines that are worth rewriting: replies to a missed bid first, then lines they visibly cooled after.
export function rewriteCandidates({ turns, userLabel, hooks, behavior }) {
  const ts = turns ?? [];
  const cues = new Map((behavior?.turns ?? []).map(r => [r.turnId, r]));
  const out = [];
  const add = (reply, reason) => {
    if (!reply || reply.speaker !== userLabel || out.some(c => c.turnId === reply.turnId)) return;
    const i = ts.indexOf(reply);
    const before = ts.slice(0, i).reverse().find(t => t.speaker !== userLabel);
    if (!before) return;
    out.push({ turnId: reply.turnId, said: reply.text, theySaid: before.text, theirTurnId: before.turnId, reason });
  };
  for (const b of hooks?.missedBids ?? []) add(ts.find(t => t.turnId === b.replyTurnId), 'missed');
  for (const t of ts) {
    const r = cues.get(t.turnId)?.reaction;
    if (r && (r.smileDelta <= -0.05 || (r.facingPct != null && r.facingPct < 0.6))) add(t, 'cooled');
  }
  return out;
}

const seconds = v => `${Math.round(v * 10) / 10} s`;

// The numbers behind a takeaway, written by us rather than the model.
function evidenceFor(turnId, behavior) {
  const r = behavior?.turns?.find(x => x.turnId === turnId)?.reaction;
  if (!r) return null;
  const bits = [`Smile ${signed(r.smileDelta)}`];
  if (r.facingPct != null && r.facingPct < 0.8) bits.push(`looked away ${seconds((1 - r.facingPct) * 2.5)}`);
  if (r.nods) bits.push(`${r.nods} nod${r.nods === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

const quote = s => `“${String(s).trim().replace(/^[“"]|[”"]$/g, '')}”`;

export function buildTakeaways({ rewrites, candidates, moments, hooks, signals, behavior, turns }) {
  const text = new Map((turns ?? []).map(t => [t.turnId, t.text]));
  const takeaways = [];

  const r = rewrites[0];
  if (r) {
    const c = candidates.find(x => x.turnId === r.turnId);
    takeaways.push({
      kind: 'try', turnId: r.turnId, title: r.title, text: r.because,
      said: c?.said ?? text.get(r.turnId) ?? null, theySaid: c?.theySaid ?? null, tryInstead: r.tryInstead,
      evidence: evidenceFor(r.turnId, behavior) ?? (c?.reason === 'missed' ? 'They had just shared something personal' : null),
    });
  }

  // What worked: the follow-up that got the warmest reaction, or any follow-up when there's no video.
  const followUps = new Set((signals?.questions ?? []).filter(q => q.isFollowUp).map(q => q.turnId));
  for (const d of hooks?.followUpDetector ?? []) if (d.isFollowUp && !(signals?.questions ?? []).length) followUps.add(d.turnId);
  const warmth = id => behavior?.turns?.find(x => x.turnId === id)?.reaction?.smileDelta ?? null;
  const keep = [...followUps].sort((a, b) => (warmth(b) ?? 0) - (warmth(a) ?? 0))[0];
  if (keep != null && (warmth(keep) == null || warmth(keep) > 0)) {
    const m = moments.find(x => x.turnId === keep);
    const overlap = hooks?.followUpDetector?.find(d => d.turnId === keep)?.overlap ?? [];
    takeaways.push({
      kind: 'keep', turnId: keep, title: m?.title ?? 'Keep asking follow-ups',
      text: m?.why ?? `${quote(text.get(keep) ?? '')} built on what they had just told you.`,
      said: null, theySaid: null, tryInstead: null,
      evidence: evidenceFor(keep, behavior) ?? (overlap.length ? `Built on: ${overlap.join(', ')}` : null),
    });
  }

  // Next time: something coming up for them, or a promise you made.
  const event = hooks?.events?.[0];
  const promise = hooks?.commitments?.[0];
  if (event) {
    takeaways.push({ kind: 'next', turnId: event.turnId, title: 'Ask about it next time', text: `They mentioned ${quote(event.text)} Ask how it went.`, said: null, theySaid: null, tryInstead: null, evidence: null });
  } else if (promise) {
    takeaways.push({ kind: 'next', turnId: promise.turnId, title: 'Follow through', text: `You said ${quote(promise.text)} Do it before you talk again.`, said: null, theySaid: null, tryInstead: null, evidence: null });
  }
  return takeaways.slice(0, 3);
}

// A rewrite only counts if it picks up something they actually said.
function validRewrite(r, candidates) {
  const c = candidates.find(x => x.turnId === r.turnId);
  if (!c) return false;
  const tryWords = contentWords(r.tryInstead);
  const grounded = [...contentWords(c.theySaid)].some(w => tryWords.has(w));
  return grounded && r.tryInstead.length <= 160 && !BANNED.test(`${r.tryInstead} ${r.because}`);
}

function fallbackRewrites(candidates, hooks) {
  return candidates.slice(0, 2).map(c => {
    const cue = hooks?.missedBids?.find(b => b.turnId === c.theirTurnId)?.cue
      || [...contentWords(c.theySaid)][0] || 'that';
    return { turnId: c.turnId, title: 'Stay with their story', tryInstead: `Wait, tell me more about ${cue}?`, because: 'One question about what they just said keeps the thread going before you change topic.' };
  });
}

export async function generateInsight({ llm, note, behavior, hooks, signals, turns, userLabel }) {
  const candidates = rewriteCandidates({ turns, userLabel, hooks, behavior });
  const finish = (base, rewrites) => ({ ...base, rewrites, takeaways: buildTakeaways({ rewrites, candidates, moments: base.moments, hooks, signals, behavior, turns }) });
  const fallback = () => {
    const base = fallbackInsight({ note, behavior, hooks, turns });
    return finish(base, fallbackRewrites(candidates, hooks));
  };
  const cues = new Map((behavior?.turns ?? []).map(r => [r.turnId, r]));
  let out;
  try {
    out = await llm.json({
      name: 'insight',
      schema: SCHEMA,
      system: SYSTEM,
      user: {
        note: note?.text ? { text: note.text, suggestion: note.suggestion } : null,
        hooks: { topics: hooks?.topics ?? [], missedBids: hooks?.missedBids ?? [], commitments: hooks?.commitments ?? [] },
        followUps: (signals?.questions ?? []).filter(q => q.isFollowUp).map(q => q.turnId),
        baseline: behavior?.baseline ?? null,
        stats: behavior?.stats ?? null,
        faceSeenPct: behavior?.faceSeenPct ?? null,
        rewriteCandidates: candidates.map(c => ({ turnId: c.turnId, said: c.said, theySaid: c.theySaid, why: c.reason })),
        turns: (turns ?? []).map(t => {
          const c = cues.get(t.turnId) ?? {};
          return {
            turnId: t.turnId,
            speaker: t.speaker === userLabel ? 'you' : 'them',
            text: String(t.text ?? '').slice(0, 220),
            smile: c.smile ?? null, facingPct: c.facingPct ?? null, nods: c.nods ?? null,
            reaction: c.reaction ?? null, congruence: c.congruence ?? null,
          };
        }),
      },
      effort: 'medium',
    });
  } catch {
    return fallback();
  }

  const known = new Set((turns ?? []).map(t => t.turnId));
  const clean = s => (typeof s === 'string' ? s.trim() : '');
  const moments = (out?.moments ?? [])
    .filter(m => known.has(m.turnId) && clean(m.observation) && clean(m.title))
    .map(m => ({ turnId: m.turnId, title: clean(m.title), observation: clean(m.observation), why: clean(m.why) }))
    .slice(0, 4);
  const adviceCheck = (out?.adviceCheck ?? [])
    .filter(a => clean(a.advice) && ['backed', 'partly', 'not yet'].includes(a.verdict))
    .map(a => ({ advice: clean(a.advice), verdict: a.verdict, evidenceTurnIds: (a.evidenceTurnIds ?? []).filter(id => known.has(id)), reason: clean(a.reason) }));

  const said = [...moments.flatMap(m => [m.title, m.observation, m.why]), ...adviceCheck.map(a => a.reason)].join(' ');
  if (!moments.length || BANNED.test(said) || FIELD_NAMES.test(said)) return fallback();

  const rewrites = (out?.rewrites ?? [])
    .map(r => ({ turnId: r.turnId, title: clean(r.title), tryInstead: clean(r.tryInstead), because: clean(r.because) }))
    .filter(r => r.tryInstead && r.title && validRewrite(r, candidates))
    .slice(0, 3);
  // Spark's rewrites that didn't pick up their words are swapped for plain ones, not dropped silently.
  return finish({ moments, adviceCheck, source: 'muse-spark' }, rewrites.length || !candidates.length ? rewrites : fallbackRewrites(candidates, hooks));
}
