// "  María  " and "maria" are the same person; "them" (no name given) is nobody in particular.
export const normName = name => String(name ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase().replace(/\s+/g, ' ');

export function samePerson(a, b) {
  const n = normName(a);
  return n !== '' && n !== 'them' && n === normName(b);
}

// Too short to coach means too short to compare against or brief from.
export const coachable = c => !!c.signals && (c.turns?.length ?? 0) >= 2 && c.note?.reason !== 'too_short';
