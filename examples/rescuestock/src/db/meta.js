// Small helpers for the meta table (key/value). Every process that calls
// getOrCreateMeta for the same key ends up with the same value, because the
// insert is INSERT OR IGNORE inside one BEGIN IMMEDIATE transaction.
import { randomBytes } from 'node:crypto';

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getOrCreateMeta(db, key, generate = () => randomBytes(32).toString('hex')) {
  return db.tx(() => {
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, generate());
    return getMeta(db, key);
  });
}
