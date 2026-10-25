// The camera points at the other person, so their mouth moves while they talk and mostly doesn't
// while you do. That's enough to tell which diarized voice is yours when nobody picked one.

const MIN_FRAMES = 10;
const MIN_RATIO = 1.3;

// Typical frame-to-frame jaw change. A median, because the face re-locking after a dropout
// makes one huge jump that a mean would count as a lot of talking.
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function inferUserLabel(turns, frames) {
  const ts = Array.isArray(turns) ? turns : [];
  const speakers = [...new Set(ts.map(t => t.speaker).filter(s => s && s !== 'unknown'))];
  if (speakers.length !== 2) return null;

  let prev = null;
  const motion = (frames ?? []).map(f => {
    const m = f.face && prev?.face ? Math.abs(f.jawOpen - prev.jawOpen) : null;
    prev = f;
    return { t: f.t, m };
  }).filter(f => f.m != null);

  const mouth = {};
  for (const s of speakers) {
    const inside = motion.filter(f => ts.some(t => t.speaker === s && f.t >= t.startMs && f.t <= t.endMs));
    if (inside.length < MIN_FRAMES) return null;
    mouth[s] = median(inside.map(f => f.m));
  }

  const [a, b] = speakers;
  const [onCamera, you] = mouth[a] >= mouth[b] ? [a, b] : [b, a];
  // A face that never moves its mouth (a photo, a bad angle) says nothing either way.
  if (mouth[onCamera] < 0.005) return null;
  const ratio = mouth[you] > 0 ? mouth[onCamera] / mouth[you] : Infinity;
  if (ratio < MIN_RATIO) return null;
  return {
    label: you,
    ratio: Math.round(ratio * 100) / 100,
    evidence: `their mouth moved ${Math.round((ratio - 1) * 100)}% more during ${onCamera}'s lines than ${you}'s`,
  };
}
