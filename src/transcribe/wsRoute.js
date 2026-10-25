import { WebSocketServer } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTurnAssembler } from './assemble.js';
import { labelTurns, inferLabels } from './crowd.js';
import { detectPeople } from '../nlp/person.js';

const MAX_CUES = 120000; // ~4 h at 8 fps; past that the phone has been left running
const MIN_NAME_CONF = 0.7; // a lone vocative is enough; a vocative with a rival name is not

const unnamed = convo => !convo.otherName || convo.otherName === 'them';
const realLabel = s => s && s !== 'unknown';

// Lip-lock cue samples ride the same socket as the audio, as small JSON frames.
// Keep only well-formed samples; a flaky phone must never take the stream down.
function cleanCues(samples) {
  if (!Array.isArray(samples)) return [];
  return samples
    .filter(s => s && typeof s === 'object' && Number.isFinite(s.t))
    .map(s => ({ t: Math.round(s.t), face: !!s.face, mouth: Number.isFinite(s.mouth) ? s.mouth : 0, theirs: !!s.theirs, mine: !!s.mine }));
}

// Browser <-> Muse bridge. Audio only passes through memory here and is never written anywhere.
export function attachTranscribeSocket({ server, store, log, config, openStream, stage = { publish() {} }, recordingsDir = null }) {
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
    const cues = [];
    let finished = false;
    let browserGone = false; // the phone dropped the socket without sending "end"
    let stream;

    // Names heard so far: who they are (while the conversation still says 'them') and, from the
    // user's own "I'm Parth", which voice is theirs. A typed or already-picked name is left alone.
    const peoplePatch = (turns, convo, userLabel = convo.userLabel ?? null) => {
      const { other, self } = detectPeople(turns, { userName: config.userName, userLabel });
      const patch = {};
      if (!userLabel && realLabel(self?.speaker)) patch.userLabel = self.speaker;
      let person = null;
      if (other && other.confidence >= MIN_NAME_CONF && unnamed(convo)) {
        patch.otherName = other.name;
        person = { type: 'person', name: other.name, turnId: other.turnId, confidence: other.confidence };
        log('names', 'info', `they are ${other.name}: ${other.how}`);
      }
      if (patch.userLabel) log('names', 'info', `your voice is ${patch.userLabel}: you said "${turns.find(t => t.turnId === self.turnId)?.text}"`);
      return { patch, person };
    };

    const noteNames = () => {
      const convo = store.getConversation(conversationId);
      if (!convo) return;
      const { patch, person } = peoplePatch(assembler.turns(), convo);
      if (!Object.keys(patch).length) return;
      const updated = store.updateConversation(conversationId, patch);
      if (person) send(person);
      stage.publish({ type: 'conversation', conversation: updated });
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      const turns = labelTurns(assembler.flush(), cues);
      // The phone deletes the conversation when the user walks out of a recording;
      // what Muse heard after that isn't ours to keep or show on the stage.
      const convo = store.getConversation(conversationId);
      if (!convo) {
        log('transcribe', 'info', `conversation ${conversationId.slice(0, 8)} was deleted mid-stream; ${turns.length} turns dropped`);
        return ws.close(1000);
      }
      const crowdTurns = turns.filter(t => t.source === 'crowd').length;
      // The camera and the mic agree on whose voice is whose: no need to ask.
      const picked = cues.length ? inferLabels(turns) : null;
      const { patch, person } = peoplePatch(turns, convo, picked?.userLabel ?? convo.userLabel ?? null);
      if (picked) patch.userLabel = picked.userLabel;
      const updated = store.updateConversation(conversationId, { turns, ...patch });
      if (person) send(person);
      if (cues.length && recordingsDir) {
        try {
          mkdirSync(recordingsDir, { recursive: true });
          writeFileSync(join(recordingsDir, `${conversationId}.cues.json`), JSON.stringify(cues));
        } catch (err) { log('transcribe', 'warn', `could not save lip-lock cues: ${err.message}`); }
      }
      log('transcribe', 'info', `${turns.length} turns, speakers ${[...new Set(turns.map(t => t.speaker))].join('/') || 'none'}; audio discarded`);
      if (cues.length) {
        log('lips', 'info', `lip lock: ${cues.length} cues, ${crowdTurns} background line${crowdTurns === 1 ? '' : 's'}${picked ? `, your voice is ${picked.userLabel} (${Math.round(picked.agreement * 100)}% of ${picked.n} lines agree)` : ', could not pick your voice'}`);
      }
      const userLabel = picked?.userLabel ?? patch.userLabel ?? convo.userLabel ?? null;
      const done = { type: 'done', turns, userLabel, crowdTurns, otherName: patch.otherName ?? convo.otherName ?? null };
      send(done);
      stage.publish({ ...done, conversationId });
      ws.close(1000);
    };

    const onEvent = event => {
      const out = assembler.push(event);
      if (browserGone) return; // nobody is on this conversation any more; just finish assembling
      if (out?.kind === 'partial') {
        const msg = { type: 'partial', turnId: out.turnId, text: out.text, speaker: out.speaker };
        send(msg);
        stage.publish({ ...msg, conversationId });
      } else if (out?.kind === 'turn') {
        send({ type: 'turn', turn: out.turn });
        stage.publish({ type: 'turn', conversationId, turn: out.turn });
        noteNames();
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
      if (msg.type === 'cues') {
        if (cues.length < MAX_CUES) cues.push(...cleanCues(msg.samples));
      } else if (msg.type === 'end') {
        const s = await opening;
        try { await s?.end(); } catch (err) { log('transcribe', 'warn', `end failed: ${err.message}`); }
        finish();
      }
    });

    ws.on('close', () => {
      pending.length = 0;
      if (!finished) browserGone = true;
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
