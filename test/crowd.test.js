import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelTurns, inferLabels, speechTurns } from '../src/transcribe/crowd.js';

// Cue samples every 125 ms (8 fps) from `from` to `to`, with the given flags.
function cues(from, to, { face = true, theirs = false, mine = false, mouth = 0 } = {}) {
  const out = [];
  for (let t = from; t < to; t += 125) out.push({ t, face, mouth, theirs, mine });
  return out;
}

const turn = (turnId, speaker, startMs, endMs, text = `line ${turnId}`) => ({ turnId, speaker, text, startMs, endMs });

test('a clean two-speaker exchange is labelled you / them from the cues', () => {
  const turns = [turn(1, 'A', 0, 2000), turn(2, 'B', 2200, 5000), turn(3, 'A', 5200, 7000)];
  const track = [
    ...cues(0, 2100, { mine: true }),
    ...cues(2100, 5100, { theirs: true }),
    ...cues(5100, 7100, { mine: true }),
  ];
  const out = labelTurns(turns, track);
  assert.deepEqual(out.map(t => t.source), ['you', 'them', 'you']);
  assert.ok(out.every(t => t.confidence >= 0.9), JSON.stringify(out.map(t => t.confidence)));
  // the originals are untouched and everything else on the turn survives
  assert.equal(turns[0].source, undefined);
  assert.equal(out[1].text, 'line 2');
});

test('a bystander line with a face in view but no mouth motion and a quiet mic is crowd', () => {
  const turns = [turn(1, 'A', 0, 2000), turn(2, 'C', 2500, 4000), turn(3, 'B', 4500, 7000)];
  const track = [
    ...cues(0, 2250, { mine: true }),
    ...cues(2250, 4250),                 // face there, nobody we know is talking
    ...cues(4250, 7100, { theirs: true }),
  ];
  const out = labelTurns(turns, track);
  assert.deepEqual(out.map(t => t.source), ['you', 'crowd', 'them']);
  assert.ok(out[1].confidence > 0.5);
});

test('a window with no face in the cue track is unknown, not crowd', () => {
  const turns = [turn(1, 'C', 1000, 3000)];
  const out = labelTurns(turns, cues(0, 4000, { face: false }));
  assert.equal(out[0].source, 'unknown');
  assert.equal(out[0].confidence, 0);
});

test('a turn outside the cue track, or with no duration, is unknown', () => {
  const turns = [turn(1, 'A', 10000, 12000), { turnId: 2, speaker: 'B', text: 'x', startMs: 0, endMs: 0 }];
  const out = labelTurns(turns, cues(0, 3000, { mine: true }));
  assert.deepEqual(out.map(t => t.source), ['unknown', 'unknown']);
});

test('no cues at all leaves every turn unknown', () => {
  const out = labelTurns([turn(1, 'A', 0, 1000)], []);
  assert.equal(out[0].source, 'unknown');
  assert.deepEqual(labelTurns([turn(1, 'A', 0, 1000)], null).map(t => t.source), ['unknown']);
});

test('coverage is a fraction of the turn: a quarter-covered theirs misses the default 0.5 bar, the bar is tunable', () => {
  const turns = [turn(1, 'B', 0, 4000)];
  const track = [...cues(0, 1000, { theirs: true }), ...cues(1000, 4000)];
  assert.equal(labelTurns(turns, track)[0].source, 'crowd');
  assert.equal(labelTurns(turns, track, { minOverlap: 0.25 })[0].source, 'them');
});

test('a turn the cues almost reach is unknown rather than crowd (keep lines we cannot judge)', () => {
  const turns = [turn(1, 'B', 0, 4000)];
  const track = [...cues(0, 1900, { theirs: true }), ...cues(1900, 4000)];
  assert.equal(labelTurns(turns, track)[0].source, 'unknown');
});

test('when both cues cover a turn the bigger one wins; a dead heat is unknown', () => {
  const turns = [turn(1, 'A', 0, 4000)];
  const both = [...cues(0, 4000, { theirs: true, mine: true })];
  assert.equal(labelTurns(turns, both)[0].source, 'unknown');
  const more = [...cues(0, 3000, { theirs: true, mine: true }), ...cues(3000, 4000, { mine: true })];
  const out = labelTurns(turns, more)[0];
  assert.equal(out.source, 'you');
  assert.ok(out.confidence > 0 && out.confidence < 0.5);
});

test('a long turn with neither cue is not called crowd (a bystander does not hold the floor for 15 s)', () => {
  const turns = [turn(1, 'B', 0, 15000)];
  assert.equal(labelTurns(turns, cues(0, 15000))[0].source, 'unknown');
});

test('inferLabels maps the diarizer letters to you / them by majority', () => {
  const turns = [
    { turnId: 1, speaker: 'A', source: 'you' },
    { turnId: 2, speaker: 'B', source: 'them' },
    { turnId: 3, speaker: 'A', source: 'you' },
    { turnId: 4, speaker: 'B', source: 'them' },
    { turnId: 5, speaker: 'A', source: 'them' },  // one slip
    { turnId: 6, speaker: 'C', source: 'crowd' }, // ignored
    { turnId: 7, speaker: 'B', source: 'unknown' },
  ];
  assert.deepEqual(inferLabels(turns), { userLabel: 'A', otherLabel: 'B', agreement: 0.8, n: 5 });
});

test('inferLabels is null when there is too little or too mixed evidence', () => {
  assert.equal(inferLabels([{ speaker: 'A', source: 'you' }, { speaker: 'B', source: 'them' }]), null); // < 3 turns
  assert.equal(inferLabels([
    { speaker: 'A', source: 'you' }, { speaker: 'A', source: 'them' }, { speaker: 'A', source: 'you' },
    { speaker: 'B', source: 'you' }, { speaker: 'B', source: 'them' }, { speaker: 'B', source: 'them' },
  ]), null); // 4 of 6 agree, under 70%
  assert.equal(inferLabels([{ speaker: 'A', source: 'you' }, { speaker: 'B', source: 'you' }, { speaker: 'A', source: 'you' }]), null); // both voices look like you
  assert.equal(inferLabels([]), null);
  assert.equal(inferLabels(null), null);
});

test('inferLabels copes with a single voice that is you', () => {
  const turns = [{ speaker: 'A', source: 'you' }, { speaker: 'A', source: 'you' }, { speaker: 'A', source: 'you' }];
  assert.deepEqual(inferLabels(turns), { userLabel: 'A', otherLabel: null, agreement: 1, n: 3 });
});

test('speechTurns drops crowd lines and nothing else', () => {
  const turns = [{ turnId: 1, source: 'you' }, { turnId: 2, source: 'crowd' }, { turnId: 3 }, { turnId: 4, source: 'unknown' }];
  assert.deepEqual(speechTurns(turns).map(t => t.turnId), [1, 3, 4]);
  assert.deepEqual(speechTurns(null), []);
});

// ---- a reopened Muse session: its letters are suffixed until the camera says who they are ----

test('mergeSessions maps a reopened session\'s letters onto the first session\'s by camera lean', async () => {
  const { mergeSessions } = await import('../src/transcribe/crowd.js');
  const turns = [
    { turnId: 1, speaker: 'A', source: 'you' }, { turnId: 2, speaker: 'B', source: 'them' }, { turnId: 3, speaker: 'A', source: 'you' },
    // after the reconnect the diarizer handed out letters the other way round
    { turnId: 4, speaker: 'A#2', source: 'them' }, { turnId: 5, speaker: 'B#2', source: 'you' }, { turnId: 6, speaker: 'A#2', source: 'them' },
  ];
  assert.deepEqual(mergeSessions(turns).map(t => t.speaker), ['A', 'B', 'A', 'B', 'A', 'B']);
});

test('mergeSessions drops the suffix when nobody can say which side a letter is', async () => {
  const { mergeSessions } = await import('../src/transcribe/crowd.js');
  const turns = [
    { turnId: 1, speaker: 'A', source: 'unknown' }, { turnId: 2, speaker: 'B', source: 'unknown' },
    { turnId: 3, speaker: 'A#2', source: 'unknown' }, { turnId: 4, speaker: 'unknown', source: 'unknown' },
  ];
  assert.deepEqual(mergeSessions(turns).map(t => t.speaker), ['A', 'B', 'A', 'unknown']);
  const plain = [{ turnId: 1, speaker: 'A', source: 'you' }];
  assert.equal(mergeSessions(plain), plain); // nothing to merge: same array back
});
