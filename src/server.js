import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import config from './config.js';
import { openStore } from './db.js';
import { createLogger } from './log.js';
import { createLlm } from './llm.js';
import { createApp } from './routes.js';
import { seedDemo, refreshHooks } from './seed.js';
import { attachTranscribeSocket } from './transcribe/wsRoute.js';
import { openMuseStream } from './transcribe/realtime.js';
import { openMockStream } from './transcribe/mockStream.js';
import { createStageHub, attachStageSocket } from './stage.js';

const SOCKET_PATHS = new Set(['/ws/transcribe', '/ws/stage']);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function createServer({ config: cfg = config, quiet = false, mockSpeed = 1 } = {}) {
  const store = openStore(cfg.dbPath === ':memory:' ? ':memory:' : resolve(root, cfg.dbPath));
  const log = createLogger(store, { quiet });
  const llm = createLlm({ apiKey: cfg.apiKey, mock: cfg.mock, model: cfg.sparkModel });
  // A synthetic account (npm run synthetic) brings its own history; the two sample calls would only muddle it.
  if (store.getKv('dataset')?.name !== 'synthetic') seedDemo(store);
  refreshHooks(store);

  const stage = createStageHub({ mock: cfg.mock });
  // In-memory test servers get a throwaway folder so they never touch real recordings.
  const recordingsDir = cfg.dbPath === ':memory:'
    ? mkdtempSync(join(tmpdir(), 'playback-rec-'))
    : resolve(root, cfg.recordingsDir ?? 'data/recordings');
  const app = createApp({ store, llm, log, config: cfg, publicDir: join(root, 'public'), stage, recordingsDir });
  const server = http.createServer(app);
  server.on('upgrade', (req, socket) => {
    if (!SOCKET_PATHS.has(new URL(req.url, 'http://localhost').pathname)) socket.destroy();
  });
  attachStageSocket({ server, hub: stage });
  const openStream = cfg.mock ? opts => openMockStream({ ...opts, speed: mockSpeed }) : openMuseStream;
  const wss = attachTranscribeSocket({ server, store, log, config: cfg, openStream, stage, recordingsDir });

  return {
    app, server, store,
    close() {
      for (const client of wss.clients) client.terminate();
      stage.close();
      server.close();
      store.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createServer();
  server.listen(config.port, () => {
    console.log(`Playback on http://localhost:${config.port}`);
    console.log(config.mock
      ? 'Mock mode: no MODEL_API_KEY, Muse calls are scripted.'
      : `Live Muse mode: ${config.sparkModel} + ${config.asrModel}, languages ${config.languages.join('/')}`);
    console.log('iPhone needs https for the mic: run `ngrok http ' + config.port + '` and open the https link.');
  });
}
