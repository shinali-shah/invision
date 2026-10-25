import { computeRuleSignals } from './analysis/rules.js';
import { classifySignals } from './analysis/classify.js';
import { generateNote } from './agents/coach.js';
import { reviewNote } from './agents/reviewer.js';
import { findPattern } from './agents/patternFinder.js';
import { proposeNextStep } from './agents/nextStep.js';
import { draftFollowUp, templateFollowUp } from './agents/followUp.js';
import { extractHooks } from './nlp/hooks.js';

const TOO_SHORT = Object.freeze({
  text: null, suggestion: null, citedTurnIds: [], status: 'dropped', reason: 'too_short', source: 'fallback',
});

// A message the user already sent or rewrote in their own words is theirs; no draft replaces it.
const userOwned = followUp => !!followUp && (followUp.status === 'sent' || followUp.source === 'edited');

// Steps 4–6 of the spec: analyze → coach → review → remember.
export async function processConversation({ store, llm, log, id, reflection }) {
  let convo = store.updateConversation(id, { reflection: reflection ?? '' });
  const turns = convo.turns ?? [];
  const userLabel = convo.userLabel ?? turns[0]?.speaker ?? 'A';

  const ruleSignals = computeRuleSignals(turns, userLabel);
  const hooks = extractHooks(turns, userLabel, { otherName: convo.otherName });
  store.updateConversation(id, { hooks });
  log('nlp', 'info', 'hooks extracted', {
    topics: hooks.topics.map(t => t.term), events: hooks.events.length,
    commitments: hooks.commitments.length, missedBids: hooks.missedBids.length,
  });

  if (turns.length < 2) {
    log('pipeline', 'info', `conversation ${id.slice(0, 8)} too short to coach (${turns.length} turns)`);
    convo = store.updateConversation(id, { signals: ruleSignals, note: TOO_SHORT });
    await refreshMemory({ store, llm, log });
    return convo;
  }

  // The follow-up only needs the hooks, so it drafts while the slower classify → coach → review chain runs.
  // Both detached promises are caught right here: a rejection sitting unawaited during coaching would
  // take the process down.
  const drafting = userOwned(convo.followUp)
    ? Promise.resolve(convo.followUp)
    : writeFollowUp({ llm, log, convo: { ...convo, hooks, userLabel } }).catch(err => {
      log('followUp', 'warn', `follow-up failed, using the template: ${err.message}`);
      return { ...templateFollowUp({ hooks, otherName: convo.otherName, tag: convo.tag }), status: 'draft', sentAt: null };
    });

  const signals = withDetector(
    await classifySignals({ llm, turns, userLabel, tag: convo.tag, ruleSignals }),
    hooks.followUpDetector,
    log,
  );

  store.updateConversation(id, { signals });
  // The trend only needs the counts, so it runs next to coaching rather than after it.
  const remembering = refreshMemory({ store, llm, log }).catch(err => log('pattern', 'warn', `memory refresh failed: ${err.message}`));
  // The tag may have been switched while we were classifying; coach for the one that's there now.
  const tag = store.getConversation(id)?.tag ?? convo.tag;
  const note = await coachAndReview({ store, llm, log, convo: { ...convo, tag, signals, userLabel, hooks } });
  convo = store.updateConversation(id, { note });

  const [followUp] = await Promise.all([drafting, remembering]);
  // Coaching takes a while; if the user edited or sent the message meanwhile, that one stays.
  const current = store.getConversation(id)?.followUp;
  return store.updateConversation(id, { followUp: userOwned(current) ? current : followUp });
}

// The lexical detector is the fallback when Muse Spark is down, and a cross-check when it isn't.
export function withDetector(signals, detector, log) {
  const byTurn = new Map((detector ?? []).map(d => [d.turnId, d]));
  if (signals.source === 'rules-only') {
    const questions = signals.questions.map(q => ({ ...q, isFollowUp: byTurn.get(q.turnId)?.isFollowUp ?? null }));
    log('nlp', 'warn', 'Muse Spark analysis failed, follow-ups from the lexical detector');
    return { ...signals, questions, followUps: questions.filter(q => q.isFollowUp === true).length, source: 'rules-only' };
  }
  const judged = signals.questions.filter(q => q.isFollowUp !== null && byTurn.has(q.turnId));
  const agree = judged.filter(q => byTurn.get(q.turnId).isFollowUp === q.isFollowUp).length;
  log('nlp', 'info', `signals classified; detector agrees with Muse Spark on ${agree} of ${judged.length} questions`,
    { questions: signals.userQuestions, followUps: signals.followUps });
  return { ...signals, detectorAgreement: { agree, of: judged.length } };
}

export async function writeFollowUp({ llm, log, convo }) {
  const draft = await draftFollowUp({
    llm, tag: convo.tag, otherName: convo.otherName, hooks: convo.hooks, turns: convo.turns, userLabel: convo.userLabel,
  });
  log('followUp', draft.source === 'template' ? 'warn' : 'info',
    draft.source === 'template' ? 'follow-up from template (Muse draft missing or not grounded)' : 'follow-up drafted',
    { hooksUsed: draft.hooksUsed });
  return { ...draft, status: 'draft', sentAt: null };
}

// Demo moment 1:45: same signals, different relationship, new note.
export async function recoach({ store, llm, log, id, tag }) {
  const convo = store.updateConversation(id, { tag });
  if (!convo.signals || (convo.turns ?? []).length < 2) return convo;
  log('pipeline', 'info', `re-coaching ${id.slice(0, 8)} as ${tag}`);
  const note = await coachAndReview({ store, llm, log, convo });
  return store.updateConversation(id, { note });
}

async function coachAndReview({ store, llm, log, convo }) {
  const draft = await generateNote({
    llm,
    tag: convo.tag,
    signals: convo.signals,
    turns: convo.turns,
    userLabel: convo.userLabel,
    reflection: convo.reflection ?? '',
    hooks: convo.hooks,
    lastNotes: store.recentNotes(3, convo.id),
  });
  if (draft.status === 'dropped') log('coach', 'warn', 'coaching agent failed, showing raw counts');
  else log('coach', 'info', 'note drafted');

  const note = await reviewNote({ llm, note: draft, signals: convo.signals, otherName: convo.otherName });
  if (draft.status !== 'dropped') {
    const level = note.status === 'dropped' ? 'warn' : 'info';
    log('review', level, `reviewer: ${note.status === 'shown' ? 'pass' : note.status}`);
  }
  return note;
}

export async function refreshMemory({ store, llm, log }) {
  const conversations = store.listConversations();
  const pattern = await findPattern({ llm, conversations });
  store.setKv('pattern', pattern);

  if (!pattern) {
    const processed = conversations.filter(c => c.signals).length;
    if (processed >= 3) log('pattern', 'warn', 'pattern finder failed, showing signal table');
    return { pattern: null, nextStep: store.latestNextStep() };
  }
  log('pattern', 'info', pattern.statement);

  const live = step => !!step && ['proposed', 'accepted'].includes(step.status);
  let nextStep = store.latestNextStep();
  if (!live(nextStep)) {
    const latest = conversations.at(-1);
    const text = await proposeNextStep({ llm, pattern, tag: latest?.tag ?? 'family', statedGoal: latest?.reflection ?? '' });
    // Two refreshes can overlap (a double tap on Process, a delete mid-coaching); the first proposal wins.
    nextStep = store.latestNextStep();
    if (!live(nextStep)) {
      nextStep = store.createNextStep(text);
      log('nextStep', 'info', `proposed: ${text}`);
    }
  }
  return { pattern, nextStep };
}
