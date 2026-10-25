import { WebSocketServer } from 'ws';

export const STAGE_VIEWS = ['start', 'recording', 'label', 'coaching', 'memory'];

// A client that stops reading (a TV that lost wifi) would otherwise buffer every partial forever.
const MAX_BUFFERED = 1 << 20;

// Fan-out for the projector page. The phone does the work; the stage just listens.
export function createStageHub({ mock }) {
  const clients = new Set();
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
    } else if (msg.type === 'done' || msg.type === 'deleted') {
      live.delete(id);
    }
  };

  const replay = ws => {
    for (const entry of live.values()) {
      for (const [, msg] of [...entry.turns].sort((a, b) => a[0] - b[0])) sendTo(ws, msg);
      if (entry.open) sendTo(ws, entry.open);
    }
  };

  return {
    subscribe(ws) {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => {}); // a bad frame from a client must not take the server down
      sendTo(ws, { type: 'hello', mock, focus: lastFocus });
      replay(ws);
    },
    publish(msg) {
      // A finished stream means the phone isn't recording any more, whatever the last focus said;
      // otherwise a Mac that connects hours later would start a recording card for a phone that's gone.
      if (msg.type === 'done' && lastFocus?.view === 'recording' && lastFocus.conversationId === msg.conversationId) {
        lastFocus = { ...lastFocus, view: 'label', at: Date.now() };
      }
      // Likewise a deleted conversation can't stay the one on screen, or a late joiner would try to show it.
      if (msg.type === 'deleted' && lastFocus?.conversationId === msg.conversationId) {
        lastFocus = lastFocus.view === 'memory'
          ? { ...lastFocus, conversationId: null, at: Date.now() }
          : { view: 'start', conversationId: null, otherName: null, at: Date.now() };
      }
      remember(msg);
      for (const ws of clients) sendTo(ws, msg);
    },
    focus({ view, conversationId = null, otherName = null }) {
      // `at` lets clients ignore a remembered focus that is older than they care about.
      lastFocus = { view, conversationId, otherName, at: Date.now() };
      this.publish({ type: 'focus', ...lastFocus });
    },
    close() {
      for (const ws of clients) ws.terminate();
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
