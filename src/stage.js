import { WebSocketServer } from 'ws';

export const STAGE_VIEWS = ['start', 'recording', 'label', 'coaching', 'memory'];

// Fan-out for the projector page. The phone does the work; the stage just listens.
export function createStageHub({ mock }) {
  const clients = new Set();
  let lastFocus = null;

  const sendTo = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  return {
    subscribe(ws) {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      sendTo(ws, { type: 'hello', mock, focus: lastFocus });
    },
    publish(msg) {
      // A finished stream means the phone isn't recording any more, whatever the last focus said;
      // otherwise a Mac that connects hours later would start a recording card for a phone that's gone.
      if (msg.type === 'done' && lastFocus?.view === 'recording' && lastFocus.conversationId === msg.conversationId) {
        lastFocus = { ...lastFocus, view: 'label', at: Date.now() };
      }
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
