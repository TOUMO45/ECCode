// technical-reviewer reproduction (phase B): how often does the concurrent-start migration test fail?
// Runs `node --test --test-name-pattern "two processes starting" test/unit/db/migrate.test.js` N times (each run does
// 4 rounds of 3 processes opening a fresh database), alone and with 3 copies in parallel (load like npm test's
// --test-concurrency=4), and counts runs whose output contains "database is locked".
// Usage: node tr-phb-migrate-race.mjs [N].  Exit 0 = observations obtained (the counts are the result).
import { spawn } from 'node:child_process';

const N = Number(process.argv[2] || 10);
const once = () => new Promise((res) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-name-pattern', 'two processes starting', 'test/unit/db/migrate.test.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (out += c));
  p.on('exit', (code) => res({ code, locked: /database is locked/.test(out) }));
});
let alone = 0, aloneLocked = 0;
for (let i = 0; i < N; i++) { const r = await once(); if (r.code !== 0) alone++; if (r.locked) aloneLocked++; }
let par = 0, parLocked = 0;
for (let i = 0; i < N; i++) {
  const rs = await Promise.all([once(), once(), once()]);
  for (const r of rs) { if (r.code !== 0) par++; if (r.locked) parLocked++; }
}
console.log(`sequential runs: ${N}, failed: ${alone} (database is locked: ${aloneLocked})`);
console.log(`parallel runs (3 at a time): ${3 * N}, failed: ${par} (database is locked: ${parLocked})`);
process.exit(0);
