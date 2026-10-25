// Muse wants audio at roughly the pace it was spoken. The phone sends it that way, but a
// slow handshake or a stalled tunnel bunches seconds of frames up and they used to land on
// Muse all at once; it answered "Audio processing backlog too large" and hung up (1008).
// This is a token bucket between the browser socket and the Muse socket: a short burst goes
// straight through, anything past that trickles out a little faster than real time so a
// stall is caught up gradually instead of in one slap.
export function createPacer({
  bytesPerMs = 48,     // PCM 24 kHz, 16-bit mono
  leadMs = 1500,       // how much can go out at once
  catchUp = 1.5,       // drain rate after a stall, in multiples of real time
  maxQueueMs = 30000,  // past this we're not transcribing a conversation any more; shed the oldest
  now = () => performance.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
  onDrop = () => {},
} = {}) {
  const capacity = leadMs * bytesPerMs;
  const rate = bytesPerMs * catchUp;
  const maxQueue = maxQueueMs * bytesPerMs;
  const queue = [];
  const waiters = [];
  let tokens = capacity;
  let last = now();
  let queued = 0;
  let sent = 0;
  let dropped = 0;
  let sink = null;
  let timer = null;

  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + Math.max(0, t - last) * rate);
    last = t;
  };

  function drain() {
    if (timer) { cancel(timer); timer = null; }
    if (!sink) return;
    refill();
    while (queue.length) {
      const head = queue[0];
      const need = Math.min(head.length, capacity); // a chunk bigger than the bucket still has to go
      if (need > tokens) {
        timer = schedule(drain, Math.ceil((need - tokens) / rate));
        timer.unref?.();
        return;
      }
      queue.shift();
      queued -= head.length;
      tokens -= need;
      sent += head.length;
      sink(head);
    }
    for (const w of waiters.splice(0)) w();
  }

  return {
    push(buf) {
      queue.push(buf);
      queued += buf.length;
      let lost = 0;
      while (queued > maxQueue && queue.length > 1) {
        const old = queue.shift();
        queued -= old.length;
        lost += old.length;
      }
      if (lost) {
        dropped += lost;
        onDrop(lost / bytesPerMs);
      }
      drain();
    },
    // null while there is nobody to send to (reconnecting); audio waits here meanwhile
    setSink(fn) {
      sink = fn;
      drain();
    },
    // Where the next byte sits on the recording's own clock, whether or not Muse ever heard
    // what came before it. A fresh Muse session starts its clock here.
    positionMs: () => (sent + dropped) / bytesPerMs,
    queuedMs: () => queued / bytesPerMs,
    droppedMs: () => dropped / bytesPerMs,
    // Resolves once the queue has emptied, or after timeoutMs if it hasn't
    idle(timeoutMs = 5000) {
      if (!queue.length) return Promise.resolve();
      return new Promise(res => {
        const t = schedule(res, timeoutMs);
        t.unref?.();
        waiters.push(() => { cancel(t); res(); });
      });
    },
    clear() {
      queue.length = 0;
      queued = 0;
      if (timer) cancel(timer);
      timer = null;
      for (const w of waiters.splice(0)) w();
    },
  };
}
