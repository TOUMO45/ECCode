// Shared fixture for the auth unit tests: a migrated temp database, a settable clock and a few users.
// Not a test file (the name does not end in .test.js).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedClock } from '../../../src/clock.js';
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';

export const START_MS = Date.UTC(2026, 9, 20, 6, 0, 0);

export function openTestDb() {
  const dir = mkdtempSync(join(tmpdir(), 'rs-auth-unit-'));
  const clock = fixedClock(START_MS);
  const db = openDb(join(dir, 'app.db'), { busyTimeoutMs: 1000 });
  migrate(db, { clock });
  return {
    db,
    clock,
    dir,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Inserts a user with a placeholder hash (these tests never sign in) and returns its id.
export function insertUser(db, { username = 'cafe9', role = 'customer', disabled = 0 } = {}) {
  const result = db
    .prepare('INSERT INTO users (username, password_hash, role, supplier_id, display_name, disabled, demo, created_at) VALUES (?, ?, ?, NULL, ?, ?, 0, ?)')
    .run(username, 'scrypt$placeholder', role, `Name of ${username}`, disabled, '2026-10-20T06:00:00.000Z');
  return Number(result.lastInsertRowid);
}
