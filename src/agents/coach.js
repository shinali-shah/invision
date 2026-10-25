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
    '- `text` is 1-2 short sentences (under 40 words total) about what the user did. `suggestion` is exactly 1 sentence (under 25 words): one concrete thing to do differently in the next conversation, ideally the exact question to ask.',
    '- `suggestion` is listening advice, never a message for the user to send. The app drafts follow-up messages separately.',
    '- Only cite numbers that appear in `signals`. Never invent counts, percentages or durations.',
    '- Coach the user\'s behavior only. The other person\'s replies are context (how long they answered, whether they told a story after a question). Never judge, score or label the other person, and never say the user is good or bad at conversation.',
    '- Make the suggestion specific to something that actually came up in the transcript, not generic advice.',
    `- This is a ${tag} conversation. Focus on: ${TAG_FOCUS[tag]}.`,
    '- If `lastNotes` is not empty, do not repeat their observations or suggestions; find something new.',
    '- If the user wrote a `reflection`, take it into account.',
    '- `hooks` was measured from the transcript without a model: topics they brought up, things coming up for them, promises you made, and missedBids (turns where they shared something and your next line moved on). A missed bid is often the most useful thing to point out; quote what they said.',
    '- `awkward` lists moments flagged from the words and timing: cutting in, gossip or rumours about people who are not there, underselling yourself, and their short or hedging replies. Context beats counts: if the user gossiped or cut in, that is what the note is about, even if they also asked good questions. Never praise a line that is flagged.',
    '- `citedTurnIds` lists the turnIds your note refers to.',
    '',
    'In `turns`, speaker "you" is the user and "them" is the other person.',
    '',
    `Example of the right tone and length (family): "${EXAMPLE}"`,
  ].join('\n');
}

const failed = () => ({ text: null, suggestion: null, citedTurnIds: [], status: 'dropped', reason: 'coach_failed', source: 'fallback' });

export async function generateNote({ llm, tag, signals, turns, userLabel, reflection, hooks = null, lastNotes = [] }) {
  const user = {
    tag,
    signals,
    reflection: reflection || null,
    hooks: hooks && { topics: hooks.topics, events: hooks.events, commitments: hooks.commitments, missedBids: hooks.missedBids },
    awkward: hooks?.awkward?.flags ?? [],
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
