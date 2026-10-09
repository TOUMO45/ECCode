// PB-1 probe: start K child processes at once on a fresh database file, each doing
// only the PRAGMA sequence of the ORIGINAL openDb (no retry), and report error codes.
// Usage: node b1-pb1-probe.mjs <rounds> <processes> [mode]   mode: raw (default) | check-first
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [rounds, procs, mode] = [Number(process.argv[2] || 50), Number(process.argv[3] || 3), process.argv[4] || 'raw'];

const childSource = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
try {
  db.exec('PRAGMA busy_timeout = 5000');
  if (${JSON.stringify(mode)} === 'check-first') {
    const m = db.prepare('PRAGMA journal_mode').get().journal_mode;
    if (m !== 'wal') db.exec('PRAGMA journal_mode = WAL');
  } else {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE'); db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER)'); db.exec('COMMIT');
  console.log('ok');
} catch (e) { console.log('ERR ' + e.errcode + ' ' + e.message); }
`;

const run = (file) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', childSource, file], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (c) => (out += c));
  p.on('exit', () => resolve(out.trim()));
});

const tally = {};
for (let i = 0; i < rounds; i++) {
  const file = join(mkdtempSync(join(tmpdir(), 'rs-probe-')), 'app.db');
  const results = await Promise.all(Array.from({ length: procs }, () => run(file)));
  for (const r of results) tally[r] = (tally[r] || 0) + 1;
}
console.log(JSON.stringify(tally, null, 1));
