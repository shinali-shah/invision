import { WebSocketServer } from 'ws';

export const STAGE_VIEWS = ['start', 'recording', 'label', 'coaching', 'memory'];

// A client that stops reading (a TV that lost wifi) would otherwise buffer every partial forever.
// The kernel already holds several hundred KB for us before this counter moves, so 256 KB here
// is a projector that is many seconds behind, not one that blinked.
const MAX_BUFFERED = 256 << 10;
// And one that fell off the network without a FIN never buffers anything on a quiet stage, so
// ping it; a missed pong means the socket is dead.
const KEEPALIVE_MS = 30000;

// Fan-out for the projector page. The phone does the work; the stage just listens.
export function createStageHub({ mock, keepaliveMs = KEEPALIVE_MS }) {
  const clients = new Map(); // ws -> answered the last ping
  let lastFocus = null;
  // Lines of recordings still going, so a page that opens mid-conversation isn't blank until the
  // next turn. The store only gets the turns at the end, so nobody else can answer this.
  const live = new Map(); // conversationId -> { turns: Map(turnId -> turn), open: partial message | null }

  const sendTo = (ws, msg) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate();
    ws.send(JSON.stringify(msg));
  };

  const liveFor = id => {
    let entry = live.get(id);
    if (!entry) { entry = { turns: new Map(), open: null }; live.set(id, entry); }
    return entry;
  };

  const remember = msg => {
    const id = msg.conversationId;
    if (!id) return;
    if (msg.type === 'partial') {
      liveFor(id).open = msg;
    } else if (msg.type === 'turn' && msg.turn) {
      const entry = liveFor(id);
      entry.turns.set(msg.turn.turnId, msg);
      if (entry.open?.turnId === msg.turn.turnId) entry.open = null;
    } else if (msg.type === 'deleted' || (msg.type === 'done' && !msg.continued)) {
      // a `done` marked continued is a stream handing over to another on the same conversation;
      // its lines stay live for late joiners, the new stream's follow on from them
      live.delete(id);
    }
  };

  const keepalive = setInterval(() => {
    for (const [ws, alive] of clients) {
      if (!alive) { ws.terminate(); clients.delete(ws); continue; }
      clients.set(ws, false);
      ws.ping?.();
    }
  }, keepaliveMs);
  keepalive.unref?.();

  const replay = ws => {
    for (const entry of live.values()) {
      for (const [, msg] of [...entry.turns].sort((a, b) => a[0] - b[0])) sendTo(ws, msg);
      if (entry.open) sendTo(ws, entry.open);
    }
  };

  return {
    subscribe(ws) {
      clients.set(ws, true);
      ws.on('close', () => clients.delete(ws));
      ws.on('pong', () => clients.set(ws, true));
      ws.on('error', () => {}); // a bad frame from a client must not take the server down
      sendTo(ws, { type: 'hello', mock, focus: lastFocus });
      replay(ws);
    },
    publish(msg) {
      // A finished stream means the phone isn't recording any more, whatever the last focus said;
      // otherwise a Mac that connects hours later would start a recording card for a phone that's gone.
      if (msg.type === 'done' && !msg.continued && lastFocus?.view === 'recording' && lastFocus.conversationId === msg.conversationId) {
        lastFocus = { ...lastFocus, view: 'label', at: Date.now() };
      }
      // Likewise a deleted conversation can't stay the one on screen, or a late joiner would try to show it.
      if (msg.type === 'deleted' && lastFocus?.conversationId === msg.conversationId) {
        lastFocus = lastFocus.view === 'memory'
          ? { ...lastFocus, conversationId: null, at: Date.now() }
          : { view: 'start', conversationId: null, otherName: null, at: Date.now() };
      }
      remember(msg);
      for (const ws of clients.keys()) sendTo(ws, msg);
    },
    focus({ view, conversationId = null, otherName = null }) {
      // `at` lets clients ignore a remembered focus that is older than they care about.
      lastFocus = { view, conversationId, otherName, at: Date.now() };
      this.publish({ type: 'focus', ...lastFocus });
    },
    close() {
      clearInterval(keepalive);
      for (const ws of clients.keys()) ws.terminate();
      clients.clear();
      live.clear();
    },
  };
}

export function attachStageSocket({ server, hub }) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws/stage') return;
    wss.handleUpgrade(req, socket, head, ws => hub.subscribe(ws));
  });
  return wss;
}
