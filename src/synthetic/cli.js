// npm run synthetic: writes the SYNTHETIC demo account (13 conversations with Prat, Priya and Parth,
// Oct 12-24 2026) to data/demo.db. It never touches data/playback.db. Serve it with
// `npm run dev:synthetic`, which sets PLAYBACK_DB=demo.
//
//   node src/synthetic/cli.js [--db data/demo.db] [--seed 20261012] [--snapshot fixtures/synthetic/demo.json]

import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../db.js';
import { buildDemo, exportSnapshot, SEED } from './build.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const dbPath = resolve(root, opt('--db', 'data/demo.db'));
const seed = Number(opt('--seed', SEED));
const snapshot = args.includes('--snapshot') ? resolve(root, opt('--snapshot', 'fixtures/synthetic/demo.json')) : null;

if (dbPath === resolve(root, 'data/playback.db')) {
  console.error('Refusing to write synthetic data into the real database; pick another --db.');
  process.exit(1);
}

// A rebuild starts clean.
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });

const store = openStore(dbPath);
const { built, problems } = await buildDemo({ store, seed });
if (snapshot) {
  mkdirSync(dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, `${JSON.stringify(exportSnapshot(store), null, 1)}\n`);
  console.log(`Snapshot: ${snapshot}`);
}
store.close();

console.log(`Built ${built.length} synthetic conversations into ${dbPath} (seed ${seed})`);
for (const b of built) console.log(`  ${b.createdAt.slice(0, 10)}  ${b.otherName.padEnd(5)}  ${b.mood.padEnd(5)}  score ${b.score}${b.outlier ? '  outlier' : ''}`);
for (const p of problems) console.warn(`  ! ${p}`);
console.log('Serve it with: npm run dev:synthetic');
