'use strict';
// TK-3, second candidate cause (review F1 of e488f38): every `risk add` reads
// state.json outside the record lock (commitReserved's preview) while the
// writer inside the lock renames a temp file over it. libuv implements that
// rename as MoveFileEx(REPLACE_EXISTING) without POSIX semantics, which
// Windows refuses with ERROR_ACCESS_DENIED → EPERM while any handle is open
// on the target. A raw EPERM is the CLI's "internal error", exit 1: the shape
// seen in the four failed Windows runs. writeFileAtomic now retries the rename
// for a bounded time on EPERM/EACCES/EBUSY and cleans its temp file up when it
// gives up; every other error is thrown at once.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../lib/util');

const REAL_RENAME = fs.renameSync;

function fsError(code, syscall, file) {
  const err = new Error(`${code}: mocked ${syscall} '${file}'`);
  err.code = code;
  err.syscall = syscall;
  return err;
}

function target(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-rename-'));
  t.after(() => {
    fs.renameSync = REAL_RENAME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'state.json');
}

/** Mock fs.renameSync for renames onto `file`; `impl(n, real)` gets the 1-based call count. */
function mockRename(file, impl) {
  const calls = [];
  fs.renameSync = function (from, to) {
    if (to !== file) return REAL_RENAME.call(fs, from, to);
    calls.push(from);
    return impl(calls.length, () => REAL_RENAME.call(fs, from, to));
  };
  return calls;
}

const tmpFiles = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'));

test('writeFileAtomic: a rename Windows refuses while a reader holds the target (EPERM, twice) is retried and lands', (t) => {
  const file = target(t);
  fs.writeFileSync(file, 'old');
  const renames = mockRename(file, (n, real) => {
    if (n <= 2) throw fsError('EPERM', 'rename', file);
    return real();
  });
  const started = Date.now();
  writeFileAtomic(file, 'new');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  assert.strictEqual(renames.length, 3, 'two refusals, then the real rename');
  assert.ok(Date.now() - started < 1500, 'well inside the retry bound');
  assert.deepStrictEqual(tmpFiles(file), [], 'no temp file left');
});

for (const code of ['EACCES', 'EBUSY']) {
  test(`writeFileAtomic: ${code} on the rename is retried the same way`, (t) => {
    const file = target(t);
    mockRename(file, (n, real) => {
      if (n === 1) throw fsError(code, 'rename', file);
      return real();
    });
    writeFileAtomic(file, 'x');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'x');
    assert.deepStrictEqual(tmpFiles(file), []);
  });
}

test('writeFileAtomic: a rename refused for longer than the bound is thrown as it came and the temp file is removed', (t) => {
  const file = target(t);
  fs.writeFileSync(file, 'old');
  const renames = mockRename(file, () => {
    throw fsError('EPERM', 'rename', file);
  });
  const started = Date.now();
  assert.throws(() => writeFileAtomic(file, 'new', { retryMs: 200 }), (err) => err.code === 'EPERM' && err.syscall === 'rename');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 200 && elapsed < 2000, `gave up after ${elapsed}ms`);
  assert.ok(renames.length >= 2 && renames.length <= 12, `${renames.length} attempts: polled, not spun`);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old', 'the target is untouched');
  assert.deepStrictEqual(tmpFiles(file), [], 'the temp file is cleaned up');
});

test('writeFileAtomic: a non-transient rename error (ENOSPC) is thrown at once, unchanged, and the temp file is removed', (t) => {
  const file = target(t);
  const renames = mockRename(file, () => {
    throw fsError('ENOSPC', 'rename', file);
  });
  assert.throws(() => writeFileAtomic(file, 'x'), (err) => err.code === 'ENOSPC');
  assert.strictEqual(renames.length, 1, 'no retry');
  assert.strictEqual(fs.existsSync(file), false);
  assert.deepStrictEqual(tmpFiles(file), []);
});
