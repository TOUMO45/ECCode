'use strict';
// TK-3: the gating Windows CI job failed four of ~25 runs on the concurrent
// CLI writer tests (runs 66, 67, 68, 92: `concurrent writers never corrupt the
// log` and `F7 two concurrent writers …`), one of six `risk add` children
// exiting 1 with its stderr uncaptured. `withLock` opened the lock file with
// 'wx' and treated anything but EEXIST as fatal. On Windows a file another
// process has just unlinked (delete pending) or is holding (a stat in flight,
// a scanner) is reported as EPERM, EACCES or EBUSY, not EEXIST, so a contender
// threw a raw fs error through the CLI's "internal error" branch (exit 1).
// These tests script that shape against a mocked `fs` on every platform: the
// Windows codes are transient like EEXIST, bounded by the same timeout; every
// other code is still thrown at once; the holder's release retries too.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withLock, EccodeError } = require('../lib/util');
const { expectCode } = require('./helpers');

const REAL = { openSync: fs.openSync, statSync: fs.statSync, unlinkSync: fs.unlinkSync };

function fsError(code, syscall, file) {
  const err = new Error(`${code}: mocked ${syscall} '${file}'`);
  err.code = code;
  err.syscall = syscall;
  err.path = file;
  return err;
}

function lockPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-lock-'));
  t.after(() => {
    Object.assign(fs, REAL); // before rmSync, which calls unlinkSync itself on Node 18/20
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, '.lock');
}

/**
 * Replace fs.<name> for calls on `file` only (lib/util.js looks the function
 * up on the module at each call). `impl(n, real)` gets the 1-based call count
 * and the real call. Restored by lockPath's cleanup.
 */
function mock(name, file, impl) {
  const calls = [];
  fs[name] = function (p, ...rest) {
    if (p !== file) return REAL[name].call(fs, p, ...rest);
    calls.push(rest[0]);
    return impl(calls.length, () => REAL[name].call(fs, p, ...rest));
  };
  return calls;
}

/** An impl that refuses the first `times` calls with `code`, then does the real call. */
const refuseThen = (times, code, syscall, file) => (n, real) => {
  if (n <= times) throw fsError(code, syscall, file);
  return real();
};

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`withLock: ${code} from open is transient on the lock file; the callback runs once`, (t) => {
    const lock = lockPath(t);
    const opens = mock('openSync', lock, refuseThen(3, code, 'open', lock));
    let ran = 0;
    const started = Date.now();
    const out = withLock(lock, () => ++ran, { timeoutMs: 2000 });
    assert.strictEqual(out, 1);
    assert.strictEqual(ran, 1);
    assert.strictEqual(opens.length, 4, 'three refusals, then the real open');
    assert.ok(Date.now() - started < 2000, 'acquired well inside the timeout');
    assert.strictEqual(fs.existsSync(lock), false, 'released');
  });
}

test('withLock: two contenders — the holder releases while the other stats, Windows answers EPERM then EACCES (delete pending), the lock is still acquired', (t) => {
  const lock = lockPath(t);
  // Process A holds the lock.
  fs.writeFileSync(lock, JSON.stringify({ pid: 0, at: new Date().toISOString() }));
  const trace = [];
  mock('statSync', lock, (n, real) => {
    trace.push(`stat#${n}`);
    if (n === 1) {
      // A's release lands while B's stat is in flight: the file goes delete
      // pending, which Windows reports to B as EPERM.
      REAL.unlinkSync.call(fs, lock);
      throw fsError('EPERM', 'stat', lock);
    }
    return real();
  });
  mock('openSync', lock, (n, real) => {
    trace.push(`open#${n}`);
    if (n === 1) return real(); // EEXIST: A holds it
    if (n === 2) throw fsError('EACCES', 'open', lock); // delete still pending
    return real();
  });
  let ran = 0;
  const out = withLock(lock, () => ++ran, { timeoutMs: 2000 });
  assert.strictEqual(out, 1);
  assert.strictEqual(ran, 1);
  // open#2 is refused, so B checks staleness again (stat#2: ENOENT, the delete completed) and polls once more.
  assert.deepStrictEqual(trace, ['open#1', 'stat#1', 'open#2', 'stat#2', 'open#3']);
  assert.strictEqual(fs.existsSync(lock), false);
});

test('withLock: a stale lock whose unlink Windows refuses is retried at the poll interval and bounded by timeoutMs, not spun on', (t) => {
  const lock = lockPath(t);
  fs.writeFileSync(lock, '{"pid":0}');
  const old = (Date.now() - 120000) / 1000;
  fs.utimesSync(lock, old, old); // stale: older than staleMs
  const unlinks = mock('unlinkSync', lock, refuseThen(50, 'EPERM', 'unlink', lock));
  let ran = 0;
  const started = Date.now();
  expectCode(() => withLock(lock, () => ++ran, { timeoutMs: 200, staleMs: 30000 }), 'LOCK_TIMEOUT');
  const elapsed = Date.now() - started;
  assert.strictEqual(ran, 0);
  assert.ok(elapsed >= 200 && elapsed < 2000, `timed out after ${elapsed}ms`);
  assert.ok(unlinks.length <= 12, `${unlinks.length} unlink attempts: one per 25ms poll, not a tight loop`);
});

test('withLock: the holder retries a release that Windows refuses, so the next writer does not wait for staleness', (t) => {
  const lock = lockPath(t);
  const unlinks = mock('unlinkSync', lock, refuseThen(2, 'EPERM', 'unlink', lock));
  assert.strictEqual(withLock(lock, () => 'ok'), 'ok');
  assert.strictEqual(unlinks.length, 3);
  assert.strictEqual(fs.existsSync(lock), false, 'the lock file is gone after the callback');
});

test('withLock: a non-transient open error (ENOSPC) is thrown at once, unchanged, without running the callback', (t) => {
  const lock = lockPath(t);
  const opens = mock('openSync', lock, () => {
    throw fsError('ENOSPC', 'open', lock);
  });
  let ran = 0;
  assert.throws(
    () => withLock(lock, () => ++ran, { timeoutMs: 2000 }),
    (err) => err.code === 'ENOSPC' && !(err instanceof EccodeError),
  );
  assert.strictEqual(ran, 0);
  assert.strictEqual(opens.length, 1, 'no retry');
});

test('withLock: a lock held for longer than timeoutMs still ends in LOCK_TIMEOUT when the open keeps answering EBUSY', (t) => {
  const lock = lockPath(t);
  mock('openSync', lock, () => {
    throw fsError('EBUSY', 'open', lock);
  });
  const started = Date.now();
  expectCode(() => withLock(lock, () => 'never', { timeoutMs: 150 }), 'LOCK_TIMEOUT');
  assert.ok(Date.now() - started >= 150);
});
