import { WebSocketServer } from 'ws';
import { createTurnAssembler } from './assemble.js';

// Browser <-> Muse bridge. Audio only passes through memory here and is never written anywhere.
export function attachTranscribeSocket({ server, store, log, config, openStream, stage = { publish() {} } }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/transcribe') return; // server.js owns unknown paths
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
      stage.publish({ type: 'done', conversationId, turns });
      ws.close(1000);
    };

    const onEvent = event => {
      const out = assembler.push(event);
      if (out?.kind === 'partial') {
        const msg = { type: 'partial', turnId: out.turnId, text: out.text, speaker: out.speaker };
        send(msg);
        stage.publish({ ...msg, conversationId });
      } else if (out?.kind === 'turn') {
        send({ type: 'turn', turn: out.turn });
        stage.publish({ type: 'turn', conversationId, turn: out.turn });
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

    // Frames that arrive while the Muse handshake is still in flight wait here.
    // An early "end" waits for the handshake too, otherwise those frames would be lost
    // and the Muse session would be opened after we'd already given up on it.
    const pending = [];
    const opening = openStream({
      apiKey: config.apiKey,
      model: config.asrModel,
      languages: config.languages,
      onEvent,
      onError: err => {
        log('transcribe', 'error', err.message);
        send({ type: 'error', message: 'The transcriber hit a problem. Keeping what we heard.' });
      },
      onClose,
    }).then(s => {
      stream = s;
      for (const chunk of pending.splice(0)) s.sendAudio(chunk);
      return s;
    }, err => {
      log('transcribe', 'error', `could not open Muse stream: ${err.message}`);
      send({ type: 'error', message: 'Could not reach the transcription service' });
      ws.close(1011);
      return null;
    });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        if (stream) stream.sendAudio(data);
        else pending.push(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'end') {
        const s = await opening;
        try { await s?.end(); } catch (err) { log('transcribe', 'warn', `end failed: ${err.message}`); }
        finish();
      }
    });

    ws.on('close', () => {
      pending.length = 0;
      // still end the Muse side if the browser vanished mid-handshake
      opening.then(s => { if (s && !finished) s.end().catch(() => {}); });
    });

    const s = await opening;
    if (!s || finished || ws.readyState !== ws.OPEN) return;
    log('transcribe', 'info', `stream open for ${conversationId.slice(0, 8)}${config.mock ? ' (mock)' : ''}`);
    send({ type: 'ready', mock: config.mock });
  }

  return wss;
}
