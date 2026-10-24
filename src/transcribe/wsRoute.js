import { WebSocketServer } from 'ws';
import { createTurnAssembler } from './assemble.js';

// Browser <-> Muse bridge. Audio only passes through memory here and is never written anywhere.
export function attachTranscribeSocket({ server, store, log, config, openStream }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/transcribe') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => handle(ws, url.searchParams.get('conversationId')));
  });

  async function handle(ws, conversationId) {
    const send = msg => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const convo = conversationId && store.getConversation(conversationId);
    if (!convo) {
      send({ type: 'error', message: 'Conversation not found' });
      return ws.close(4404, 'not found');
    }

    const assembler = createTurnAssembler();
    let finished = false;
    let stream;

    const finish = () => {
      if (finished) return;
      finished = true;
      const turns = assembler.flush();
      store.updateConversation(conversationId, { turns });
      log('transcribe', 'info', `${turns.length} turns, speakers ${[...new Set(turns.map(t => t.speaker))].join('/') || 'none'}; audio discarded`);
      send({ type: 'done', turns });
      ws.close(1000);
    };

    const onEvent = event => {
      const out = assembler.push(event);
      if (out?.kind === 'partial') send({ type: 'partial', turnId: out.turnId, text: out.text, speaker: out.speaker });
      else if (out?.kind === 'turn') send({ type: 'turn', turn: out.turn });
      else if (event.type === 'error') {
        log('transcribe', 'error', `Muse: ${event.message}`);
        send({ type: 'error', message: event.message });
      }
    };

    // a socket close from Muse before we asked to end still keeps whatever turns came through
    const onClose = code => {
      if (code !== 1000 && !finished) {
        log('transcribe', 'warn', `Muse stream closed with ${code}`);
        send({ type: 'error', message: `Transcription stopped early (code ${code}). Keeping what we heard.` });
      }
      finish();
    };

    const pending = [];
    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        if (stream) stream.sendAudio(data);
        else pending.push(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'end') {
        try { await stream?.end(); } catch (err) { log('transcribe', 'warn', `end failed: ${err.message}`); }
        finish();
      }
    });

    ws.on('close', () => {
      pending.length = 0;
      if (!finished) stream?.end().catch(() => {});
    });

    try {
      stream = await openStream({
        apiKey: config.apiKey,
        model: config.asrModel,
        languages: config.languages,
        onEvent,
        onError: err => log('transcribe', 'error', err.message),
        onClose,
      });
    } catch (err) {
      log('transcribe', 'error', `could not open Muse stream: ${err.message}`);
      send({ type: 'error', message: 'Could not reach the transcription service' });
      return ws.close(1011);
    }

    log('transcribe', 'info', `stream open for ${conversationId.slice(0, 8)}${config.mock ? ' (mock)' : ''}`);
    for (const chunk of pending.splice(0)) stream.sendAudio(chunk);
    send({ type: 'ready', mock: config.mock });
  }

  return wss;
}
