// Who is in the room, read off the transcript as it streams. Two kinds of cue, both deterministic:
//   intro     "I'm Priya" / "me llamo Ana"  -> that speaker is Priya
//   vocative  "Hi Abuela!" / "thanks, Jordan" -> whoever this line is addressed to is Abuela
// Nobody types the other person's name mid-conversation, so this is where it comes from.

import { normName } from '../names.js';
import { STOPWORDS } from './text.js';

const INTRO_CONF = 0.9;
const VOCATIVE_CONF = 0.7;
const CONFLICT_PENALTY = 0.2; // two different names in play: trust either one less

// One capitalised word, 2-20 letters, "Dr." and friends don't qualify (the dot stops the match).
const WORD = '\\p{Lu}[\\p{Ll}\\p{M}]{1,19}(?:[-\'’]\\p{Lu}?[\\p{Ll}\\p{M}]+)?';
const NAME = `(${WORD}(?:\\s+${WORD})?)`;
const PUNCT = '[!.?…,]*';

const INTRO = new RegExp(`(?:^|[^\\p{L}])(?:I['’]m|I am|[Mm]y name['’]?s|[Mm]y name is|[Tt]his is|[Cc]all me|[Mm]e llamo|[Ss]oy)\\s+${NAME}`, 'gu');
// "Hi X", "Gracias X" anywhere a line opens or closes with it.
const GREETING = '(?:[Hh]i|[Hh]ey|[Hh]ello|[Hh]ola|[Tt]hanks|[Tt]hank you|[Gg]racias|[Bb]ye|[Gg]oodbye|[Aa]di[óo]s|[Gg]ood (?:morning|afternoon|evening|night)|[Mm]orning|[Bb]uen[oa]s(?: (?:días|tardes|noches))?|[Oo]ye|[Ww]elcome|[Cc]ongrats|[Cc]ongratulations|[Ff]elicidades|[Ss]orry|[Pp]erdón|[Ss]ure|[Yy]es|[Nn]o|[Oo]kay|[Oo]k)';
// "Sí, mija" and "Chiles, calabazas" also open with a capitalised word and a comma, so a name up
// front only counts when what follows is said *to* someone.
const OPENER = "(?:hey|hi|hello|hola|thanks|thank you|gracias|how|what|where|when|why|so|good|great|nice|long|it['’]s|its|you|your|i|i['’]m|we|are|do|did|can|could|would|will|is|was|tell|let|listen|look|come|wait|please|sorry|welcome|congrats|happy|buenos|buenas|qué|cómo|dónde|cuándo|dime|mira|oye|ven|espera|por|te|tú|usted|gusto|mucho)(?![\\p{L}'’])";
const VOCATIVES = [
  new RegExp(`^[¡¿"'“]?${GREETING},?\\s+${NAME}${PUNCT}(?:\\s|$)`, 'u'), // Hi Abuela! How's...
  new RegExp(`^[¡"'“]?${NAME}[,!]\\s+${OPENER}`, 'u'),                      // Jordan, hey
  new RegExp(`(?:,\\s*|\\s${GREETING}\\s+)${NAME}${PUNCT}["'”]?$`, 'u'),     // ...thanks, Maria.
];

// Capitalised words Muse hands us that are not names. STOPWORDS covers most 4+ letter fillers;
// the kin words are pulled back out because "Hi Abuela" is exactly the case we want.
const KIN = new Set(['abuela', 'abuelo', 'mom', 'mama', 'papa', 'dad', 'nana', 'tia', 'tio']);
const NOT_NAMES = new Set([
  'hi', 'hey', 'hello', 'hola', 'okay', 'ok', 'yes', 'yeah', 'yep', 'no', 'nope', 'so', 'oh', 'ah', 'um', 'uh', 'wow',
  'bro', 'dude', 'man', 'girl', 'guys', 'guy', 'buddy', 'pal', 'mate', 'honey', 'dear', 'love', 'babe', 'champ', 'boss',
  'mija', 'mijo', 'mijita', 'mijito', 'amigo', 'amiga', 'hermano', 'hermana', 'senor', 'senora', 'senorita', 'don', 'dona',
  'sir', 'madam', 'miss', 'mister', 'doctor', 'dr', 'mr', 'mrs', 'ms',
  'sorry', 'thanks', 'thank', 'gracias', 'please', 'good', 'great', 'fine', 'sure', 'well', 'right', 'bad', 'done', 'back',
  'here', 'there', 'home', 'late', 'early', 'ready', 'glad', 'happy', 'tired', 'busy', 'free', 'sick', 'lost', 'cool', 'nice',
  'now', 'today', 'tomorrow', 'tonight', 'yesterday', 'morning', 'evening', 'night', 'everyone', 'everybody', 'all',
  'me', 'you', 'we', 'they', 'it', 'he', 'she', 'my', 'your', 'our', 'us', 'them', 'him', 'her', 'who', 'what', 'how',
  'buenos', 'buenas', 'dias', 'tardes', 'noches', 'bien', 'mal', 'listo', 'lista', 'feliz', 'muy',
  'si', 'ay', 'ya', 'eso', 'esa', 'ese', 'una', 'uno', 'los', 'las', 'the', 'and', 'but', 'this', 'that', 'then', 'also',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]);

const plain = w => normName(w).replace(/['’]s$/, '');

function validName(raw) {
  const words = String(raw ?? '').trim().split(/\s+/);
  if (!words.length || words.length > 2) return null;
  const kept = [];
  for (const w of words) {
    const key = plain(w);
    if (!key || (!KIN.has(key) && (NOT_NAMES.has(key) || STOPWORDS.has(key)))) {
      if (kept.length) break; // "Jordan How" -> "Jordan"
      return null;
    }
    kept.push(w.replace(/['’]s$/, ''));
  }
  return kept.join(' ');
}

const firstOf = name => plain(String(name ?? '').split(/\s+/)[0]);

// Every name mention in the transcript with who it belongs to: the speaker (intro) or
// whoever the speaker is talking to (vocative, `addressedBy`).
function mentions(turns) {
  const out = [];
  for (const t of turns) {
    if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
    const text = t.text.trim();
    for (const m of text.matchAll(INTRO)) {
      const name = validName(m[1]);
      if (name) out.push({ name, cue: 'intro', speaker: t.speaker, turnId: t.turnId, how: `intro "${m[0].trim()}" on turn ${t.turnId}` });
    }
    const seen = new Set();
    for (const re of VOCATIVES) {
      const m = text.match(re);
      const name = m && validName(m[1]);
      if (!name || seen.has(normName(name))) continue;
      seen.add(normName(name));
      out.push({ name, cue: 'vocative', addressedBy: t.speaker, turnId: t.turnId, how: `vocative "${m[0].trim()}" on turn ${t.turnId}` });
    }
  }
  return out;
}

const real = s => s && s !== 'unknown';

export function detectPeople(turns, { userName = null, userLabel = null } = {}) {
  const found = mentions(Array.isArray(turns) ? turns : []);
  const me = userName ? firstOf(userName) : null;
  const isMe = name => !!me && firstOf(name) === me;

  // The user: their own intro under their own name; the label falls out of it.
  let self = null;
  for (const m of found) {
    if (m.cue !== 'intro' || !isMe(m.name) || !real(m.speaker)) continue;
    if (userLabel && m.speaker !== userLabel) continue;
    self = { speaker: m.speaker, name: m.name, turnId: m.turnId };
    break;
  }
  const mine = userLabel ?? self?.speaker ?? null;

  // The other person: anyone who isn't the user introducing themselves, or whoever the user addresses.
  const tally = new Map(); // normalised name -> { name, conf, turnId, how, first }
  found.forEach((m, i) => {
    if (isMe(m.name)) return;
    let conf;
    if (m.cue === 'intro') {
      if (mine && m.speaker === mine) return; // the user under a name we don't know: not them
      conf = INTRO_CONF;
    } else {
      // A vocative from the other side is aimed at the user, whatever they got called.
      if (mine && real(m.addressedBy) && m.addressedBy !== mine) return;
      conf = VOCATIVE_CONF;
    }
    const key = normName(m.name);
    const row = tally.get(key);
    if (!row) tally.set(key, { name: m.name, confidence: conf, turnId: m.turnId, how: m.how, first: i });
    else if (conf > row.confidence) Object.assign(row, { confidence: conf, turnId: m.turnId, how: m.how });
  });

  let other = null;
  if (tally.size) {
    const rows = [...tally.values()].sort((a, b) => b.confidence - a.confidence || a.first - b.first);
    const [best] = rows;
    const confidence = rows.length > 1 ? Math.round((best.confidence - CONFLICT_PENALTY) * 100) / 100 : best.confidence;
    const how = rows.length > 1 ? `${best.how}; also heard ${rows.slice(1).map(r => r.name).join(', ')}` : best.how;
    other = { name: best.name, turnId: best.turnId, confidence, how };
  }
  return { other, self };
}
