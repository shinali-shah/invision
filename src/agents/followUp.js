import { contentWords } from '../nlp/text.js';

const SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    hooksUsed: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'hooksUsed'],
  additionalProperties: false,
};

const VOICE = {
  family: 'warm and casual, like a text to a relative; it is fine to mix in their language if they used it',
  friend: 'casual, like a text to a friend',
  networking: 'friendly and professional, like a LinkedIn message or text after meeting someone at an event',
};

const MAX_CHARS = 320;

function systemPrompt(tag) {
  return [
    'You write the follow-up message the user sends to the person they just talked to.',
    '',
    'Rules:',
    '- Written by the user, to the other person, in first person. 1-3 short sentences, under 300 characters.',
    '- It must mention at least one thing from `hooks` by name: a topic they talked about, something coming up for them, or a promise the user made. That is the whole point: specific beats generic.',
    '- If the user made a commitment, follow through on it or say when they will.',
    '- If something is coming up for them (an interview, a trip), wish them well on it.',
    '- Only use facts from `hooks` and `turns`. Do not invent plans, links, places or details.',
    '- No emojis unless they used them. No "Great chatting!" filler as the whole message.',
    `- Tone: ${VOICE[tag] ?? VOICE.friend}.`,
    '- `hooksUsed` lists the exact hook terms or texts you referenced.',
  ].join('\n');
}

const short = text => (text.length > 40 ? `${text.slice(0, 38).replace(/\s+\S*$/, '')}…` : text);

// What the draft can be grounded in, with the label we show for each ("uses: Oaxaca · next friday").
function hookTerms(hooks) {
  return [
    ...(hooks?.topics ?? []).map(t => ({ match: t.term, label: t.term })),
    ...(hooks?.events ?? []).map(e => ({ match: e.text, label: e.when || short(e.text) })),
    ...(hooks?.commitments ?? []).map(c => ({ match: c.text, label: short(c.text) })),
  ].filter(t => t.match);
}

export function groundedIn(text, hooks) {
  const words = contentWords(text);
  return hookTerms(hooks).filter(t => [...contentWords(t.match)].some(w => words.has(w))).map(t => t.label);
}

// A draft that quotes something they said ("Pancha the goat") is specific even if it skips the hooks.
function echoesThem(text, turns, userLabel, otherName) {
  const words = contentWords(text);
  for (const n of contentWords(otherName ?? '')) words.delete(n);
  return (turns ?? []).some(t => t.speaker !== userLabel && [...contentWords(t.text)].some(w => words.has(w)));
}

const SPANISH_WHEN = /^(?:el|la|este|esta|mañana|pronto)\b/i;
export function eventLine(event) {
  const when = event?.when ? event.when.toLowerCase() : '';
  if (SPANISH_WHEN.test(when)) return `¡Hablamos ${when}!`;
  if (event?.hasNoun) return when ? `Good luck ${when}!` : 'Good luck with everything coming up!';
  return when ? `Talk ${when}!` : 'Talk soon!';
}

const firstName = name => (name && name !== 'them' ? name.trim().split(/\s+/)[0] : '');

// Used when Muse Spark is down or writes something we can't stand behind.
export function templateFollowUp({ hooks, otherName, tag }) {
  const hi = firstName(otherName) ? `Hi ${firstName(otherName)}! ` : 'Hi! ';
  const commitment = hooks?.commitments?.[0];
  const event = hooks?.events?.[0];
  const topic = hooks?.topics?.[0];
  const parts = [tag === 'family' ? 'Loved talking with you today.' : 'Really enjoyed talking with you.'];
  const used = [];

  if (topic) {
    parts.push(`I keep thinking about what you said about ${topic.term}.`);
    used.push(topic.term);
  }
  if (commitment) {
    parts.push(`Like I said: ${commitment.text.replace(/[.!?]*$/, '.')}`);
    used.push(short(commitment.text));
  }
  if (event) {
    parts.push(eventLine(event));
    used.push(event.when || short(event.text));
  }
  let text = hi + parts.join(' ');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1).replace(/\s+\S*$/, '')}…`;
  return { text, hooksUsed: used, source: 'template' };
}

export async function draftFollowUp({ llm, tag, otherName, hooks, turns, userLabel }) {
  const fallback = () => templateFollowUp({ hooks, otherName, tag });
  let out;
  try {
    out = await llm.json({
      name: 'followUp',
      schema: SCHEMA,
      system: systemPrompt(tag),
      user: {
        tag,
        otherName: otherName && otherName !== 'them' ? otherName : null,
        hooks: { topics: hooks?.topics ?? [], events: hooks?.events ?? [], commitments: hooks?.commitments ?? [] },
        turns: (turns ?? []).map(t => ({ speaker: t.speaker === userLabel ? 'you' : 'them', text: t.text })),
      },
      effort: 'low',
    });
  } catch {
    return fallback();
  }

  const text = typeof out?.text === 'string' ? out.text.trim() : '';
  if (!text || text.length > MAX_CHARS) return fallback();
  // Don't trust the model's own hooksUsed; check the words actually landed in the message.
  const used = groundedIn(text, hooks);
  if (hookTerms(hooks).length && !used.length && !echoesThem(text, turns, userLabel, otherName)) return fallback();
  return { text, hooksUsed: used, source: 'muse-spark' };
}
