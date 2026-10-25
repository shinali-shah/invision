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
  },
  required: ['moments', 'adviceCheck'],
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
const signed = v => (v == null ? '–' : `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`);

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

export async function generateInsight({ llm, note, behavior, hooks, signals, turns, userLabel }) {
  const fallback = () => fallbackInsight({ note, behavior, hooks, turns });
  if (!behavior) return fallback();
  const cues = new Map(behavior.turns.map(r => [r.turnId, r]));
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
        baseline: behavior.baseline,
        stats: behavior.stats,
        faceSeenPct: behavior.faceSeenPct,
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
  return { moments, adviceCheck, source: 'muse-spark' };
}
