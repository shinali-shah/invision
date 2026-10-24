import { DEMO_EVENTS } from '../mock/demoConversation.js';

// Same shape as openMuseStream, but replays scripted events. The clock starts on the
// first audio frame so the transcript builds up while the user is actually "recording".
export async function openMockStream({ onEvent, onClose, events = DEMO_EVENTS, speed = 1 }) {
  let next = 0;
  let t0 = null;
  let timer = null;
  let ended = false;

  function emitDue() {
    timer = null;
    const elapsed = Date.now() - t0;
    while (next < events.length && events[next].audioProcessedMs / speed <= elapsed) onEvent?.(events[next++]);
    if (next < events.length) {
      timer = setTimeout(emitDue, Math.max(0, events[next].audioProcessedMs / speed - elapsed));
    }
  }

  return {
    sendAudio() {
      if (ended || t0 !== null) return;
      t0 = Date.now();
      emitDue();
    },
    async end() {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      while (next < events.length) onEvent?.(events[next++]);
      onClose?.(1000);
    },
  };
}
