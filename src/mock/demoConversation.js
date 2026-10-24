// Scripted stand-in for Muse's realtime events so the whole demo runs offline.
// A is the grandchild (the user), B is the grandmother. Times are in ms of audio.

const SCRIPT = [
  { speaker: 'A', startMs: 0, endMs: 2800, text: "Hi Abuela! How's your garden doing this week?" },
  { speaker: 'B', startMs: 3200, endMs: 6600, text: 'Good! The tomatoes are finally red, like back in Oaxaca.' },
  { speaker: 'A', startMs: 7000, endMs: 9400, text: 'Oaxaca? Did you grow tomatoes there too?' },
  { speaker: 'B', startMs: 9800, endMs: 17400, text: 'Sí, mija. En Oaxaca teníamos un huerto detrás de la casa. Mi mamá me despertaba temprano para regar antes del calor, y yo me quejaba todo el camino.' },
  { speaker: 'A', startMs: 17800, endMs: 19900, text: '¿Y qué más sembraban en el huerto?' },
  { speaker: 'B', startMs: 20300, endMs: 26900, text: 'Chiles, calabazas y maíz. Una vez una cabra se comió todo el maíz y mi papá la persiguió por todo el pueblo.' },
  { speaker: 'A', startMs: 27300, endMs: 29300, text: '¡Qué risa! ¿Cómo se llamaba la cabra?' },
  { speaker: 'B', startMs: 29700, endMs: 32000, text: 'Pancha. Te cuento más el domingo.' },
];

function eventsFor({ speaker, startMs, endMs, text }, turnId) {
  const words = text.split(' ');
  const span = endMs - startMs;
  const at = f => Math.round(startMs + span * f);
  return [
    { type: 'speechStart', turnId, audioProcessedMs: startMs },
    { type: 'transcript', transcript: words.slice(0, Math.ceil(words.length / 2)).join(' '), final: false, audioProcessedMs: at(0.45) },
    // Partials are cumulative; the second one is nearly the whole line, minus the end punctuation
    { type: 'transcript', transcript: text.replace(/[.!?]+$/, ''), final: false, audioProcessedMs: at(0.85) },
    { type: 'speaker', label: speaker, audioProcessedMs: at(0.9) },
    { type: 'speechEnd', turnId, audioProcessedMs: endMs },
    { type: 'speechComplete', turnId, transcript: text, audioProcessedMs: endMs + 200 },
  ];
}

export const DEMO_EVENTS = Object.freeze(SCRIPT.flatMap((line, i) => eventsFor(line, i + 1)));

const DAY = 86400000;
const wordCount = text => text.trim().split(/\s+/).filter(Boolean).length;

function toTurns(lines) {
  let t = 0;
  return lines.map(([speaker, text, ms], i) => {
    const turn = { turnId: i + 1, speaker, text, startMs: t, endMs: t + ms };
    t += ms + 400;
    return turn;
  });
}

// Same arithmetic the rules layer does, plus the classifier's verdicts baked in.
function seedSignals(turns, { followUpIds, storyIds, reflections }) {
  const user = turns.filter(t => t.speaker === 'A');
  const other = turns.filter(t => t.speaker !== 'A');
  const talk = ts => ts.reduce((n, t) => n + t.endMs - t.startMs, 0);
  const questions = user.filter(t => /[?¿]/.test(t.text)).map(q => {
    const next = turns.find(t => t.turnId === q.turnId + 1);
    const reply = next && next.speaker !== 'A' ? next : null;
    return {
      turnId: q.turnId,
      isFollowUp: followUpIds.includes(q.turnId),
      replyTurnId: reply ? reply.turnId : null,
      replyWords: reply ? wordCount(reply.text) : 0,
      storyShared: storyIds.includes(q.turnId),
    };
  });
  const replies = questions.filter(q => q.replyTurnId !== null);
  const userTalkMs = talk(user);
  const otherTalkMs = talk(other);
  return {
    userQuestions: questions.length,
    userTurns: user.length,
    otherTurns: other.length,
    userTalkMs,
    otherTalkMs,
    userTalkShare: Math.round((userTalkMs / (userTalkMs + otherTalkMs)) * 100) / 100,
    otherAvgAnswerWords: replies.length ? Math.round((replies.reduce((n, q) => n + q.replyWords, 0) / replies.length) * 10) / 10 : 0,
    followUps: questions.filter(q => q.isFollowUp).length,
    reflections,
    storiesAfterQuestions: questions.filter(q => q.storyShared).length,
    questions,
    source: 'muse-spark',
  };
}

const firstTurns = toTurns([
  ['A', 'Hola Abuela, did you have a good week?', 2400],
  ['B', 'Busy. Church on Sunday, and the neighbors came for dinner.', 3600],
  ['A', 'Nice. Are you still going to the market on Saturdays?', 2800],
  ['B', 'Sí, every Saturday.', 1500],
  ['A', "I've been really busy with work, we have a big launch next month.", 3800],
  ['B', 'Ay, no trabajes tanto, mija. I cooked for the neighbors again.', 3000],
  ['A', 'What did you cook for the neighbors?', 2200],
  ['B', 'Mole, like my mother used to make. It took all morning, but everybody asked for more and nobody left anything on the plate.', 6200],
]);

const secondTurns = toTurns([
  ['A', 'Hi Abuela! What are you up to today?', 2200],
  ['B', 'Planting the tomatoes. My knees complain, pero bueno.', 3000],
  ['A', 'What kind of tomatoes are you planting this year?', 2600],
  ['B', 'Los grandes, the ones from the seeds my sister sent me from home. She saves them every year in little paper envelopes with the date written on them.', 6800],
  ['A', 'Your sister still saves the seeds? Since when?', 2500],
  ['B', 'Since we were girls. Our father taught her, and she never stopped. When I moved here, the first thing she gave me was a jar of seeds wrapped in a dish towel.', 7400],
  ['A', 'Seeds in a dish towel, that makes me want to call her.', 2600],
  ['B', 'Llámala, she would love that.', 1600],
]);

const now = Date.now();

export const SEED_CONVERSATIONS = Object.freeze([
  {
    tag: 'family',
    otherName: 'Abuela',
    createdAt: new Date(now - 6 * DAY).toISOString(),
    seeded: true,
    turns: firstTurns,
    userLabel: 'A',
    reflection: 'I felt like I talked about work too much.',
    signals: seedSignals(firstTurns, { followUpIds: [7], storyIds: [7], reflections: 0 }),
    note: {
      text: 'You asked 3 questions and 1 was a follow-up. You heard 1 story after your questions. Next call, try asking about the mole she mentioned.',
      suggestion: 'Next call, try asking about the mole she mentioned.',
      citedTurnIds: [7],
      status: 'shown',
      source: 'muse-spark',
    },
  },
  {
    tag: 'family',
    otherName: 'Abuela',
    createdAt: new Date(now - 3 * DAY).toISOString(),
    seeded: true,
    turns: secondTurns,
    userLabel: 'A',
    reflection: 'Better. I want to ask more about where she grew up.',
    signals: seedSignals(secondTurns, { followUpIds: [3, 5], storyIds: [3, 5], reflections: 1 }),
    note: {
      text: 'You asked 3 questions and 2 were follow-ups. You heard 2 stories after your follow-ups. Next call, try asking about the home her sister sends the seeds from.',
      suggestion: 'Next call, try asking about the home her sister sends the seeds from.',
      citedTurnIds: [3, 5],
      status: 'shown',
      source: 'muse-spark',
    },
  },
]);
