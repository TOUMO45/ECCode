'use strict';
// Probe C (reviewer):
//  C1. writeSync throws EPERM after openSync('wx') succeeded: the catch treats
//      it as contention; what happens to the lock file and the fd?
//  C2. A permanently refused open (EACCES: e.g. a read-only .eccode dir) now
//      ends in LOCK_TIMEOUT: does the message carry the underlying code?
const path = require('path');
const fs = require('fs');
const os = require('os');
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const { withLock } = require(path.join(root, 'lib', 'util'));

const REAL = { openSync: fs.openSync, writeSync: fs.writeSync };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-probeC-'));

// C1
{
  const lock = path.join(dir, 'c1.lock');
  let fdSeen = null;
  fs.writeSync = (fd, ...r) => {
    if (fdSeen === null) {
      fdSeen = fd;
      const e = new Error('EPERM mocked write');
      e.code = 'EPERM';
      throw e;
    }
    return REAL.writeSync(fd, ...r);
  };
  const started = Date.now();
  let ran = 0;
  try {
    withLock(lock, () => ++ran, { timeoutMs: 300 });
    console.log(`C1: acquired, fn ran ${ran}x`);
  } catch (err) {
    console.log(`C1: threw ${err.code} after ${Date.now() - started}ms; fn ran ${ran}x; lock file still exists: ${fs.existsSync(lock)}`);
  }
  let fdOpen = true;
  try {
    fs.fstatSync(fdSeen);
  } catch {
    fdOpen = false;
  }
  console.log(`C1: first fd (${fdSeen}) still open (leaked): ${fdOpen}`);
  fs.writeSync = REAL.writeSync;
}

// C2
{
  const lock = path.join(dir, 'c2.lock');
  fs.openSync = (p, ...r) => {
    if (p !== lock) return REAL.openSync(p, ...r);
    const e = new Error("EACCES: permission denied, open '" + lock + "'");
    e.code = 'EACCES';
    throw e;
  };
  const started = Date.now();
  try {
    withLock(lock, () => 'never', { timeoutMs: 300 });
  } catch (err) {
    console.log(`C2: after ${Date.now() - started}ms -> [${err.code}] ${err.message}`);
    console.log(`C2: message names EACCES: ${/EACCES/.test(err.message)}`);
  }
  fs.openSync = REAL.openSync;
}
