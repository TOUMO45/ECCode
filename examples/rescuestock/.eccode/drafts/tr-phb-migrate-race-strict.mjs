// technical-reviewer check (phase B re-review, PB-1), strict variant of tr-phb-migrate-race.mjs: runs
// `node --test --test-name-pattern "two processes starting" test/unit/db/migrate.test.js` N times sequentially and
// 3N times three-at-a-time (each run = 4 rounds of 3 processes on a fresh database), and EXITS 1 on any failure.
// Usage: node tr-phb-migrate-race-strict.mjs [N]
import { spawn } from 'node:child_process';

const N = Number(process.argv[2] || 20);
const once = () => new Promise((res) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-name-pattern', 'two processes starting', 'test/unit/db/migrate.test.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (out += c));
  p.on('exit', (code) => res({ code, locked: /database is locked/.test(out), ran: /# pass 1/.test(out) }));
});
let seqFail = 0, seqLocked = 0, parFail = 0, parLocked = 0, notRun = 0;
for (let i = 0; i < N; i++) { const r = await once(); if (r.code !== 0) seqFail++; if (r.locked) seqLocked++; if (!r.ran) notRun++; }
for (let i = 0; i < N; i++) {
  for (const r of await Promise.all([once(), once(), once()])) { if (r.code !== 0) parFail++; if (r.locked) parLocked++; if (!r.ran) notRun++; }
}
console.log(`sequential runs: ${N}, failed: ${seqFail} (database is locked: ${seqLocked})`);
console.log(`parallel runs (3 at a time): ${3 * N}, failed: ${parFail} (database is locked: ${parLocked})`);
console.log(`runs where the test did not run and pass: ${notRun}`);
process.exit(seqFail + parFail + notRun === 0 ? 0 : 1);
