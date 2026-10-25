// Offline stand-ins for Muse Spark, one per agent name. They read the same payload
// the real model gets and derive something plausible from it, so mock mode still
// reacts to what was actually said instead of returning canned text.

import { eventLine } from '../agents/followUp.js';

const STOPWORDS = new Set([
  // English
  'about', 'also', 'been', 'from', 'good', 'have', 'just', 'like', 'really', 'that', 'than', 'then',
  'their', 'them', 'there', 'they', 'this', 'very', 'week', 'were', 'what', 'when', 'where', 'which',
  'with', 'would', 'your', 'yeah', 'okay', 'doing', 'going', 'today', 'abuela',
  // Spanish
  'como', 'cómo', 'cuando', 'donde', 'dónde', 'esta', 'está', 'este', 'esto', 'mucho', 'otra', 'otro',
  'para', 'pero', 'porque', 'pues', 'tiene', 'todo', 'toda', 'todos', 'también', 'bueno', 'entonces',
  'mija', 'mijo', 'gracias', 'hola',
]);

const words = text => (String(text ?? '').toLowerCase().match(/\p{L}+/gu) ?? []);
const contentWords = text => new Set(words(text).filter(w => w.length >= 4 && !STOPWORDS.has(w)));
const wordCount = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
const isQuestion = text => /[?¿]/.test(String(text ?? ''));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Long replies read as a story/anecdote for mock purposes
const STORY_MIN_WORDS = 15;

function sharesWord(a, b) {
  const bw = contentWords(b);
  for (const w of contentWords(a)) if (bw.has(w)) return true;
  return false;
}

function classify({ userLabel, turns, questions } = {}) {
  const ts = Array.isArray(turns) ? turns : [];
  const out = [];
  for (const turnId of Array.isArray(questions) ? questions : []) {
    const i = ts.findIndex(t => t.turnId === turnId);
    if (i === -1) continue;
    const prevOther = ts.slice(0, i).reverse().find(t => t.speaker !== userLabel);
    const reply = ts[i + 1] && ts[i + 1].speaker !== userLabel ? ts[i + 1] : null;
    out.push({
      turnId,
      isFollowUp: !!prevOther && sharesWord(ts[i].text, prevOther.text),
      storyShared: !!reply && wordCount(reply.text) >= STORY_MIN_WORDS,
    });
  }

  // A reflection: a non-question user line that picks up a word from what was just said
  let reflections = 0;
  ts.forEach((t, i) => {
    if (t.speaker !== userLabel || isQuestion(t.text) || i === 0) return;
    const prev = ts[i - 1];
    if (prev.speaker !== userLabel && sharesWord(t.text, prev.text)) reflections++;
  });

  return { questions: out, reflections };
}

// Most-mentioned capitalized word the other person said mid-sentence: usually a place or a name.
const WEEKDAYS = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miércoles|jueves|viernes|sábado|domingo)$/i;

function topicFrom(turns, userLabel, avoid) {
  const counts = new Map();
  const bump = w => counts.set(w, (counts.get(w) ?? 0) + 1);
  // The coach gets speakers as 'you' / 'them' and no userLabel, so 'you' counts as the user too.
  const others = turns.filter(t => t.speaker !== userLabel && t.speaker !== 'you');

  for (const t of others) {
    const tokens = String(t.text ?? '').split(/\s+/);
    tokens.forEach((raw, i) => {
      const w = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      const sentenceStart = i === 0 || /[.!?]["')]?$/.test(tokens[i - 1]);
      // Contractions ("I'll") and weekdays are capitalized but are never what the talk was about.
      if (!sentenceStart && w.length >= 4 && /^\p{Lu}/u.test(w) && !/['’]/.test(w) && !WEEKDAYS.test(w) && !STOPWORDS.has(w.toLowerCase())) bump(w);
    });
  }
  // Nothing capitalized? Fall back to the longest repeated-ish content word.
  if (!counts.size) for (const t of others) for (const w of contentWords(t.text)) if (w.length >= 5) bump(w);

  let best = null;
  for (const [w, n] of counts) {
    if (avoid.includes(w.toLowerCase())) continue;
    if (!best || n > counts.get(best)) best = w;
  }
  return best;
}

const SUGGESTIONS = {
  family: topic => topic
    ? `Next call, try asking more about ${topic} and add any new words from it to your vocab list.`
    : 'Next call, try asking about a place or a word that came up, and add it to your vocab list.',
  friend: topic => topic
    ? `Next time, check back in about ${topic} and ask how it went.`
    : 'Next time, follow up on something that matters to them and ask how it went.',
  networking: topic => topic
    ? `Send a short follow-up message today that mentions ${topic}.`
    : 'Send a short follow-up message today that mentions something they told you.',
};

function coach({ tag, signals, turns, userLabel, lastNotes, hooks } = {}) {
  const s = signals ?? {};
  const ts = Array.isArray(turns) ? turns : [];
  const q = Number.isFinite(s.userQuestions) ? s.userQuestions : 0;
  const f = s.followUps;
  const stories = s.storiesAfterQuestions;

  let first = `You asked ${plural(q, 'question', 'questions')}`;
  if (Number.isFinite(f)) first += ` and ${f} ${f === 1 ? 'was a follow-up' : 'were follow-ups'}`;
  const sentences = [`${first}.`];

  if (Number.isFinite(stories) && stories > 0) {
    sentences.push(`You heard ${plural(stories, 'story', 'stories')} after your questions.`);
  } else if (s.otherAvgAnswerWords > 0) {
    sentences.push(`Answers to your questions ran about ${s.otherAvgAnswerWords} words.`);
  }

  // Don't keep suggesting the same topic as the last few notes did
  const avoid = (Array.isArray(lastNotes) ? lastNotes : [])
    .flatMap(n => words(typeof n === 'string' ? n : `${n?.text ?? ''} ${n?.suggestion ?? ''}`));
  // The measured topics are what they talked about most; a capitalized word is the fallback.
  const topic = (hooks?.topics ?? []).map(t => t.term).find(t => !avoid.includes(t.toLowerCase())) ?? topicFrom(ts, userLabel, avoid);
  const suggestion = (SUGGESTIONS[tag] ?? SUGGESTIONS.friend)(topic);

  const known = new Set(ts.map(t => t.turnId));
  let cited = (Array.isArray(s.questions) ? s.questions : []).filter(x => x.isFollowUp).map(x => x.turnId);
  if (!cited.length) cited = ts.filter(t => t.speaker === userLabel && isQuestion(t.text)).map(t => t.turnId);

  return { text: sentences.join(' '), suggestion, citedTurnIds: cited.filter(id => known.has(id)).slice(0, 3) };
}

function review(payload = {}) {
  const note = payload.note ?? payload;
  return { verdict: 'pass', text: note.text ?? '', suggestion: note.suggestion ?? '' };
}

const METRIC_LABELS = {
  followUps: 'follow-up questions',
  userQuestions: 'questions',
  otherAvgAnswerWords: 'average answer length after your questions',
  userTalkShare: 'share of the talking',
};

function pattern({ metric, counts } = {}) {
  const c = Array.isArray(counts) && counts.length ? counts : [0];
  const first = c[0];
  const last = c.at(-1);
  const dir = last > first ? 'rose' : last < first ? 'fell' : 'held steady';
  const label = METRIC_LABELS[metric] ?? 'numbers';
  return { statement: `Your ${label} ${dir} from ${first} to ${last} per conversation over your last ${plural(c.length, 'conversation', 'conversations')}.` };
}

const GOAL_TAIL = {
  family: 'about something they mentioned, in each call this week.',
  friend: 'about something that matters to them, each time you talk this week.',
  networking: 'before pitching anything, and send a follow-up message within a day.',
};

// statedGoal is free text from the reflection box; echoing it back reads badly, so the mock sticks to the pattern
function nextStep({ pattern: p, tag } = {}) {
  const tail = GOAL_TAIL[tag] ?? GOAL_TAIL.family;
  const last = Array.isArray(p?.counts) ? p.counts.at(-1) : null;
  if (p?.metric === 'followUps' && Number.isFinite(last)) {
    return { goal: `Ask at least ${plural(Math.round(last) + 1, 'follow-up question', 'follow-up questions')} ${tail}` };
  }
  return { goal: `Ask at least one follow-up question ${tail}` };
}

function followUp({ otherName, hooks, tag } = {}) {
  const name = otherName ? `${otherName.split(/\s+/)[0]}` : '';
  const topic = hooks?.topics?.[0]?.term;
  const event = hooks?.events?.[0];
  const promise = hooks?.commitments?.[0];
  const parts = [`${tag === 'family' ? 'Hola' : 'Hey'}${name ? ` ${name}` : ''}! ${topic ? `Loved hearing about ${topic}.` : 'Really enjoyed talking today.'}`];
  if (event) parts.push(eventLine(event));
  if (promise) parts.push(`And like I said, ${promise.text.replace(/[\s,;:.!?…]*$/, '.')}`);
  return { text: parts.join(' '), hooksUsed: [topic, event?.when, promise?.text].filter(Boolean) };
}

// Picks the warmest reaction and any missed bid, the way a careful reader of the numbers would.
function insight({ note, stats, turns, hooks, rewriteCandidates } = {}) {
  const ts = Array.isArray(turns) ? turns : [];
  const warm = ts.filter(t => t.reaction).sort((a, b) => b.reaction.smileDelta - a.reaction.smileDelta)[0];
  const moments = [];
  if (warm && warm.reaction.smileDelta > 0.03) {
    moments.push({ turnId: warm.turnId, title: 'This landed', observation: `Right after you said this, their smile rose ${Math.round(warm.reaction.smileDelta * 100)} points over baseline.`, why: 'Questions that pick up their words get the warmest reactions; keep doing it.' });
  }
  const bid = hooks?.missedBids?.[0];
  if (bid) moments.push({ turnId: bid.turnId, title: 'Left hanging', observation: `They brought up ${bid.cue} and the next line moved on.`, why: 'One question about it would have kept the thread going.' });
  if (!moments.length && ts[0]) moments.push({ turnId: ts[0].turnId, title: 'Opening', observation: 'The conversation starts here.', why: 'Open with a question about them.' });
  const fu = stats?.afterFollowUps;
  const other = stats?.afterOther;
  const backed = fu?.n && fu.smileDelta != null && (other?.smileDelta == null || fu.smileDelta > other.smileDelta);
  const rewrites = (Array.isArray(rewriteCandidates) ? rewriteCandidates : []).slice(0, 2).map(c => {
    // A topic they kept coming back to beats the longest word ("the thinking part").
    const said = contentWords(c.theySaid);
    const pick = (hooks?.topics ?? []).map(t => t.term.toLowerCase()).find(t => said.has(t))
      ?? [...said].sort((a, b) => b.length - a.length)[0] ?? 'that';
    return { turnId: c.turnId, title: 'Stay with their story', tryInstead: `Wait, tell me more about the ${pick} part?`, because: 'Asking about what they just said keeps them talking before you switch to yourself.' };
  });
  return {
    moments,
    rewrites,
    adviceCheck: note?.suggestion ? [{
      advice: note.suggestion,
      verdict: backed ? 'backed' : fu?.n ? 'partly' : 'not yet',
      evidenceTurnIds: warm ? [warm.turnId] : [],
      reason: fu?.n ? `After your follow-ups their smile moved ${Math.round((fu.smileDelta ?? 0) * 100)} points vs ${other?.smileDelta == null ? 'no data' : `${Math.round(other.smileDelta * 100)} points`} after other lines.` : 'No follow-ups on camera to compare yet.',
    }] : [],
  };
}

export default { classify, coach, review, pattern, nextStep, followUp, insight };
