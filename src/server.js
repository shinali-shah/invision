import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import config from './config.js';
import { openStore } from './db.js';
import { createLogger } from './log.js';
import { createLlm } from './llm.js';
import { createApp } from './routes.js';
import { seedDemo } from './seed.js';
import { attachTranscribeSocket } from './transcribe/wsRoute.js';
import { openMuseStream } from './transcribe/realtime.js';
import { openMockStream } from './transcribe/mockStream.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function createServer({ config: cfg = config, quiet = false, mockSpeed = 1 } = {}) {
  const store = openStore(cfg.dbPath === ':memory:' ? ':memory:' : join(root, cfg.dbPath));
  const log = createLogger(store, { quiet });
  const llm = createLlm({ apiKey: cfg.apiKey, mock: cfg.mock, model: cfg.sparkModel });
  seedDemo(store);

  const app = createApp({ store, llm, log, config: cfg, publicDir: join(root, 'public') });
  const server = http.createServer(app);
  const openStream = cfg.mock ? opts => openMockStream({ ...opts, speed: mockSpeed }) : openMuseStream;
  const wss = attachTranscribeSocket({ server, store, log, config: cfg, openStream });

  return {
    app, server, store,
    close() {
      for (const client of wss.clients) client.terminate();
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
