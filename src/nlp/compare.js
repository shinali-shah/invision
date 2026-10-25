// Before/after numbers between two conversations, plus whether last time's suggestion got tried.

import { extractHooks } from './hooks.js';
import { contentWords, isQuestion, overlap, stem } from './text.js';

const METRICS = [
  { key: 'followUps', label: 'Follow-up questions', up: true },
  { key: 'userQuestions', label: 'Questions you asked', up: true },
  { key: 'storiesAfterQuestions', label: 'Stories after your questions', up: true },
  { key: 'userTalkShare', label: 'Your share of the talking', toward: 0.5 },
  { key: 'missedBids', label: 'Missed moments', up: false },
];

// Words every suggestion has in it; matching on these would say "followed" for any question.
const GENERIC = new Set([
  'next', 'time', 'call', 'calls', 'try', 'trying', 'asking', 'ask', 'question', 'questions', 'follow',
  'following', 'mention', 'mentioned', 'mentions', 'talk', 'talking', 'conversation', 'chat', 'more',
  'again', 'something', 'about', 'tell', 'told', 'said', 'pregunta', 'preguntar', 'próxima', 'llamada',
]);
const GENERIC_STEMS = new Set([...GENERIC].map(stem));

const num = v => (Number.isFinite(v) ? v : null);
const round2 = n => Math.round(n * 100) / 100;
const turnsOf = conv => (Array.isArray(conv?.turns) ? conv.turns.filter(t => t && typeof t === 'object') : []);

function hooksOf(conv) {
  if (conv?.hooks) return conv.hooks;
  const turns = turnsOf(conv);
  return turns.length ? extractHooks(turns, conv.userLabel) : null;
}

function userQuestions(conv) {
  return turnsOf(conv).filter(t => t.speaker === conv.userLabel && isQuestion(t.text));
}

function talkShare(conv) {
  let user = 0, total = 0;
  for (const t of turnsOf(conv)) {
    const ms = Math.max(0, (t.endMs ?? 0) - (t.startMs ?? 0));
    total += ms;
    if (t.speaker === conv.userLabel) user += ms;
  }
  return total ? round2(user / total) : null;
}

// Signals win when present; otherwise fall back to what can be counted from the turns.
function metricValue(conv, key) {
  if (!conv) return null;
  const s = conv.signals ?? {};
  const turns = turnsOf(conv);
  switch (key) {
    case 'followUps': {
      if (num(s.followUps) !== null) return s.followUps;
      const detector = hooksOf(conv)?.followUpDetector;
      return Array.isArray(detector) ? detector.filter(f => f.isFollowUp).length : null;
    }
    case 'userQuestions':
      return num(s.userQuestions) ?? (turns.length ? userQuestions(conv).length : null);
    case 'storiesAfterQuestions':
      return num(s.storiesAfterQuestions);
    case 'userTalkShare':
      return num(s.userTalkShare) ?? talkShare(conv);
    case 'missedBids': {
      const bids = hooksOf(conv)?.missedBids;
      return Array.isArray(bids) ? bids.length : null;
    }
    default:
      return null;
  }
}

function isBetter(m, before, after) {
  if (before === null || after === null || before === after) return null;
  if (m.toward !== undefined) {
    const gap = Math.abs(before - m.toward) - Math.abs(after - m.toward);
    return Math.abs(gap) < 1e-9 ? null : gap > 0;
  }
  return m.up ? after > before : after < before;
}

function suggestionCheck(before, after) {
  const note = before?.note;
  const text = typeof note?.suggestion === 'string' ? note.suggestion.trim() : '';
  if (!text || !['shown', 'rewritten'].includes(note.status)) return null;

  const wanted = new Set([...contentWords(text)].filter(s => !GENERIC_STEMS.has(s)));
  const hit = wanted.size && after ? userQuestions(after).find(q => overlap(q.text, wanted).length) : null;
  return { text, followed: !!hit, evidenceTurnId: hit ? hit.turnId : null };
}

const sameName = (a, b) => {
  const x = String(a ?? '').trim().toLowerCase();
  return !!x && x === String(b ?? '').trim().toLowerCase();
};

export function compareConversations(before, after) {
  if (!before) return { previousId: null, previousAt: null, samePerson: false, metrics: [], suggestion: null };

  const metrics = METRICS.map(m => {
    const b = metricValue(before, m.key);
    const a = metricValue(after, m.key);
    return {
      key: m.key,
      label: m.label,
      before: b,
      after: a,
      delta: b === null || a === null ? null : round2(a - b),
      better: isBetter(m, b, a),
    };
  });

  return {
    previousId: before.id ?? null,
    previousAt: before.createdAt ?? null,
    samePerson: sameName(before.otherName, after?.otherName),
    metrics,
    suggestion: suggestionCheck(before, after),
  };
}
