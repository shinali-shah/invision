// Folds Muse realtime events into Turn objects. Partials are CUMULATIVE, so each
// transcript event replaces the open turn's text rather than appending to it.
export function createTurnAssembler() {
  const done = [];
  let open = null;
  let lastMs = 0;
  let lastTurnId = 0;

  function openTurn(turnId, startMs) {
    open = { turnId, startMs, endMs: null, text: '', speaker: null };
    lastTurnId = Math.max(lastTurnId, turnId);
  }

  function close(finalText) {
    const t = open;
    open = null;
    const text = (finalText ?? t.text ?? '').trim();
    if (!text) return null;
    const turn = {
      turnId: t.turnId,
      speaker: t.speaker || 'unknown',
      text,
      startMs: t.startMs,
      endMs: Math.max(t.endMs ?? lastMs, t.startMs),
    };
    done.push(turn);
    return turn;
  }

  const partial = () => ({ kind: 'partial', turnId: open.turnId, text: open.text, speaker: open.speaker || 'unknown' });

  return {
    push(event) {
      if (!event || typeof event !== 'object') return null;
      if (Number.isFinite(event.audioProcessedMs)) lastMs = Math.max(lastMs, event.audioProcessedMs);

      switch (event.type) {
        case 'speechStart':
          // A new start while one is still open means we missed a speechComplete
          if (open) close();
          openTurn(event.turnId ?? lastTurnId + 1, event.audioProcessedMs ?? lastMs);
          return null;
        case 'transcript':
          if (!open) openTurn(lastTurnId + 1, event.audioProcessedMs ?? lastMs);
          open.text = event.transcript ?? '';
          return partial();
        case 'speaker':
          // The label covers the span *before* it, so it can land just after speechComplete.
          // The browser already has that turn; the corrected label goes out with `done`.
          if (!open) {
            const last = done.at(-1);
            if (last && last.speaker === 'unknown' && event.label) last.speaker = event.label;
            return null;
          }
          open.speaker = event.label || null;
          return open.text ? partial() : null;
        case 'speechEnd':
          if (open) open.endMs = event.audioProcessedMs ?? lastMs;
          return null;
        case 'speechComplete': {
          if (!open) return null;
          const turn = close(event.transcript);
          return turn ? { kind: 'turn', turn } : null;
        }
        default:
          return null; // audioProgress, error, anything new
      }
    },
    turns: () => done.slice(),
    flush() {
      if (open) close();
      return done.slice();
    },
  };
}
