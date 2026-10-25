import { WebSocketServer } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTurnAssembler } from './assemble.js';
import { labelTurns, inferLabels, mergeSessions } from './crowd.js';
import { createPacer } from './pace.js';
import { detectPeople } from '../nlp/person.js';

const MAX_CUES = 120000; // ~4 h at 8 fps; past that the phone has been left running
const MIN_NAME_CONF = 0.7; // a lone vocative is enough; a vocative with a rival name is not
const MAX_SESSIONS = 4; // Muse hangs up (1008) when it falls behind; this many fresh sessions per recording before we give up
const RECONNECT_BACKOFF_MS = 300; // wait this much longer before each reopen, so a bad minute at Muse isn't met with four opens in a row
const END_DRAIN_MS = 5000; // how long "end" waits for throttled audio to reach Muse

const unnamed = convo => !convo.otherName || convo.otherName === 'them';
const realLabel = s => s && s !== 'unknown' && !/#\d+$/.test(s); // a reopened session's letters are settled at finish

// Lip-lock cue samples ride the same socket as the audio, as small JSON frames.
// Keep only well-formed samples; a flaky phone must never take the stream down.
function cleanCues(samples) {
  if (!Array.isArray(samples)) return [];
  return samples
    .filter(s => s && typeof s === 'object' && Number.isFinite(s.t))
    .map(s => ({ t: Math.round(s.t), face: !!s.face, mouth: Number.isFinite(s.mouth) ? s.mouth : 0, theirs: !!s.theirs, mine: !!s.mine }));
}

// Browser <-> Muse bridge. Audio only passes through memory here and is never written anywhere.
export function attachTranscribeSocket({
  server, store, log, config, openStream, stage = { publish() {} }, recordingsDir = null, pace = {}, reconnectBackoffMs = RECONNECT_BACKOFF_MS,
}) {
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
    let ending = false; // the phone said "end"; a Muse close from here on is the normal one
    let connecting = null; // promise of the Muse session being opened right now
    let session = 0; // Muse sessions opened for this recording; past 1 we reconnected mid-stream
    let maxTurnId = 0; // highest turn id on the recording's timeline, Muse's or one the assembler made up
    let labelSource = null; // how this recording learnt which voice is the user's: 'camera', 'name', or not at all
    const pacer = createPacer({
      ...pace,
      onDrop: ms => log('transcribe', 'warn', `${(ms / 1000).toFixed(1)}s of audio dropped: the transcriber is too far behind`),
    });

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
      if (patch.userLabel) labelSource = 'name';
      const updated = store.updateConversation(conversationId, patch);
      if (person) send(person);
      stage.publish({ type: 'conversation', conversation: updated });
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      const turns = mergeSessions(labelTurns(assembler.flush(), cues));
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
      if (picked) { patch.userLabel = picked.userLabel; labelSource = 'camera'; } else if (patch.userLabel) labelSource = 'name';
      const updated = store.updateConversation(conversationId, { turns, ...patch });
      // The turns just landed on the record. Anyone following the conversation itself (rather
      // than this stream's `done`) hears about it the same way they hear about a name or a tag.
      stage.publish({ type: 'conversation', conversation: updated });
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
      // labelSource says where userLabel came from this time; null means it was already on the
      // conversation (typed earlier) or there isn't one, so the phone should still ask.
      const done = { type: 'done', turns, userLabel, labelSource, crowdTurns, otherName: patch.otherName ?? convo.otherName ?? null };
      send(done);
      stage.publish({ ...done, conversationId });
      ws.close(1000);
    };

    const onEvent = event => {
      // `done` went out with everything the assembler had. A line Muse flushes after that (its
      // close frame still in the air) has no record to land on, and announcing it would put a
      // live line on the stage for a recording that is over.
      if (finished) return;
      if (Number.isFinite(event?.turnId)) maxTurnId = Math.max(maxTurnId, event.turnId);
      const out = assembler.push(event);
      // A transcript with no speechStart gets a made-up id; the next session shifts past it too
      const id = out?.turnId ?? out?.turn?.turnId;
      if (Number.isFinite(id)) maxTurnId = Math.max(maxTurnId, id);
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

    // Every Muse session starts its clock and its turn numbers from zero and hands out its own
    // speaker letters. Shift them onto the recording's timeline; letters from a reopened
    // session stay marked (A#2) until finish() works out who they were. The clock offset is
    // read through `at()` because it is only known once the session gets its first byte:
    // audio can be shed from the queue while the handshake is still in flight.
    const shifted = (n, at, turnOffset) => event => {
      const e = { ...event };
      if (Number.isFinite(e.audioProcessedMs)) e.audioProcessedMs += at();
      if (Number.isFinite(e.turnId)) e.turnId += turnOffset;
      if (n > 1 && typeof e.label === 'string' && e.label) e.label = `${e.label}#${n}`;
      onEvent(e);
    };

    // Muse hanging up early used to end the recording. Now, while the phone is still talking
    // to us, we open a fresh session where the audio left off and keep going. The code doesn't
    // matter: every close we asked for has `ending` or `browserGone` set by then, so even a
    // tidy 1000 that arrives without either is Muse's idea, not ours.
    const onClose = async (code, n) => {
      if (n !== session || finished) return; // an old session closing late
      if (ending || browserGone) return finish();
      pacer.setSink(null);
      if (session >= MAX_SESSIONS) {
        log('transcribe', 'warn', `Muse stream closed with ${code} again; giving up after ${session} sessions`);
        send({ type: 'error', message: `Transcription stopped early (code ${code}). Keeping what we heard.` });
        return finish();
      }
      log('transcribe', 'warn', `Muse stream closed with ${code}; reconnecting at ${(pacer.positionMs() / 1000).toFixed(1)}s with ${Math.round(pacer.queuedMs())}ms waiting`);
      try {
        const s = await connect();
        if (!s) return finish(); // the phone left while we were waiting to reopen; keep what we heard
        if (!finished) log('transcribe', 'info', `transcriber back (session ${session})`);
      } catch (err) {
        log('transcribe', 'error', `could not reopen Muse stream: ${err.message}`);
        send({ type: 'error', message: 'Lost the transcriber and could not get it back. Keeping what we heard.' });
        finish();
      }
    };

    // Audio that arrives before a session is ready waits in the pacer and goes out when it is.
    // An early "end" waits for the handshake too, otherwise those frames would be lost
    // and the Muse session would be opened after we'd already given up on it.
    // A reopen waits a beat longer each time (Muse just hung up on us; knocking straight away
    // again is how four sessions get burnt in a second). The wait is part of `connecting`, so an
    // "end" or a vanished phone during it is handled the same as during the handshake itself,
    // and audio that arrives meanwhile waits in the pacer for the new session.
    // Resolves null when the phone left before we got round to opening.
    const connect = () => {
      const n = ++session;
      let startMs = null; // where this session's clock zero sits on the recording
      const wait = reconnectBackoffMs * (n - 1);
      const open = () => openStream({
        apiKey: config.apiKey,
        model: config.asrModel,
        languages: config.languages,
        onEvent: shifted(n, () => startMs ?? pacer.positionMs(), maxTurnId),
        onError: err => log('transcribe', 'error', err.message), // Muse follows a fatal one with a close; that is where we act
        onClose: code => onClose(code, n),
      });
      const delay = wait ? new Promise(r => setTimeout(r, wait).unref?.()) : Promise.resolve();
      connecting = delay.then(() => {
        if (n > 1 && (finished || browserGone)) return null;
        return open().then(s => {
          if (finished || browserGone) { s.end().catch(() => {}); return s; }
          startMs = pacer.positionMs(); // the next byte out is this session's first
          pacer.setSink(chunk => s.sendAudio(chunk));
          return s;
        });
      });
      return connecting;
    };

    const opening = connect().catch(err => {
      log('transcribe', 'error', `could not open Muse stream: ${err.message}`);
      send({ type: 'error', message: 'Could not reach the transcription service' });
      ws.close(1011);
      return null;
    });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        pacer.push(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'cues') {
        if (cues.length < MAX_CUES) cues.push(...cleanCues(msg.samples));
      } else if (msg.type === 'end') {
        ending = true;
        const s = await connecting.catch(() => null);
        if (s) await pacer.idle(END_DRAIN_MS); // let throttled audio reach Muse before we ask it to wrap up
        try { await s?.end(); } catch (err) { log('transcribe', 'warn', `end failed: ${err.message}`); }
        finish();
      }
    });

    // A bad frame from the phone is reported here and then as a close. Without a listener it is
    // an uncaught exception, and one flaky tunnel would take the whole server down with it.
    ws.on('error', err => log('transcribe', 'warn', `phone socket: ${err.message}`));

    ws.on('close', () => {
      pacer.clear();
      if (!finished) browserGone = true;
      // still end the Muse side if the browser vanished mid-handshake or mid-reconnect
      connecting.then(s => { if (s && !finished) s.end().catch(() => {}); }, () => {});
    });

    const s = await opening;
    if (!s || finished || ws.readyState !== ws.OPEN) return;
    log('transcribe', 'info', `stream open for ${conversationId.slice(0, 8)}${config.mock ? ' (mock)' : ''}`);
    send({ type: 'ready', mock: config.mock });
  }

  return wss;
}
