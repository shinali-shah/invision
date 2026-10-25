// npm run synthetic: writes the synthetic account to its own database and recordings folder, so it
// never touches data/playback.db. Then `npm run dev:synthetic` serves it.
//
//   node src/synthetic/cli.js [--db data/synthetic.db] [--recordings data/synthetic-recordings]
//                             [--no-video] [--snapshot fixtures/synthetic/playback.json]

import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../db.js';
import { buildSynthetic, exportSnapshot } from './build.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const dbPath = resolve(root, opt('--db', 'data/synthetic.db'));
const recordingsDir = resolve(root, opt('--recordings', 'data/synthetic-recordings'));
const snapshot = args.includes('--snapshot') ? resolve(root, opt('--snapshot', 'fixtures/synthetic/playback.json')) : null;
// The committed snapshot is pinned to one date so rebuilding it doesn't churn every timestamp.
const now = snapshot ? Date.parse(opt('--now', '2026-10-25T21:00:00')) : Date.now();

if (dbPath === resolve(root, 'data/playback.db')) {
  console.error('Refusing to overwrite the real database; pick another --db.');
  process.exit(1);
}

// A rebuild starts clean: the old rows and files belong to conversation ids that no longer exist.
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
rmSync(recordingsDir, { recursive: true, force: true });

const store = openStore(dbPath);
const { built, problems } = await buildSynthetic({ store, recordingsDir, now, videos: !args.includes('--no-video') });

if (snapshot) {
  mkdirSync(dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, `${JSON.stringify(exportSnapshot(store), null, 1)}\n`);
  console.log(`Snapshot: ${snapshot}`);
}
store.close();

console.log(`Built ${built.length} conversations into ${dbPath}`);
console.log(`Recordings, face frames and lip-lock cues in ${recordingsDir}`);
for (const p of problems) console.warn(`  ! ${p}`);
console.log('Serve it with: npm run dev:synthetic');
