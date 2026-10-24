import { SEED_CONVERSATIONS } from './mock/demoConversation.js';

// The demo needs three conversations for the memory view; two are seeded, one is recorded live.
export function seedDemo(store) {
  if (store.listConversations().some(c => c.seeded)) return;
  for (const s of SEED_CONVERSATIONS) {
    const c = store.createConversation({ tag: s.tag, otherName: s.otherName, seeded: true });
    store.updateConversation(c.id, {
      createdAt: s.createdAt,
      turns: s.turns,
      userLabel: s.userLabel,
      reflection: s.reflection ?? '',
      signals: s.signals,
      note: s.note,
    });
  }
}
