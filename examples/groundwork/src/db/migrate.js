// Versioned, checksummed migrations (spec 6.1).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR) {
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const m = FILE_RE.exec(f);
    if (!m) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    out.push({
      version: Number(m[1]),
      name: f.slice(4, -4),
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
    });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 0; i < out.length; i++) {
    if (out[i].version !== i + 1) {
      throw new MigrationError(`migration versions must be contiguous from 001 (problem near ${out[i].version})`);
    }
  }
  return out;
}

/**
 * Apply pending migrations. Returns { applied: [versions], schemaVersion }.
 * Aborts (throws MigrationError) if an applied migration was edited, or the
 * database is newer than the migration files. Re-running is a no-op.
 */
export function migrate(db, { dir = DEFAULT_MIGRATIONS_DIR, now = () => new Date() } = {}) {
  const files = loadMigrations(dir);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  const byVersion = new Map(files.map((f) => [f.version, f]));

  for (const r of rows) {
    const f = byVersion.get(r.version);
    if (!f) {
      throw new MigrationError(`database schema version ${r.version} is newer than this build (latest ${files.length})`);
    }
    if (f.checksum !== r.checksum) {
      throw new MigrationError(`migration ${String(r.version).padStart(3, '0')}_${r.name} was edited after being applied`);
    }
  }

  const done = new Set(rows.map((r) => r.version));
  const applied = [];
  for (const f of files) {
    if (done.has(f.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(f.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(f.version, f.name, f.checksum, now().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new MigrationError(`migration ${f.version} (${f.name}) failed: ${err.message}`);
    }
    applied.push(f.version);
  }
  return { applied, schemaVersion: files.length };
}

export function schemaVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row && row.v ? row.v : 0;
}
