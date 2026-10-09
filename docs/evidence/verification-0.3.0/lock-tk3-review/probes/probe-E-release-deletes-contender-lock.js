'use strict';
// Probe E (reviewer): the release unlinks whatever file sits at lockFile. If
// the holder's fn outlives staleMs, a contender breaks the lock and acquires;
// the holder's release then deletes the contender's lock and a third process
// gets in while the contender is still inside fn. Pre-existing in 6a2b869
// (same unconditional unlink); the retry loop in e488f38 does not widen it
// beyond ~250 ms. Usage: node probe-E… <dir>  (parent) | --role <name> <dir> <holdMs>
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');

if (process.argv[2] === '--role') {
  const [, , , role, dir, holdMs] = process.argv;
  const { withLock } = require(path.join(root, 'lib', 'util'));
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const lock = path.join(dir, '.lock');
  withLock(
    lock,
    () => {
      const others = fs.readdirSync(dir).filter((f) => f.startsWith('busy-'));
      fs.writeFileSync(path.join(dir, `busy-${role}`), '');
      console.log(`${role}: entered critical section at +${Date.now() % 100000}ms; others inside: ${others.join(',') || 'none'}`);
      sleepSync(Number(holdMs));
      fs.unlinkSync(path.join(dir, `busy-${role}`));
    },
    { timeoutMs: 5000, staleMs: 200 },
  );
  console.log(`${role}: released; lock file present after release: ${fs.existsSync(lock)}`);
  return;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-probeE-'));
const run = (role, hold) =>
  new Promise((res) => {
    const p = spawn(process.execPath, [__filename, '--role', role, dir, String(hold)], { stdio: 'inherit' });
    p.on('exit', res);
  });
(async () => {
  const a = run('A-holder', 700); // stale after 200 ms
  await new Promise((r) => setTimeout(r, 350));
  const b = run('B-breaker', 1500); // breaks A's stale lock, holds 1.5 s
  await new Promise((r) => setTimeout(r, 650)); // A releases at ~700 ms and unlinks B's lock
  const c = run('C-third', 100); // should wait for B; gets in if B's lock was deleted
  await Promise.all([a, b, c]);
})();
