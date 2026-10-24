export const TAGS = ['family', 'friend', 'networking'];

// Copy is verbatim from the spec, so keep it in sync with the UI.
export const TAG_FOCUS = {
  family: 'Phrases to keep the conversation going, cultural context for what they said, a vocab list from words that came up',
  friend: 'Follow-up questions, remembering what matters to them, following through',
  networking: 'Clear questions, listening before pitching, a drafted follow-up message',
};

// Used when there's no pattern yet or the next-step writer is down. Each one is something
// the user can check off after a week without anyone grading the other person.
export const FIXED_GOALS = {
  family: [
    'Ask one follow-up about something they mentioned, in each call this week.',
    'Pick one word or phrase that came up and use it in your next call.',
    'Ask about one place or person from a story they told you before.',
  ],
  friend: [
    'Ask one follow-up question before sharing your own news, in each conversation this week.',
    'Bring up one thing they told you last time and ask how it went.',
    'Follow through on one plan or promise you made in a recent conversation.',
  ],
  networking: [
    'Ask two clear questions about their work before you mention yours, in each conversation this week.',
    'Let them finish answering before you pitch, at least once per conversation.',
    'Send a follow-up message within a day that mentions one thing they said.',
  ],
};
