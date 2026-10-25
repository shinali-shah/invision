// Word-level plumbing shared by the rest of src/nlp. English and Spanish both show up in
// the same conversation, so everything here has to cope with either.

// Only words of 4+ letters ever reach this list, so shorter stopwords are left out.
export const STOPWORDS = new Set([
  // English
  'about', 'above', 'after', 'again', 'also', 'always', 'another', 'anything', 'anyway', 'around',
  'back', 'because', 'been', 'before', 'being', 'better', 'both', 'came', 'cause', 'come', 'comes',
  'coming', 'could', 'didn', 'does', 'doesn', 'doing', 'done', 'down', 'each', 'even', 'ever',
  'every', 'everyone', 'everything', 'from', 'getting', 'give', 'goes', 'going', 'gonna', 'good',
  'gotta', 'great', 'guess', 'had', 'have', 'having', 'here', 'hers', 'him', 'himself', 'into',
  'just', 'keep', 'kind', 'know', 'like', 'little', 'long', 'look', 'lots', 'made', 'make', 'many',
  'maybe', 'mean', 'more', 'most', 'much', 'must', 'myself', 'need', 'never', 'nice', 'nothing',
  'okay', 'only', 'other', 'ours', 'over', 'pretty', 'probably', 'quite', 'really', 'right', 'said',
  'same', 'should', 'since', 'some', 'something', 'sometimes', 'still', 'stuff', 'such', 'sure',
  'take', 'tell', 'than', 'thank', 'thanks', 'that', 'thats', 'their', 'theirs', 'them', 'then',
  'there', 'these', 'they', 'thing', 'things', 'think', 'this', 'those', 'though', 'through', 'today',
  'together', 'told', 'took', 'very', 'want', 'wanted', 'wants', 'well', 'went', 'were', 'what',
  'whatever', 'when', 'where', 'which', 'while', 'will', 'with', 'without', 'wonder', 'would', 'yeah',
  'year', 'years', 'your', 'yours', 'yourself', 'week', 'weeks', 'hello', 'okay', 'wow', 'haha',
  'actually', 'basically', 'literally', 'totally', 'definitely', 'already', 'enough', 'almost',
  'away', 'last', 'first', 'next', 'time', 'times', 'yes', 'sounds', 'sound', 'cool', 'awesome',
  'abuela', 'abuelo', 'mom', 'mama', 'papa',
  // Spanish
  'ahora', 'algo', 'alguien', 'allí', 'allá', 'antes', 'aquí', 'bien', 'bueno', 'buena', 'cada',
  'casi', 'como', 'cómo', 'con', 'cosa', 'cosas', 'cual', 'cuál', 'cuando', 'cuándo', 'cuanto',
  'cuánto', 'creo', 'decir', 'desde', 'después', 'donde', 'dónde', 'ella', 'ellas', 'ellos',
  'entonces', 'esa', 'esas', 'ese', 'eso', 'esos', 'esta', 'está', 'estaba', 'estamos', 'están',
  'estar', 'estas', 'estás', 'este', 'esto', 'estos', 'estoy', 'fueron', 'gracias', 'hace', 'hacer',
  'hasta', 'hola', 'había', 'hay', 'luego', 'mucho', 'mucha', 'muchos', 'muchas', 'muy', 'mija',
  'mijo', 'mismo', 'misma', 'nada', 'nadie', 'nosotros', 'nuestra', 'nuestro', 'otra', 'otras',
  'otro', 'otros', 'para', 'pero', 'poco', 'porque', 'pues', 'puede', 'pueden', 'quiero', 'sabes',
  'sobre', 'solo', 'sólo', 'somos', 'también', 'tanto', 'tener', 'tengo', 'tiene', 'tienes',
  'toda', 'todas', 'todo', 'todos', 'tuve', 'tuvo', 'unas', 'unos', 'usted', 'vamos', 'verdad',
  'vez', 'veces', 'claro', 'oye', 'mira', 'dime', 'cuéntame', 'cuenta', 'cuento', 'ustedes',
  'nuestros', 'nuestras', 'aunque', 'mientras', 'siempre', 'nunca', 'todavía', 'ya', 'dijo',
  'tenía', 'teníamos', 'era', 'eran', 'fue', 'sido', 'ser', 'qué', 'quién', 'quien', 'señora',
]);

// Possessive 's comes off ("Oaxaca's" -> "oaxaca"); other contractions stay whole.
export const tokens = text => (String(text ?? '').toLowerCase().match(/\p{L}+(?:['’]\p{L}+)?/gu) ?? [])
  .map(w => w.replace(/['’]s$/, ''));

// Two passes, plurals then verb/agentive endings, so "dinners" and "dinner" both land on "dinn".
// A suffix only comes off if 4+ letters are left, which keeps short words intact.
const PLURALS = [
  ['ies', 'y'],
  ['oes', 'o'], ['sses', 'ss'], ['xes', 'x'], ['ches', 'ch'], ['shes', 'sh'],
  ['s', ''],
];
const ENDINGS = [
  'ieron', 'iendo', 'aban', 'ando', 'aron', 'ían', 'aba', 'ing', 'ied', 'ed', 'ar', 'er', 'ir',
];

function strip(word, list) {
  for (const entry of list) {
    const [suffix, repl = ''] = Array.isArray(entry) ? entry : [entry];
    if (!word.endsWith(suffix)) continue;
    const base = word.slice(0, -suffix.length) + (suffix === 'ied' ? 'y' : repl);
    return base.length >= 4 ? base : word;
  }
  return word;
}

export function stem(word) {
  let w = String(word ?? '').toLowerCase();
  if (!/(ss|us|is)$/.test(w)) w = strip(w, PLURALS);
  return strip(w, ENDINGS);
}

const isContent = w => w.length >= 4 && !STOPWORDS.has(w) && !/['’]/.test(w);

// [{ word, stem }] in reading order, duplicates kept; handy when the surface form matters.
export const contentTokens = text => tokens(text).filter(isContent).map(word => ({ word, stem: stem(word) }));

export const contentWords = text => new Set(contentTokens(text).map(t => t.stem));

const asStems = x => (x instanceof Set ? x : contentWords(x));

export function overlap(a, b) {
  const bs = asStems(b);
  return [...asStems(a)].filter(s => bs.has(s));
}

export const wordCount = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

const FILLERS = /^(?:(?:yeah|yes|um+|uh+|so|like|oh|well|okay|ok|hey|hmm+|mm+|and|bueno|pues|oye)(?![\p{L}'’])[\s,.…-]*)+/iu;

// Leading "yeah, um, so" off a line; the first letter is capitalized again if anything came off.
export function stripFillers(text) {
  const t = String(text ?? '').trim();
  const rest = t.replace(FILLERS, '');
  if (!rest || rest === t) return rest || t;
  return rest[0].toUpperCase() + rest.slice(1);
}

// A wh-word followed by "I"/"we" is usually a story ("when I was in Oaxaca", "what I liked"), not a question.
const WH = "(?:what|how|why|where|when|who|which|qué|cómo|cuándo|dónde|por qué|quién|cuál|y tú)(?:['’]s)?(?![\\p{L}'’])(?!\\s+(?:i|we)(?![\\p{L}'’]))";
// Auxiliaries need a subject after them: "do you", "is it", but not "have a good one" or "do it tomorrow".
const AUX = "(?:(?:did|does|are|is|was|were|can|could|would|will|should|have|has)\\s+(?:you|we|they|she|he|i|it|there|that|this|your|anyone|anybody|everyone)|do\\s+(?:you|we|they|i|your))(?![\\p{L}'’])";
const QUESTION_START = new RegExp(`^(?:${WH}|${AUX})`, 'iu');
// "...and I mean yeah so like what else do you do": the question rides at the end of a run-on line.
const QUESTION_TAIL = new RegExp(`(?:[,;:]|(?<!\\p{L})(?:like|so|and|but|well|um|uh|yeah|okay|ok|oh|or|wait|honestly))\\s+(?:${WH}|${AUX})`, 'iu');

// ASR output often has no punctuation at all, so "what do you do" has to count as a question too.
// Punctuation is trusted where it exists, but the "?" at the very end is what the ASR drops most,
// so only the last sentence is judged on its words.
export function isQuestion(text) {
  const t = String(text ?? '');
  if (/[?¿]/.test(t)) return true;
  const last = sentences(t).at(-1) ?? '';
  if (/[.!…]["'”)]?$/.test(last.trim())) return false;
  const s = stripFillers(last);
  return QUESTION_START.test(s) || QUESTION_TAIL.test(s);
}

export const sentences = text => String(text ?? '').trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
