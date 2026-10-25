// Pulls the things worth remembering out of a transcript: what they cared about, what's coming
// up for them, what the user promised, and where the user talked past them. Regexes and
// counting only, so every hook can point at the turn it came from.

import { detectAwkward } from './awkward.js';
import { contentTokens, contentWords, isQuestion, overlap, sentences, stripFillers, wordCount } from './text.js';

const MAX_TOPICS = 5;
const MAX_EVENTS = 3;
const MAX_COMMITMENTS = 3;
const MAX_HIGHLIGHTS = 2;
const LONG_TURN_WORDS = 12;
const MAX_TEXT = 90;

const textOf = t => String(t?.text ?? '');
// Anything not tagged as the user is the other side, 'unknown' included (same as rules.js).
const isUser = (t, userLabel) => t?.speaker === userLabel;
const asList = turns => (Array.isArray(turns) ? turns.filter(t => t && typeof t === 'object') : []);

// --- follow-ups -------------------------------------------------------------

// \b is ASCII-only even with the u flag, so it misses words ending in "í" or "á".
const word = alts => new RegExp(`(?<!\\p{L})(?:${alts})(?!\\p{L})`, 'iu');

// "it" and "there" are left out on purpose: "is it cold outside?" points at nothing.
const BACK_REFERENCE = [
  word('that|eso|esa|ese|allí|allá|ahí'),
  /\breally\s*\?/i,
  word('how come|why|and then|what happened|then what|por qué|y luego|y después'),
  /(?:^|\s)¿\s*y(?!\p{L})/iu,
];
const isBackReference = text => BACK_REFERENCE.some(re => re.test(text));

// Surface words from `text` whose stems are in `stems`, deduped, in reading order.
function surface(text, stems) {
  const seen = new Set();
  const out = [];
  for (const { word, stem } of contentTokens(text)) {
    if (!stems.includes(stem) || seen.has(stem)) continue;
    seen.add(stem);
    out.push(word);
  }
  return out;
}

export function detectFollowUps(turns, userLabel) {
  const ts = asList(turns);
  const out = [];
  ts.forEach((turn, i) => {
    if (!isUser(turn, userLabel) || !isQuestion(textOf(turn))) return;
    const prevOther = ts.slice(0, i).reverse().find(t => !isUser(t, userLabel));
    const shared = prevOther ? overlap(textOf(turn), textOf(prevOther)) : [];
    // A bare "why?" only refers back to something if they were the last one talking.
    const justSpoke = i > 0 && !isUser(ts[i - 1], userLabel);
    out.push({
      turnId: turn.turnId,
      isFollowUp: shared.length > 0 || (justSpoke && isBackReference(textOf(turn))),
      overlap: surface(textOf(turn), shared),
    });
  });
  return out;
}

// --- topics -----------------------------------------------------------------

const NOT_TOPICS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  // small talk that clears the stopword list but is never what a conversation was about
  'meet', 'nice', 'cool', 'sounds', 'sound', 'thanks', 'thank', 'great', 'awesome', 'glad', 'pleasure',
  'yeah', 'okay', 'sure', 'totally', 'gusto', 'encantada', 'encantado', 'mucho',
  'people', 'work', 'working', 'honestly', 'kinda', 'sorta', 'alright', 'dunno', 'sometime', 'stuff',
  'someone', 'busy', 'super', 'crazy', 'place', 'start', 'point', 'guys', 'folks', 'nope', 'yep',
  'thing', 'things', 'today', 'cooked', 'feel', 'feels', 'siento',
]);

// Words that look like adverbs or verb forms but are fine topics.
const KEEP = new Set([
  'family', 'italy', 'july', 'wedding', 'morning', 'evening', 'meeting', 'building', 'painting',
  'ceiling', 'clothing', 'beijing', 'wyoming', 'pared',
]);

// English -ly adverbs and -ed/-ing verb forms still count for overlap, just not as topics.
function topicWord(word, proper) {
  if (NOT_TOPICS.has(word)) return false;
  if (proper || KEEP.has(word)) return true;
  if (/ly$/.test(word)) return false;
  if (/ing$/.test(word) && word.length >= 6) return false;
  return !(/ed$/.test(word) && !/eed$/.test(word) && word.length >= 5);
}

// "I'm Priya", "my name is Priya", "me llamo Priya": a name is who someone is, not what they talked about.
const INTRO = /(?:i['’]m|i am|my name['’]?s|my name is|call me|me llamo|soy)\s+(\p{Lu}\p{L}+)/gu;

function introducedNames(ts, otherName) {
  const names = new Set();
  for (const part of String(otherName ?? '').toLowerCase().split(/\s+/)) if (part && part !== 'them') names.add(part);
  for (const t of ts) for (const m of textOf(t).matchAll(INTRO)) names.add(m[1].toLowerCase());
  return names;
}

// Capitalized words that don't open a sentence: usually names and places.
function properNouns(text) {
  const found = new Set();
  const raw = text.split(/\s+/).filter(Boolean);
  raw.forEach((tok, i) => {
    if (i === 0 || /^[¿¡"'“(]/.test(tok) || /[.!?…]["'”)]?$/.test(raw[i - 1])) return;
    const w = tok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/['’]s$/, '');
    if (/^\p{Lu}/u.test(w)) found.add(w.toLowerCase());
  });
  return found;
}

// stem -> { stem, forms: Map(word -> count), turnIds: Set, mentions, proper, echoed }
function termStats(ts, userLabel, names = new Set()) {
  const stats = new Map();
  const userStems = new Set();
  for (const t of ts) {
    if (isUser(t, userLabel)) {
      for (const s of contentWords(textOf(t))) userStems.add(s);
      continue;
    }
    const proper = properNouns(textOf(t));
    for (const { word, stem } of contentTokens(textOf(t))) {
      if (names.has(word) || !topicWord(word, proper.has(word))) continue;
      const s = stats.get(stem) ?? { stem, forms: new Map(), turnIds: new Set(), mentions: 0, proper: false };
      s.forms.set(word, (s.forms.get(word) ?? 0) + 1);
      s.turnIds.add(t.turnId);
      s.mentions++;
      if (proper.has(word)) s.proper = true;
      stats.set(stem, s);
    }
  }
  for (const s of stats.values()) {
    s.echoed = userStems.has(s.stem);
    // Repetition across their turns is the base; a name/place and the user picking it up both add.
    s.weight = s.mentions + (s.turnIds.size - 1) + (s.proper ? 2 : 0) + (s.echoed ? 1 : 0);
  }
  return stats;
}

function displayForm(s) {
  let best = null;
  for (const [w, n] of s.forms) if (!best || n > s.forms.get(best)) best = w;
  return s.proper ? best[0].toUpperCase() + best.slice(1) : best;
}

function topicsFrom(stats) {
  return [...stats.values()]
    .filter(s => s.weight >= 2)
    // Stable sort, so ties keep the order they first came up in
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_TOPICS)
    .map(s => ({ term: displayForm(s), turnIds: [...s.turnIds], weight: s.weight }));
}

// --- events and commitments -------------------------------------------------

const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const DIAS = 'lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo';
const EVENT_NOUNS = 'interview|trip|exam|test|launch|wedding|appointment|meeting|presentation|surgery|'
  + 'flight|recital|deadline|conference|move|graduation|entrevista|examen|viaje|boda|cita';

const EVENT_NOUN = word(EVENT_NOUNS);
// Something you'd actually ask about later, for "going to" / "voy a" lines.
const PLAN = word(`${EVENT_NOUNS}|visit|visiting|move|moving|start|starting|fly|flying|go to|head to|travel|`
  + 'traveling|drive|see|apply|graduate|ir a|viajar|visitar|mudarme|mudarnos|empezar|volar|ver a');
const HABIT = word(`every (?:week|weekend|day|${DAYS})|each (?:week|${DAYS})|todos los|cada (?:semana|${DIAS})`);
const PAST = word('was|were|went|came|had|did|got|last (?:week|month|year|night|time)|ago|yesterday|ayer|fue|fuimos|fueron|tuve|pasado|pasada');

// Any cue is dropped if the sentence is past tense ("this weekend was amazing").
// `day` cues are also dropped for habits ("every Sunday"); `plan` cues need a PLAN word nearby.
const EVENT_CUES = [
  { re: word('tomorrow|tonight') },
  { re: word(`next (?:week|month|year|weekend|semester|summer|spring|fall|winter|${DAYS})`), day: true },
  { re: word(`this (?:weekend|${DAYS})`), day: true },
  { re: word('later this (?:week|month)') },
  { re: word('in (?:a|two|three|a few) (?:days|weeks|months)') },
  { re: /(?<!(?:la|por la|en la|de la) )(?<!\p{L})mañana(?!\p{L})/iu },
  { re: word('(?:la|esta) próxima semana|la semana que viene|el (?:mes|año) que viene') },
  { re: word('el próximo \\p{L}+|la próxima \\p{L}+') },
  { re: word('este fin de semana'), day: true },
  { re: word(`on (?:${DAYS})`), day: true },
  { re: word(`el (?:${DIAS})`), day: true },
  { re: word(`(?:i|we) have (?:a|an|my|our|the) (?:\\p{L}+ )?(?:${EVENT_NOUNS})`) },
  { re: word(`(?:my|our|mi|la|el) (?:\\p{L}+ )?(?:${EVENT_NOUNS})`) },
  { re: word("(?:i['’]m|i am|we['’]re|we are) (?:going to|gonna)"), plan: true },
  { re: word('(?:voy|vamos) a'), plan: true },
];

// "going to Austin" / "voy a Guadalajara" is a plan too: a place right after the cue.
const hasPlan = (sentence, m) => PLAN.test(sentence.replace(m[0], ' '))
  || /^\s+(?:the\s+)?\p{Lu}/u.test(sentence.slice(m.index + m[0].length));

const eventCueFits = (cue, sentence, m) => !PAST.test(sentence)
  && !(cue.day && HABIT.test(sentence))
  && !(cue.plan && !hasPlan(sentence, m));

const ACTIONS = 'send|text|call|email|e-mail|share|forward|introduce|check|look into|find|get back|let you know|'
  + 'follow up|reach out|ping|bring|write|connect|message|visit|grab';
// ASR often drops the apostrophe, hence "ill".
const COMMITMENT_CUES = [
  `(?:i['’]ll|i will|ill)(?: (?:definitely|totally|also|just|def|try to|make sure to))? (?:${ACTIONS})`,
  `(?:i['’]m|i am) (?:going to|gonna) (?:${ACTIONS})`,
  `let me (?:${ACTIONS})`,
  `i can (?:${ACTIONS}) you`,
  'remind me to',
  'te (?:mando|llamo|escribo|aviso|envío|envio|paso)',
  'voy a (?:mandarte|llamarte|escribirte|enviarte|pasarte|visitarte)',
].map(alts => ({ re: word(alts) }));

const commitmentCueFits = (_, sentence) => !isQuestion(sentence);

function clip(text, at = 0, cueLength = 0) {
  const t = text.trim();
  if (t.length <= MAX_TEXT) return t;
  // Start from the top if the cue fits, otherwise keep a window around it. Cut on word boundaries.
  let start = at + cueLength < MAX_TEXT - 2 ? 0 : Math.max(0, Math.min(at - 30, t.length - MAX_TEXT));
  if (start > 0) start = t.indexOf(' ', start) + 1 || start;
  let piece = t.slice(start, start + MAX_TEXT - 2);
  if (start + piece.length < t.length) piece = piece.replace(/\s+\S*$/, '');
  return `${start > 0 ? '…' : ''}${piece.trim()}${start + piece.length < t.length ? '…' : ''}`;
}

// The sentence holding the first cue that fits; for long sentences, the clause instead.
function findCue(text, cues, fits) {
  for (const raw of sentences(text)) {
    const sentence = stripFillers(raw);
    for (const cue of cues) {
      const m = cue.re.exec(sentence);
      if (!m || !fits(cue, sentence, m)) continue;
      let piece = sentence;
      let at = m.index;
      if (sentence.length > MAX_TEXT) {
        const clause = sentence.split(/(?<=[,;:])\s+/).find(c => cue.re.test(c));
        if (clause) {
          piece = stripFillers(clause);
          at = piece.search(cue.re);
        }
      }
      return { text: clip(piece, at, m[0].length), when: m[0].toLowerCase() };
    }
  }
  return null;
}

function eventsFrom(ts, userLabel) {
  const out = [];
  for (const t of ts) {
    if (out.length >= MAX_EVENTS) break;
    if (isUser(t, userLabel)) continue;
    const hit = findCue(textOf(t), EVENT_CUES, eventCueFits);
    if (hit) out.push({ text: hit.text, when: hit.when, hasNoun: EVENT_NOUN.test(hit.text), turnId: t.turnId });
  }
  return out;
}

function commitmentsFrom(ts, userLabel) {
  const out = [];
  for (const t of ts) {
    if (out.length >= MAX_COMMITMENTS) break;
    if (!isUser(t, userLabel)) continue;
    const hit = findCue(textOf(t), COMMITMENT_CUES, commitmentCueFits);
    if (hit) out.push({ text: hit.text, turnId: t.turnId });
  }
  return out;
}

// --- bids and highlights ----------------------------------------------------

const SELF_DISCLOSURE = [
  /\b(?:i|i['’]m|my|me)\b[^.!?]*\bfeel/i,
  word('worried|worry|excited|finally|nervous|scared|afraid|stressed|anxious|proud|lonely|sad|upset|honestly|i miss'),
  word('estoy|extraño|ojalá|por fin|me siento'),
  // telling you who they are is a bid too, and the classic one to answer with "oh cool"
  word("(?:i['’]m|i am) (?:a|an|studying|working|from|majoring|trying|building|starting)|i (?:work|study|moved|grew up)|majoring|studying"),
];

// "Oh cool. Um", "nice", "haha yeah": an answer with nothing in it.
const STRONG_DISCLOSURE = SELF_DISCLOSURE.slice(0, 3);
const ACKNOWLEDGES = word("good luck|congrats|congratulations|so sorry|i['’]m sorry|sorry to hear|that['’]s (?:so |really )?(?:amazing|awesome|incredible|hard|tough|rough|huge|exciting)|that sounds (?:hard|tough|amazing|exciting)|i love that|no way|felicidades|lo siento|qué bueno|que bueno|suerte");
const ABOUT_THEM = word('you|your|tú|tu|usted');

const isBareAcknowledgment = text => contentWords(text).size === 0 && wordCount(text) <= 6;

// Same filtering as topics, so "honestly" or "dunno" never end up as the cue.
function bidCue(text, stats) {
  const proper = properNouns(text);
  let best = null;
  for (const { word, stem } of contentTokens(text)) {
    if (!topicWord(word, proper.has(word))) continue;
    const s = stats.get(stem);
    const w = s?.weight ?? 0;
    if (!best || w > best.w || (w === best.w && word.length > best.word.length)) {
      best = { word: s ? displayForm(s) : word, w };
    }
  }
  return best?.word ?? '';
}

function missedBidsFrom(ts, userLabel, stats) {
  const out = [];
  ts.forEach((t, i) => {
    const reply = ts[i + 1];
    if (isUser(t, userLabel) || !reply || !isUser(reply, userLabel)) return;
    const text = textOf(t);
    // They asked you something, so answering it with your own news is fine.
    if (isQuestion(text) && wordCount(text) < LONG_TURN_WORDS) return;
    const opened = wordCount(text) >= LONG_TURN_WORDS || SELF_DISCLOSURE.some(re => re.test(text))
      || (wordCount(text) >= 8 && isBareAcknowledgment(textOf(reply)));
    if (!opened) return;
    if (overlap(textOf(reply), text).length) return;
    if (isQuestion(textOf(reply)) && isBackReference(textOf(reply))) return;
    // "Good luck with your brother!" or "I'm so sorry" answers the feeling even without their words.
    if (ACKNOWLEDGES.test(textOf(reply))) return;
    // Asking about them ("what are you building?") is engaging, unless they'd just said something heavy.
    if (isQuestion(textOf(reply)) && ABOUT_THEM.test(textOf(reply)) && !STRONG_DISCLOSURE.some(re => re.test(text))) return;
    const cue = bidCue(text, stats);
    if (cue) out.push({ turnId: t.turnId, replyTurnId: reply.turnId, cue });
  });
  return out;
}

function highlightsFrom(ts, userLabel) {
  return ts
    .filter(t => !isUser(t, userLabel))
    .map(t => ({ turnId: t.turnId, words: wordCount(textOf(t)) }))
    .filter(h => h.words >= LONG_TURN_WORDS)
    .sort((a, b) => b.words - a.words)
    .slice(0, MAX_HIGHLIGHTS);
}

export function extractHooks(turns, userLabel, { otherName } = {}) {
  const ts = asList(turns);
  const stats = termStats(ts, userLabel, introducedNames(ts, otherName));
  return {
    topics: topicsFrom(stats),
    events: eventsFrom(ts, userLabel),
    commitments: commitmentsFrom(ts, userLabel),
    missedBids: missedBidsFrom(ts, userLabel, stats),
    highlights: highlightsFrom(ts, userLabel),
    followUpDetector: detectFollowUps(ts, userLabel),
    awkward: detectAwkward(ts, userLabel),
  };
}
