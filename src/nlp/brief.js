// What to have in mind before talking to someone again, from what came up last time(s).

import { extractHooks } from './hooks.js';
import { contentWords, overlap } from './text.js';

const MAX_ITEMS = 4;
// So one chatty conversation full of promises doesn't crowd out everything else.
const MAX_PER_KIND = 2;

function hooksOf(conv) {
  if (conv?.hooks) return conv.hooks;
  return Array.isArray(conv?.turns) && conv.turns.length ? extractHooks(conv.turns, conv.userLabel) : null;
}

const quoted = s => `“${String(s).trim()}”`;
const idOf = conv => String(conv?.id ?? '');

function noteSuggestion(conv) {
  const note = conv?.note;
  if (!note || note.status === 'dropped') return '';
  return typeof note.suggestion === 'string' ? note.suggestion.trim() : '';
}

export function buildBrief({ otherName, conversations } = {}) {
  const convs = (Array.isArray(conversations) ? conversations : []).filter(Boolean);
  if (!convs.length) return null;

  const latest = convs.at(-1);
  const latestHooks = hooksOf(latest) ?? {};
  const newestFirst = [...convs].reverse();

  const commitments = (latestHooks.commitments ?? []).slice(0, MAX_PER_KIND).map(c => ({
    kind: 'commitment', text: `Follow through: you said ${quoted(c.text)}`, conversationId: idOf(latest), turnId: c.turnId ?? null,
  }));
  const events = (latestHooks.events ?? []).slice(0, MAX_PER_KIND).map(e => ({
    kind: 'event', text: `Ask how it went: ${quoted(e.text)}`, conversationId: idOf(latest), turnId: e.turnId ?? null,
  }));

  // Newest conversation's top topic that the items above don't already mention.
  const covered = contentWords([...commitments, ...events].map(i => i.text).join(' '));
  let topic = null;
  for (const conv of newestFirst) {
    const t = (hooksOf(conv)?.topics ?? []).find(x => !overlap(x.term, covered).length);
    if (t) {
      topic = {
        kind: 'topic', text: `They opened up about ${t.term}. Bring it up again.`,
        conversationId: idOf(conv), turnId: t.turnIds?.[0] ?? null,
      };
      break;
    }
  }

  const withNote = newestFirst.find(noteSuggestion);
  const suggestion = withNote
    ? { kind: 'suggestion', text: noteSuggestion(withNote), conversationId: idOf(withNote), turnId: null }
    : null;

  const seen = new Set();
  const items = [...commitments, ...events, topic, suggestion].filter(item => {
    if (!item) return false;
    const key = item.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_ITEMS);

  if (!items.length) return null;
  return {
    otherName: String(otherName ?? latest.otherName ?? ''),
    lastMetAt: latest.createdAt ?? null,
    conversations: convs.length,
    items,
  };
}
