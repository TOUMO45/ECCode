// Numbered SQL migrations: src/db/migrations/NNN_name.sql.
//
// * Each file runs in its own BEGIN IMMEDIATE transaction, together with its
//   schema_migrations row, so a file is applied completely or not at all.
// * The "already applied?" check happens inside that transaction. A second
//   process that starts at the same time waits for the lock (busy_timeout),
//   then finds the version applied and skips it.
// * Each applied file is recorded with the sha256 of its content (CRLF
//   normalised to LF). Startup refuses to run if an applied file changed or
//   if the database holds a version that has no file. Migrations are
//   append-only: a schema change is a new file.
// * Migration files must not contain their own BEGIN/COMMIT.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from '../clock.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {
  constructor(code, message, version) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.version = version;
  }
}

export function checksum(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function loadMigrationFiles(dir = MIGRATIONS_DIR) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.sql')) continue;
    const m = FILE_PATTERN.exec(name);
    if (!m) throw new MigrationError('MIGRATION_BAD_NAME', `Migration file name is not NNN_name.sql: ${name}`);
    const sql = readFileSync(join(dir, name), 'utf8');
    files.push({ version: Number(m[1]), name: m[2], file: name, sql, sha256: checksum(sql) });
  }
  files.forEach((f, i) => {
    if (f.version !== i + 1) {
      throw new MigrationError('MIGRATION_GAP', `Migration versions must run 1, 2, 3 without gaps; found ${f.file}`, f.version);
    }
  });
  return files;
}

const CREATE_TRACKING = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)`;

function readApplied(db) {
  const exists = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!exists) return new Map();
  return new Map(
    db.prepare('SELECT version, name, sha256 FROM schema_migrations').all().map((row) => [row.version, row]),
  );
}

function verifyApplied(applied, files) {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const row of applied.values()) {
    const file = byVersion.get(row.version);
    if (!file) {
      throw new MigrationError(
        'MIGRATION_FILE_MISSING',
        `Database has migration ${row.version} (${row.name}) but no such file exists. Refusing to start.`,
        row.version,
      );
    }
    if (file.sha256 !== row.sha256) {
      throw new MigrationError(
        'MIGRATION_CHECKSUM_MISMATCH',
        `Applied migration ${row.version} (${row.name}) was changed after it was applied. Add a new migration instead. Refusing to start.`,
        row.version,
      );
    }
  }
}

// Returns { applied: [versions applied by this call], skipped: [versions already applied] }.
export function migrate(db, { dir = MIGRATIONS_DIR, clock = systemClock, log } = {}) {
  const files = loadMigrationFiles(dir);
  // A changed file is refused before anything new is applied.
  verifyApplied(readApplied(db), files);

  const applied = [];
  const skipped = [];
  for (const file of files) {
    const didApply = db.tx(() => {
      db.exec(CREATE_TRACKING);
      const current = readApplied(db);
      // Re-verify under the lock: another process may have applied versions meanwhile.
      verifyApplied(current, files);
      if (current.has(file.version)) return false;
      db.exec(file.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)').run(
        file.version,
        file.name,
        file.sha256,
        new Date(clock.now()).toISOString(),
      );
      return true;
    });
    if (didApply) {
      applied.push(file.version);
      if (log) log.info('migration.applied', { counts: { version: file.version } });
    } else {
      skipped.push(file.version);
    }
  }
  return { applied, skipped };
}
