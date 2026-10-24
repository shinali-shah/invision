import { WebSocket } from 'ws';

const REALTIME_URL = 'wss://api.meta.ai/v1/asr/realtime';

// Opens a diarized realtime session with Muse Voice Transcribe. Resolves once the
// server answers the handshake with a sessionId; the caller is responsible for
// sending audio at real-time pace (the browser worklet already does).
export function openMuseStream({
  apiKey, model, languages, onEvent, onError, onClose,
  WebSocketImpl = WebSocket, handshakeTimeoutMs = 10000, endTimeoutMs = 15000,
}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(REALTIME_URL);
    let settled = false; // promise resolved or rejected
    let ready = false; // handshake succeeded
    let closed = false;
    let endPromise = null;
    let resolveEnd = () => {};

    const fail = err => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
        try { ws.close(); } catch {}
      } else if (ready) {
        onError?.(err);
      }
    };

    const timer = setTimeout(() => fail(new Error('Muse realtime handshake timed out')), handshakeTimeoutMs);
    timer.unref?.();

    ws.on('open', () => {
      ws.send(JSON.stringify({
        authorization: { accessToken: `Bearer ${apiKey}` },
        audioEncoding: 'PCM_24KHZ',
        model,
        mode: 'DIARIZATION',
        languageBias: languages,
        partialMode: 'CUMULATIVE',
        emitAudioProgress: false,
      }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (!ready) {
        if (settled) return;
        if (msg.type === 'error') return fail(new Error(`Muse realtime: ${msg.message || 'handshake rejected'}`));
        if (msg.sessionId) {
          ready = settled = true;
          clearTimeout(timer);
          resolve(stream);
        }
        return;
      }

      if (msg.type === 'error') onError?.(Object.assign(new Error(`Muse realtime: ${msg.message}`), { code: msg.errorCode }));
      else onEvent?.(msg);
    });

    ws.on('error', err => fail(err));

    ws.on('close', (code, reason) => {
      closed = true;
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Muse realtime closed before handshake (code ${code})`));
      } else if (ready) {
        onClose?.(code, reason?.toString?.() ?? '');
      }
      resolveEnd();
    });

    const stream = {
      sendAudio(buf) {
        if (closed || endPromise) return;
        ws.send(buf, { binary: true });
      },
      end() {
        if (endPromise) return endPromise;
        endPromise = new Promise(res => {
          if (closed) return res();
          resolveEnd = res;
          ws.send(JSON.stringify({ type: 'endStream' }));
          // If Muse never closes on us, close ourselves rather than hang the request
          const t = setTimeout(() => { try { ws.close(1000); } catch {} res(); }, endTimeoutMs);
          t.unref?.();
        });
        return endPromise;
      },
    };
  });
}
