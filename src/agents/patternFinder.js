const SCHEMA = {
  type: 'object',
  properties: { statement: { type: 'string' } },
  required: ['statement'],
  additionalProperties: false,
};

const SYSTEM = [
  'You describe one trend in how the user has been listening across their recent conversations, in a single sentence.',
  '',
  'You get `metric`, `counts` (one value per conversation, oldest first) and `tags` (family, friend or networking, same order).',
  'Metrics: followUps = follow-up questions the user asked per conversation; userQuestions = questions the user asked per conversation.',
  '',
  'Rules:',
  '- Write in second person ("Your follow-up questions...").',
  '- Include the first and the last value of `counts` as digits, exactly as given.',
  '- Describe the direction plainly: rose, fell, or held steady. Do not add numbers that are not in `counts`.',
  '- Never say the user is good or bad at conversation, and never praise or criticise. Just state the trend.',
  '- Never mention or judge the people they talked to.',
  '',
  'Example: "Your follow-up questions rose from 1 to 3 per conversation over the last week."',
].join('\n');

// Plain includes() would let "10" satisfy a required "1".
const citesNumber = (statement, n) => new RegExp(`(^|[^\\d.])${String(n).replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(statement);

export async function findPattern({ llm, conversations }) {
  const analysed = conversations
    .filter(c => c.signals)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (analysed.length < 3) return null;

  const metric = analysed.every(c => c.signals.followUps != null) ? 'followUps' : 'userQuestions';
  const counts = analysed.map(c => c.signals[metric]);
  const tags = analysed.map(c => c.tag);

  let statement;
  try {
    ({ statement } = await llm.json({ name: 'pattern', schema: SCHEMA, system: SYSTEM, user: { metric, counts, tags }, effort: 'low' }));
  } catch {
    return null;
  }
  if (typeof statement !== 'string') return null;
  statement = statement.trim();
  if (!citesNumber(statement, counts[0]) || !citesNumber(statement, counts.at(-1))) return null;

  return { statement, metric, counts };
}
