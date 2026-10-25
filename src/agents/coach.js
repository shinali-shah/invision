import { TAG_FOCUS } from './context.js';

const SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    suggestion: { type: 'string' },
    citedTurnIds: { type: 'array', items: { type: 'integer' } },
  },
  required: ['text', 'suggestion', 'citedTurnIds'],
  additionalProperties: false,
};

const EXAMPLE =
  'You asked three questions and two were follow-ups. Your grandmother told two stories after your follow-ups. ' +
  'Next call, try asking about the place she mentioned.';

function systemPrompt(tag) {
  return [
    'You are a conversation coach. You write one short note to the user about how they listened in a conversation they just had.',
    '',
    'Rules:',
    '- Write to the user in second person ("you").',
    '- `text` plus `suggestion` together are at most 3 sentences. `text` is 1-2 sentences describing what the user did; `suggestion` is exactly 1 sentence with one concrete thing to try next time.',
    '- Only cite numbers that appear in `signals`. Never invent counts, percentages or durations.',
    '- Coach the user\'s behavior only. The other person\'s replies are context (how long they answered, whether they told a story after a question). Never judge, score or label the other person, and never say the user is good or bad at conversation.',
    '- Make the suggestion specific to something that actually came up in the transcript, not generic advice.',
    `- This is a ${tag} conversation. Focus on: ${TAG_FOCUS[tag]}.`,
    '- If `lastNotes` is not empty, do not repeat their observations or suggestions; find something new.',
    '- If the user wrote a `reflection`, take it into account.',
    '- `citedTurnIds` lists the turnIds your note refers to.',
    '',
    'In `turns`, speaker "you" is the user and "them" is the other person.',
    '',
    `Example of the right tone and length (family): "${EXAMPLE}"`,
  ].join('\n');
}

const failed = () => ({ text: null, suggestion: null, citedTurnIds: [], status: 'dropped', reason: 'coach_failed', source: 'fallback' });

export async function generateNote({ llm, tag, signals, turns, userLabel, reflection, lastNotes = [] }) {
  const user = {
    tag,
    signals,
    reflection: reflection || null,
    // older callers hand us whole Note objects, newer ones just the text
    lastNotes: (lastNotes ?? []).map(n => (typeof n === 'string' ? n : [n?.text, n?.suggestion].filter(Boolean).join(' '))).filter(Boolean),
    turns: turns.map(t => ({ turnId: t.turnId, speaker: t.speaker === userLabel ? 'you' : 'them', text: t.text })),
  };

  let out;
  try {
    out = await llm.json({ name: 'coach', schema: SCHEMA, system: systemPrompt(tag), user, effort: 'medium' });
  } catch {
    return failed();
  }
  if (typeof out?.text !== 'string' || !out.text.trim()) return failed();

  const known = new Set(turns.map(t => t.turnId));
  return {
    text: out.text.trim(),
    suggestion: typeof out.suggestion === 'string' && out.suggestion.trim() ? out.suggestion.trim() : null,
    citedTurnIds: (out.citedTurnIds ?? []).filter(id => known.has(id)),
    status: 'shown',
    source: 'muse-spark',
  };
}
