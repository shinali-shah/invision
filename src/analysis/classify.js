// Muse Spark labels the user's questions (follow-up or not) and whether a story came back.
// If anything goes wrong we keep the rule counts and move on.

const SYSTEM = `You analyse a two-person conversation transcript to help the user become a better listener.
The user is the speaker labelled userLabel. Judge only the user's behaviour.
For each turnId in "questions" (each is a question the user asked):
- isFollowUp: true if the question builds on something the other person just said, false if it changes topic or is generic.
- storyShared: true if the other person's reply to it contains a story or anecdote, otherwise false. This is the only thing you report about the other person's lines.
Also count "reflections": user turns that paraphrase or name back what the other person said or felt.
Never evaluate, score or describe the other person. Return only the turnIds you were given.`;

const SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          turnId: { type: 'integer' },
          isFollowUp: { type: 'boolean' },
          storyShared: { type: 'boolean' },
        },
        required: ['turnId', 'isFollowUp', 'storyShared'],
        additionalProperties: false,
      },
    },
    reflections: { type: 'integer' },
  },
  required: ['questions', 'reflections'],
  additionalProperties: false,
};

export async function classifySignals({ llm, turns, userLabel, tag, ruleSignals }) {
  try {
    const out = await llm.json({
      name: 'classify',
      schema: SCHEMA,
      system: SYSTEM,
      user: { tag, userLabel, turns, questions: ruleSignals.questions.map(q => q.turnId) },
    });
    return mergeSignals(ruleSignals, out);
  } catch {
    return ruleSignals;
  }
}

export function mergeSignals(ruleSignals, out) {
  if (!Array.isArray(out?.questions) || !Number.isInteger(out.reflections)) {
    throw new Error('classify: unexpected response shape');
  }

  const byTurn = new Map();
  for (const q of out.questions) {
    if (q && typeof q.isFollowUp === 'boolean' && typeof q.storyShared === 'boolean') byTurn.set(q.turnId, q);
  }

  // Questions the model skipped stay null rather than being guessed.
  const questions = ruleSignals.questions.map(q => {
    const hit = byTurn.get(q.turnId);
    return hit ? { ...q, isFollowUp: hit.isFollowUp, storyShared: hit.storyShared } : q;
  });

  return {
    ...ruleSignals,
    questions,
    followUps: questions.filter(q => q.isFollowUp === true).length,
    storiesAfterQuestions: questions.filter(q => q.storyShared === true).length,
    reflections: Math.max(0, out.reflections),
    source: 'muse-spark',
  };
}
