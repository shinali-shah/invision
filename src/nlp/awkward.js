// What a smile can't tell you: the moments that read as awkward from the words and the timing.
// Each flag names who did it, why it's flagged, and the line it came from.

import { wordCount, isQuestion } from './text.js';

const CUT_IN_MS = 100;
// Fluent turn-taking overlaps by a tenth of a second or two; only a real barge-in counts.
const CUT_IN_OVERLAP_MS = 250;

// \b is ASCII-only even with the u flag, so it misses words ending in accented letters.
const word = alts => new RegExp(`(?<!\\p{L})(?:${alts})(?!\\p{L})`, 'iu');

// A rumour needs a third person in it: "I heard that song" and "my parents' divorce" are not gossip.
const THIRD = '(?:she|he|they)';
const GOSSIP = word([
  'rumou?rs?', 'gossip', 'chisme', 'dicen que', 'me dijeron que', 'engañ\\w+',
  `i heard (?:that )?${THIRD}`, `apparently ${THIRD}`, `is it true (?:that )?${THIRD}`,
  `${THIRD} (?:\\w+ )?(?:cheated|hooked up|broke up|dumped|got divorced|had an affair)`,
  'cheat(?:ed|ing|s)? on (?:her|him|his|their)', '(?:her|his|their) (?:affair|divorce|ex)',
].join('|'));
// Hearsay that only reads as gossip once a rumour is already on the table ("that's what I heard").
const HEARSAY = word([
  "that['’]s what i heard", 'i heard (?:that|about)', 'apparently', 'is it true', "aren['’]t you the", "you['’]re the (?:one|guy|girl)",
  'drama(?! (?:club|class|classes|school|teacher|major|department|kids?|series|show|queen))',
  'broke up with', 'dumped', 'hooked up', 'divorc\\w*', 'affair',
].join('|'));

const HEDGE = word("i['’]m not sure|i don['’]t know|idk|i guess|not really|no sé|no se|pues no sé");
const CONTRADICTS = /\b(?:yeah|yes|sí),?\s+i['’]?m sure\.?\s+i['’]?m not sure/i;
const UNDERSELL = word("(?:just|low-?key|kinda) bored|i['’]m (?:so )?boring|nothing much|nothing really|i don['’]t really do anything|it['’]s whatever");
// A line that stops on a function word was still going. A missing full stop alone proves nothing:
// the ASR drops it on about half the lines it closes at a speaker change.
const OPEN_END = /(?:\b(?:and|but|so|because|like|i['’]m|i am|the|a|an|my|your|their|using|with|for|to|of|in|on|at|about|from|that|which|when|if|was|is|are|were|would|could|should|going|gonna|trying|kind of|sort of|very|really|just|also|then|or|y|pero|que|de|en|con|para|por)|,)\s*$/i;

// "Um I'm a wait aren't you…": their sentence stops dead and a new voice starts. When the voice
// separation glues two people into one line, this is the seam. "I'm actually from Boston" is not one,
// and neither is "I'm a wait, no, a sophomore": the new voice has to address them within a few words,
// before the sentence ends.
const BREAK = /(?:\b(?:i['’]m|i am|it['’]s|my|the|a|an|and|but|so)|,)\s+(?=(?:wait|hold on|oh wait|no wait)\b)/i;
const TO_YOU = /^(?:[^.!?\s]+\s+){0,5}?(?:aren['’]t you|you['’]re|are you|you|your)(?!\p{L})/iu;

// "Bye", "see you", "take care": short because it's over, not because it ran out.
const FAREWELL = word("bye|goodbye|see you|see ya|later|take care|good ?night|talk soon|nice meeting you|adiós|adios|chao|ciao|nos vemos|cuídate|cuidate|hasta");

export const AWKWARD_LABELS = {
  'cut-in': 'Cut in',
  gossip: 'Gossip about someone else',
  'short-reply': 'Short reply, no question back',
  hedge: 'Hedging',
  fizzle: 'Fizzled out',
  undersell: 'Undersold yourself',
};

export function detectAwkward(turns, userLabel) {
  const ts = Array.isArray(turns) ? turns.filter(t => t && typeof t === 'object') : [];
  const isYou = t => t.speaker === userLabel;
  const flags = [];
  const seams = []; // their lines with you merged in: { turnId, theirs, yours }
  const flag = (t, kind, evidence, weight) => flags.push({ turnId: t.turnId, who: isYou(t) ? 'you' : 'them', kind, label: AWKWARD_LABELS[kind], evidence, weight });
  let rumourSeen = false;

  ts.forEach((t, i) => {
    const text = String(t.text ?? '');
    const prev = ts[i - 1];

    if (isYou(t) && prev && !isYou(prev)) {
      const gap = (t.startMs ?? 0) - (prev.endMs ?? 0);
      // A tight gap alone is normal turn-taking; it only counts if they were mid-sentence.
      if (gap < -CUT_IN_OVERLAP_MS) flag(t, 'cut-in', `You started talking ${(-gap / 1000).toFixed(1)} s before they finished`, 3);
      else if (gap <= CUT_IN_MS && OPEN_END.test(prev.text ?? '')) flag(t, 'cut-in', 'You came in while their sentence was still open', 3);
    }

    // Their line breaks off and the rest is said *to* them: that's you, merged into their turn.
    const seam = !isYou(t) ? text.search(BREAK) : -1;
    const after = seam >= 0 ? text.slice(seam) : '';
    const youCutIn = seam >= 0 && TO_YOU.test(after);
    if (youCutIn) {
      const at = seam + text.match(BREAK)[0].length;
      seams.push({ turnId: t.turnId, theirs: text.slice(0, at).trim(), yours: text.slice(at).trim() });
      const cut = text.slice(Math.max(0, seam - 12), at).trim();
      flags.push({ turnId: t.turnId, who: 'you', kind: 'cut-in', label: AWKWARD_LABELS['cut-in'], evidence: `Their sentence stops at “…${cut}” and you start talking`, weight: 3 });
    }

    const rumour = GOSSIP.exec(text) ?? (rumourSeen ? HEARSAY.exec(text) : null);
    if (rumour) {
      rumourSeen = true;
      const yours = isYou(t) || (youCutIn && rumour.index >= seam);
      flags.push({ turnId: t.turnId, who: yours ? 'you' : 'them', kind: 'gossip', label: AWKWARD_LABELS.gossip,
        evidence: `“${rumour[0]}”: a story about someone who isn't here`, weight: yours ? 4 : 2 });
    }

    if (!isYou(t)) {
      const asked = prev && isYou(prev) && wordCount(prev.text) >= 5;
      if (asked && wordCount(text) <= 4 && !isQuestion(text)) flag(t, 'short-reply', `“${text.trim()}” after your ${wordCount(prev.text)}-word line`, 2);
      if (CONTRADICTS.test(text)) flag(t, 'hedge', 'Said they were sure, then that they weren\'t', 2);
      else if (HEDGE.test(text)) flag(t, 'hedge', `“${text.match(HEDGE)[0]}”`, 1);
    }

    if (isYou(t) && UNDERSELL.test(text)) flag(t, 'undersell', `“${text.match(UNDERSELL)[0]}” is what they'll remember about you`, 2);
  });

  // The last few lines all tiny: the conversation ran out rather than ended.
  const tail = ts.slice(-3);
  if (tail.length === 3 && ts.length >= 6 && tail.every(t => wordCount(t.text) <= 3) && !tail.some(t => FAREWELL.test(t.text ?? ''))) {
    flag(tail.at(-1), 'fizzle', `The last ${tail.length} lines were ${tail.map(t => `“${String(t.text).trim()}”`).join(', ')}`, 2);
  }

  const score = Math.min(100, flags.reduce((n, f) => n + f.weight * 10, 0));
  return { flags, score, seams, worst: [...flags].filter(f => f.who === 'you').sort((a, b) => b.weight - a.weight)[0] ?? null };
}
