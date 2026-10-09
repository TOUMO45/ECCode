import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, tx } from '../../../src/db/connection.js';
import { migrate, loadMigrations, schemaVersion, MigrationError } from '../../../src/db/migrate.js';

const NOW = '2026-10-08T00:00:00.000Z';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seed(db) {
  db.prepare('INSERT INTO teams (id, name, created_at) VALUES (1, ?, ?)').run('Platform', NOW);
  db.prepare(`INSERT INTO users (id, team_id, username, display_name, role, password_hash, created_at)
    VALUES (1, 1, 'lead', 'Lead', 'lead', 'x', ?)`).run(NOW);
  db.prepare(`INSERT INTO incidents (id, team_id, title, severity, started_at, created_by, created_at)
    VALUES (1, 1, 't', 'SEV1', ?, 1, ?)`).run(NOW, NOW);
}

function tmpMigrations(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mig-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

test('fresh DB applies 001 and 002; second run is a no-op', () => {
  const db = openDb(':memory:');
  const first = migrate(db);
  assert.deepEqual(first.applied, [1, 2]);
  assert.equal(schemaVersion(db), 2);
  const second = migrate(db);
  assert.deepEqual(second.applied, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c, 2);
});

test('pragmas are applied', () => {
  const db = freshDb();
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
});

test('edited applied migration aborts', () => {
  const dir = tmpMigrations({ '001_a.sql': 'CREATE TABLE a (x INTEGER);' });
  const db = openDb(':memory:');
  migrate(db, { dir });
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER, y INTEGER);');
  assert.throws(() => migrate(db, { dir }), (e) => e instanceof MigrationError && /edited after being applied/.test(e.message));
});

test('database newer than the files aborts', () => {
  const dir = tmpMigrations({
    '001_a.sql': 'CREATE TABLE a (x INTEGER);',
    '002_b.sql': 'CREATE TABLE b (x INTEGER);',
  });
  const db = openDb(':memory:');
  migrate(db, { dir });
  fs.unlinkSync(path.join(dir, '002_b.sql'));
  assert.throws(() => migrate(db, { dir }), (e) => e instanceof MigrationError && /newer than this build/.test(e.message));
});

test('failing migration rolls back and records nothing', () => {
  const dir = tmpMigrations({
    '001_a.sql': 'CREATE TABLE a (x INTEGER);',
    '002_bad.sql': 'CREATE TABLE b (x INTEGER); INSERT INTO nope VALUES (1);',
  });
  const db = openDb(':memory:');
  assert.throws(() => migrate(db, { dir }), MigrationError);
  assert.equal(schemaVersion(db), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='b'").get().c, 0);
});

test('non-contiguous migration versions are refused', () => {
  const dir = tmpMigrations({ '001_a.sql': 'SELECT 1;', '003_c.sql': 'SELECT 1;' });
  assert.throws(() => loadMigrations(dir), MigrationError);
});

test('persists across reopen on a file DB; created directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-db-'));
  const file = path.join(dir, 'nested', 'g.db');
  const a = openDb(file);
  migrate(a);
  seed(a);
  a.close();
  const b = openDb(file);
  assert.deepEqual(migrate(b).applied, []);
  assert.equal(b.prepare('SELECT COUNT(*) AS c FROM incidents').get().c, 1);
  b.close();
});

test('audit trigger blocks UPDATE and DELETE', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO audit_log (at, action, outcome) VALUES (?, 'x', 'ok')`).run(NOW);
  assert.throws(() => db.exec(`UPDATE audit_log SET action = 'y'`), /append-only/);
  assert.throws(() => db.exec('DELETE FROM audit_log'), /append-only/);
  assert.equal(db.prepare('SELECT action FROM audit_log').get().action, 'x');
});

test('CHECK constraints reject bad role, state, status, severity, outcome', () => {
  const db = freshDb();
  seed(db);
  assert.throws(() => db.prepare(`INSERT INTO users (team_id, username, display_name, role, password_hash, created_at)
    VALUES (1, 'u2', 'U', 'admin', 'x', ?)`).run(NOW), /CHECK/);
  assert.throws(() => db.prepare(`INSERT INTO incidents (team_id, title, severity, started_at, created_by, created_at)
    VALUES (1, 't', 'SEV9', ?, 1, ?)`).run(NOW, NOW), /CHECK/);
  assert.throws(() => db.prepare(`INSERT INTO drafts (incident_id, team_id, state, provider, is_fallback, generated_at)
    VALUES (1, 1, 'weird', 'cli', 0, ?)`).run(NOW), /CHECK/);
  // published without published_at violates the paired check
  assert.throws(() => db.prepare(`INSERT INTO drafts (incident_id, team_id, state, provider, is_fallback, generated_at)
    VALUES (1, 1, 'published', 'cli', 0, ?)`).run(NOW), /CHECK/);
  db.prepare(`INSERT INTO drafts (id, incident_id, team_id, state, provider, is_fallback, generated_at)
    VALUES (1, 1, 1, 'draft', 'cli', 0, ?)`).run(NOW);
  assert.throws(() => db.prepare(`INSERT INTO statements (draft_id, section, position, text, cites, status)
    VALUES (1, 'summary', 0, 'x', '[]', 'maybe')`).run(), /CHECK/);
  assert.throws(() => db.prepare(`INSERT INTO statements (draft_id, section, position, text, cites, status)
    VALUES (1, 'bogus', 0, 'x', '[]', 'verified')`).run(), /CHECK/);
  assert.throws(() => db.prepare(`INSERT INTO audit_log (at, action, outcome) VALUES (?, 'x', 'meh')`).run(NOW), /CHECK/);
});

test('foreign keys are enforced', () => {
  const db = freshDb();
  seed(db);
  assert.throws(() => db.prepare(`INSERT INTO users (team_id, username, display_name, role, password_hash, created_at)
    VALUES (99, 'ghost', 'G', 'viewer', 'x', ?)`).run(NOW), /FOREIGN KEY/);
  assert.throws(() => db.prepare(`INSERT INTO note_lines (incident_id, n, time, author, text)
    VALUES (99, 1, '10:00', 'a', 't')`).run(), /FOREIGN KEY/);
  // cascade: deleting an incident removes its notes
  db.prepare(`INSERT INTO note_lines (incident_id, n, time, author, text) VALUES (1, 1, '10:00', 'a', 't')`).run();
  db.exec('DELETE FROM incidents WHERE id = 1');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM note_lines').get().c, 0);
});

test('username is unique case-insensitively', () => {
  const db = freshDb();
  seed(db);
  assert.throws(() => db.prepare(`INSERT INTO users (team_id, username, display_name, role, password_hash, created_at)
    VALUES (1, 'LEAD', 'L2', 'viewer', 'x', ?)`).run(NOW), /UNIQUE/);
});

test('SQL metacharacters round-trip as data with parameters', () => {
  const db = freshDb();
  seed(db);
  const evil = `x'); DROP TABLE users;--`;
  db.prepare(`INSERT INTO note_lines (incident_id, n, time, author, text) VALUES (1, 1, '10:00', 'a', ?)`).run(evil);
  assert.equal(db.prepare('SELECT text FROM note_lines').get().text, evil);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 1);
});

test('tx commits, rolls back on throw, refuses async callbacks and nesting', async () => {
  const db = freshDb();
  seed(db);
  assert.equal(tx(db, () => { db.exec(`UPDATE incidents SET title = 'a'`); return 7; }), 7);
  assert.equal(db.prepare('SELECT title FROM incidents').get().title, 'a');

  assert.throws(() => tx(db, () => { db.exec(`UPDATE incidents SET title = 'b'`); throw new Error('boom'); }), /boom/);
  assert.equal(db.prepare('SELECT title FROM incidents').get().title, 'a');

  assert.throws(() => tx(db, async () => { db.exec(`UPDATE incidents SET title = 'c'`); }), /synchronous/);
  assert.equal(db.prepare('SELECT title FROM incidents').get().title, 'a');
  assert.equal(db.isTransaction, false);

  assert.throws(() => tx(db, () => tx(db, () => 1)), /nested/);
  assert.equal(db.isTransaction, false);
  // db.tx is bound
  assert.equal(db.tx(() => 3), 3);
});
