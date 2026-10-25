# Follow-up, Before/After, Pre-meeting Brief — Contract

Three features on top of the existing app. The judging bar: AI must be essential but this must not be
an LLM wrapper. So the deterministic NLP layer (`src/nlp/`) does the extraction and measurement, and
Muse Spark only does what needs language judgment (follow-up classification, phrasing the message),
always grounded in and checked against what the NLP layer found.

## Shared types

```js
// Stored on each conversation as `hooks`. Built by extractHooks(); no model involved.
Hooks = {
  topics:      [{ term: string, turnIds: number[], weight: number }],    // ≤5, from the OTHER person's lines, best first
  events:      [{ text: string, when: string, turnId: number }],         // ≤3, upcoming things THEY mentioned ("my interview next week")
  commitments: [{ text: string, turnId: number }],                       // ≤3, promises the USER made ("I'll send you the article")
  missedBids:  [{ turnId: number, replyTurnId: number, cue: string }],   // they shared something, user's next line ignored it
  highlights:  [{ turnId: number, words: number }],                      // ≤2, where they talked longest (opened up)
  followUpDetector: [{ turnId: number, isFollowUp: boolean, overlap: string[] }], // per user question
}

Comparison = {
  previousId: string | null,             // null => nothing to compare against (metrics: [])
  previousAt: string | null,
  sameperson: boolean,                    // previous convo had the same otherName (case-insensitive)
  metrics: [{ key, label, before, after, delta, better: true | false | null }],
  suggestion: { text: string, followed: boolean, evidenceTurnId: number | null } | null,
}
// metric keys, in this order: followUps, userQuestions, storiesAfterQuestions, userTalkShare, missedBids
// better: followUps/userQuestions/storiesAfterQuestions up = better; missedBids down = better;
//         userTalkShare: closer to 0.5 = better. Equal or either side null => null. delta = after - before (null if either null).

Brief = {
  otherName: string,
  lastMetAt: string,
  conversations: number,
  items: [{ kind: 'commitment' | 'event' | 'topic' | 'suggestion', text: string, conversationId: string, turnId: number | null }], // ≤4, in that kind order
}

FollowUp = { text: string, hooksUsed: string[], source: 'muse-spark' | 'template', status: 'draft' | 'sent', sentAt: string | null }
```

## NLP module (src/nlp/) — pure functions, EN + ES

- `text.js`: `tokens(text)`, `contentWords(text) -> Set<string>` (lowercase, ≥4 letters, EN+ES stopwords, light stemming so tomato/tomatoes, sembraban/sembrar match), `overlap(a, b) -> string[]`.
- `hooks.js`: `extractHooks(turns, userLabel) -> Hooks`, `detectFollowUps(turns, userLabel) -> Hooks.followUpDetector`.
- `compare.js`: `compareConversations(before, after) -> Comparison` (Conversation objects with turns, userLabel, signals, note, hooks).
- `brief.js`: `buildBrief({ otherName, conversations }) -> Brief | null` (conversations with that person, oldest first; null when none have content).

## API

- Conversation objects gain `hooks: Hooks | null` and `followUp: FollowUp | null`.
- `GET  /api/conversations/:id/compare` → `Comparison` (previous = most recent earlier processed convo with same otherName, else most recent earlier processed convo).
- `POST /api/conversations/:id/follow-up` body `{}` → generate draft if none / `{ regenerate: true }` → new draft / `{ text }` → save edit. Returns `FollowUp`.
- `POST /api/conversations/:id/follow-up/sent` → marks sent, returns `FollowUp`.
- `GET  /api/brief?name=Priya` → `{ brief: Brief | null }`.
- `POST /api/stage/focus` also accepts `otherName` (string) so the stage can show the brief on the start view.
- Processing (`POST /process`) now computes hooks and drafts the follow-up, so the response already has both.
- Stage events: unchanged types; follow-up changes publish `{type:'conversation', conversation}`; focus events carry `otherName`.
