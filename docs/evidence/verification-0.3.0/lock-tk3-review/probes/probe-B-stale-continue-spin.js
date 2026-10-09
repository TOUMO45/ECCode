'use strict';
// Probe B (reviewer): the stale branch's `continue` skips the timeout check.
// If stat keeps reporting a stale file, unlink keeps "succeeding" without
// removing it, and open keeps being refused, does withLock ever time out?
// Expected on e488f38: it does not (run under `timeout`).
const path = require('path');
const fs = require('fs');
const os = require('os');
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const { withLock } = require(path.join(root, 'lib', 'util'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-probeB-'));
const lock = path.join(dir, '.lock');
const REAL = { openSync: fs.openSync, statSync: fs.statSync, unlinkSync: fs.unlinkSync };
let opens = 0;
let unlinks = 0;
fs.openSync = (p, ...r) => {
  if (p !== lock) return REAL.openSync(p, ...r);
  opens++;
  const e = new Error('EPERM mocked open');
  e.code = 'EPERM';
  throw e;
};
fs.statSync = (p, ...r) => (p === lock ? { mtimeMs: Date.now() - 120000 } : REAL.statSync(p, ...r));
fs.unlinkSync = (p, ...r) => {
  if (p !== lock) return REAL.unlinkSync(p, ...r);
  unlinks++; // reports success, removes nothing (delete-pending shape)
};
const started = Date.now();
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  console.log(`killed after ${Date.now() - started}ms: ${opens} opens, ${unlinks} unlinks, no LOCK_TIMEOUT (timeoutMs=300)`);
  process.exit(3);
});
try {
  withLock(lock, () => 'never', { timeoutMs: 300 });
  console.log('acquired (unexpected)');
} catch (err) {
  console.log(`threw ${err.code} after ${Date.now() - started}ms: ${opens} opens, ${unlinks} unlinks`);
}
clearInterval(timer);
