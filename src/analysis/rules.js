// Plain counting over the transcript. No model involved, so this is also the fallback.

const QUESTION = /[?¿]/;

export function wordCount(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;
const duration = t => Math.max(0, (t.endMs ?? 0) - (t.startMs ?? 0));

export function computeRuleSignals(turns, userLabel) {
  let userTurns = 0, otherTurns = 0, userTalkMs = 0, otherTalkMs = 0;
  const questions = [];

  turns.forEach((turn, i) => {
    // Anything not tagged as the user is the other side, 'unknown' included.
    if (turn.speaker !== userLabel) {
      otherTurns++;
      otherTalkMs += duration(turn);
      return;
    }
    userTurns++;
    userTalkMs += duration(turn);
    if (!QUESTION.test(turn.text)) return;

    // Only the very next turn counts as the answer.
    const next = turns[i + 1];
    const reply = next && next.speaker !== userLabel ? next : null;
    questions.push({
      turnId: turn.turnId,
      isFollowUp: null,
      replyTurnId: reply ? reply.turnId : null,
      replyWords: reply ? wordCount(reply.text) : 0,
      storyShared: null,
    });
  });

  const answered = questions.filter(q => q.replyTurnId !== null);
  const totalMs = userTalkMs + otherTalkMs;

  return {
    userQuestions: questions.length,
    userTurns,
    otherTurns,
    userTalkMs,
    otherTalkMs,
    userTalkShare: totalMs ? round(userTalkMs / totalMs, 2) : 0,
    otherAvgAnswerWords: answered.length
      ? round(answered.reduce((sum, q) => sum + q.replyWords, 0) / answered.length, 1)
      : 0,
    followUps: null,
    reflections: null,
    storiesAfterQuestions: null,
    questions,
    source: 'rules-only',
  };
}
