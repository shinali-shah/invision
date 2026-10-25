import { SEED_CONVERSATIONS } from './mock/demoConversation.js';
import { extractHooks } from './nlp/hooks.js';

// The demo needs three conversations for the memory view; two are seeded, one is recorded live.
// Seeded rows are refreshed on every boot so script changes reach an existing database.
export function seedDemo(store) {
  const existing = store.listConversations().filter(c => c.seeded);
  SEED_CONVERSATIONS.forEach((s, i) => {
    const id = existing[i]?.id ?? store.createConversation({ tag: s.tag, otherName: s.otherName, seeded: true }).id;
    store.updateConversation(id, {
      tag: s.tag,
      createdAt: s.createdAt,
      turns: s.turns,
      userLabel: s.userLabel,
      reflection: s.reflection ?? '',
      signals: s.signals,
      note: s.note,
    });
  });
}

// Hooks are cheap and the heuristics keep improving, so recompute them for everything on boot.
export function refreshHooks(store) {
  for (const c of store.listConversations()) {
    if (c.turns?.length && c.userLabel) store.updateConversation(c.id, { hooks: extractHooks(c.turns, c.userLabel, { otherName: c.otherName }) });
  }
}
