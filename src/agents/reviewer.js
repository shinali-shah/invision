const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'rewrite'] },
    text: { type: 'string' },
    suggestion: { type: 'string' },
  },
  required: ['verdict', 'text', 'suggestion'],
  additionalProperties: false,
};

const SYSTEM = [
  'You review a coaching note before the user sees it. The note is about how the user listened in a conversation.',
  '',
  'The note passes only if all of these hold:',
  '1. It is written to the user in second person ("you").',
  '2. `text` and `suggestion` together are at most 3 sentences.',
  '3. Every number it mentions appears in `signals` (spelled-out numbers count too, e.g. "three" for 3).',
  '4. It does not evaluate, score or label the other person (no "she was distant", "he seemed bored"), and does not call the user good or bad at conversation. Describing what the other person did, like telling a story or giving a long answer, is fine.',
  '',
  'If it passes, return verdict "pass" and copy the note\'s text and suggestion unchanged.',
  'If it fails, return verdict "rewrite" with a fixed text and suggestion that keep the original meaning and specifics but meet every rule. Drop any number you cannot find in `signals`.',
].join('\n');

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SCORING = /\b(score|rating|rated|\d+\/10)\b/i;
const JUDGEMENT_WORDS = '(boring|rude|cold|distant|annoying|awkward|uninterested|disinterested|bad|difficult|a bad)';

export function violatesOtherPersonRule(text, otherName) {
  if (!text) return false;
  if (SCORING.test(text)) return true;
  const subjects = ['she', 'he', 'they', 'your \\w+'];
  if (otherName?.trim()) subjects.push(escapeRe(otherName.trim()));
  const judgement = new RegExp(`\\b(${subjects.join('|')})\\s+(is|was|were|are|seems|seemed|sounded|felt)\\s+${JUDGEMENT_WORDS}\\b`, 'i');
  return judgement.test(text);
}

const violates = (note, otherName) => violatesOtherPersonRule(note.text, otherName) || violatesOtherPersonRule(note.suggestion, otherName);

const drop = note => ({ ...note, text: null, suggestion: null, status: 'dropped', reason: 'reviewer' });

export async function reviewNote({ llm, note, signals, otherName }) {
  if (note.status === 'dropped') return note;
  if (violates(note, otherName)) return drop(note);

  let out;
  try {
    out = await llm.json({
      name: 'review',
      schema: SCHEMA,
      system: SYSTEM,
      user: { note: { text: note.text, suggestion: note.suggestion ?? '' }, signals, otherName: otherName ?? null },
      effort: 'low',
      maxTokens: 1500,
    });
  } catch {
    return drop(note);
  }

  if (out?.verdict === 'pass') return note;
  if (out?.verdict !== 'rewrite' || typeof out.text !== 'string' || !out.text.trim()) return drop(note);

  const rewritten = { ...note, text: out.text.trim(), suggestion: out.suggestion?.trim() || null, status: 'rewritten' };
  return violates(rewritten, otherName) ? drop(note) : rewritten;
}
