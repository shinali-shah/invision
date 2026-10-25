import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, tag TEXT NOT NULL, other_name TEXT NOT NULL, created_at TEXT NOT NULL,
  seeded INTEGER NOT NULL DEFAULT 0, turns TEXT, user_label TEXT, reflection TEXT, signals TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS next_steps (id INTEGER PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, agent TEXT, level TEXT, message TEXT, data TEXT);
`;

// patch key -> [column, is it stored as JSON]
const COLUMNS = {
  tag: ['tag', false],
  turns: ['turns', true],
  userLabel: ['user_label', false],
  reflection: ['reflection', false],
  signals: ['signals', true],
  note: ['note', true],
  hooks: ['hooks', true],
  followUp: ['follow_up', true],
  createdAt: ['created_at', false],
};

const parse = v => (v == null ? null : JSON.parse(v));

function toConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    tag: row.tag,
    otherName: row.other_name,
    createdAt: row.created_at,
    seeded: row.seeded === 1,
    turns: parse(row.turns),
    userLabel: row.user_label,
    reflection: row.reflection,
    signals: parse(row.signals),
    note: parse(row.note),
    hooks: parse(row.hooks),
    followUp: parse(row.follow_up),
  };
}

const toStep = row => row && { id: row.id, text: row.text, status: row.status, createdAt: row.created_at };

export function openStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Databases from before hooks/follow-ups existed just get the new columns.
  const have = new Set(db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name));
  for (const col of ['hooks', 'follow_up']) if (!have.has(col)) db.exec(`ALTER TABLE conversations ADD COLUMN ${col} TEXT`);

  const getConversation = id => toConversation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(id));
  const getStep = id => toStep(db.prepare('SELECT * FROM next_steps WHERE id = ?').get(id));

  return {
    createConversation({ tag, otherName, seeded = false }) {
      const id = randomUUID();
      db.prepare('INSERT INTO conversations (id, tag, other_name, created_at, seeded) VALUES (?, ?, ?, ?, ?)')
        .run(id, tag, otherName, new Date().toISOString(), seeded ? 1 : 0);
      return getConversation(id);
    },

    getConversation,

    listConversations() {
      // rowid breaks ties when two rows land in the same millisecond
      return db.prepare('SELECT * FROM conversations ORDER BY created_at, rowid').all().map(toConversation);
    },

    updateConversation(id, patch) {
      const sets = [];
      const values = [];
      for (const [key, value] of Object.entries(patch)) {
        const col = COLUMNS[key];
        if (!col) throw new Error(`unknown conversation field: ${key}`);
        sets.push(`${col[0]} = ?`);
        values.push(col[1] && value != null ? JSON.stringify(value) : value ?? null);
      }
      if (sets.length) db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      return getConversation(id);
    },

    deleteConversation(id) {
      return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
    },

    recentNotes(limit = 3, excludeId = null) {
      return db.prepare(`
        SELECT note FROM conversations
        WHERE note IS NOT NULL AND id IS NOT ?
          AND json_extract(note, '$.status') IN ('shown', 'rewritten')
          AND json_extract(note, '$.text') IS NOT NULL
        ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(excludeId, limit)
        .map(r => JSON.parse(r.note).text);
    },

    getKv(key) {
      return parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value);
    },

    setKv(key, value) {
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value ?? null));
    },

    createNextStep(text) {
      const { lastInsertRowid } = db.prepare('INSERT INTO next_steps (text, status, created_at) VALUES (?, ?, ?)')
        .run(text, 'proposed', new Date().toISOString());
      return getStep(Number(lastInsertRowid));
    },

    latestNextStep() {
      return toStep(db.prepare('SELECT * FROM next_steps ORDER BY id DESC LIMIT 1').get()) ?? null;
    },

    updateNextStep(id, { status, text }) {
      if (text != null) db.prepare('UPDATE next_steps SET status = ?, text = ? WHERE id = ?').run(status, text, id);
      else db.prepare('UPDATE next_steps SET status = ? WHERE id = ?').run(status, id);
      return getStep(id) ?? null;
    },

    addLog({ agent, level, message, data }) {
      db.prepare('INSERT INTO logs (ts, agent, level, message, data) VALUES (?, ?, ?, ?, ?)')
        .run(new Date().toISOString(), agent, level, message, data == null ? null : JSON.stringify(data));
    },

    listLogs(limit = 100) {
      return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit)
        .map(r => ({ ts: r.ts, agent: r.agent, level: r.level, message: r.message, data: parse(r.data) }));
    },

    close() {
      db.close();
    },
  };
}
