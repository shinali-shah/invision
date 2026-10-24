import { TAG_FOCUS, FIXED_GOALS } from './context.js';

const SCHEMA = {
  type: 'object',
  properties: { goal: { type: 'string' } },
  required: ['goal'],
  additionalProperties: false,
};

function systemPrompt(tag) {
  return [
    'You write one small goal for the user to try in their conversations this week, based on a trend in how they listen.',
    '',
    'Rules:',
    '- One sentence, second person or imperative ("Ask one follow-up...").',
    '- Small and checkable: the user should be able to say yes or no at the end of the week. Include a count or a frequency.',
    '- Build on the `pattern`: if a number is falling, nudge it back up; if it is rising, keep it going.',
    `- This is for ${tag} conversations. Focus on: ${TAG_FOCUS[tag]}.`,
    '- If `statedGoal` is set, the user already told you what they want to work on; shape the goal around it.',
    '- Only about the user\'s own behavior. Never ask them to change, judge or get anything out of the other person.',
    '',
    `Examples of the right size: ${FIXED_GOALS[tag].map(g => `"${g}"`).join(' ')}`,
  ].join('\n');
}

export async function proposeNextStep({ llm, pattern, tag, statedGoal }) {
  const fallback = FIXED_GOALS[tag][0];
  if (!pattern) return fallback;
  try {
    const { goal } = await llm.json({
      name: 'nextStep',
      schema: SCHEMA,
      system: systemPrompt(tag),
      user: { pattern, tag, statedGoal: statedGoal || null },
      effort: 'low',
    });
    return typeof goal === 'string' && goal.trim() ? goal.trim() : fallback;
  } catch {
    return fallback;
  }
}
