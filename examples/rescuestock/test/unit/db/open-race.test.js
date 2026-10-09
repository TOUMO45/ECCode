import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPEN_RETRY_MIN_BUDGET_MS, openDb, retryWhileBusy } from '../../../src/db/connection.js';
import { isBusyError } from '../../../src/db/errors.js';
import { tempDir } from '../http/app-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrateChild = join(here, 'migrate-child.js');
const lockHolder = join(here, 'lock-holder.js');
const NODE_ARGS = ['--disable-warning=ExperimentalWarning'];

function busyError() {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
}

function runMigrateChild(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [...NODE_ARGS, migrateChild, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

function startLockHolder(file, holdMs) {
  const proc = spawn(process.execPath, [...NODE_ARGS, lockHolder, file, String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise((resolve, reject) => {
    proc.stdout.once('data', () => resolve());
    proc.once('error', reject);
    proc.once('exit', (code) => reject(new Error(`lock holder exited early with ${code}`)));
  });
  const done = new Promise((resolve) => proc.once('exit', resolve));
  return { ready, done };
}

test('PB-1: retryWhileBusy retries SQLITE_BUSY with back-off and returns the first success', () => {
  let calls = 0;
  const result = retryWhileBusy(() => {
    calls += 1;
    if (calls < 4) throw busyError();
    return 'done';
  }, 1000);
  assert.equal(result, 'done');
  assert.equal(calls, 4);
});

test('PB-1: retryWhileBusy is bounded: it rethrows the busy error once the budget has passed', () => {
  let calls = 0;
  const started = Date.now();
  assert.throws(
    () => retryWhileBusy(() => { calls += 1; throw busyError(); }, 150),
    (e) => isBusyError(e),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 140 && elapsed < 1500, `gave up after ${elapsed} ms`);
  assert.ok(calls >= 2 && calls < 200, `${calls} attempts`);
});

test('PB-1: retryWhileBusy does not retry errors that are not SQLITE_BUSY', () => {
  let calls = 0;
  const boom = new Error('boom');
  assert.throws(() => retryWhileBusy(() => { calls += 1; throw boom; }, 1000), (e) => e === boom);
  assert.equal(calls, 1);
  const constraint = Object.assign(new Error('constraint'), { code: 'ERR_SQLITE_ERROR', errcode: 1555 });
  assert.throws(() => retryWhileBusy(() => { throw constraint; }, 1000), (e) => e === constraint);
});

test('PB-1: openDb waits for a competing process to release its lock instead of failing with SQLITE_BUSY, even with busy_timeout 0', async () => {
  const file = join(tempDir('rs-open-'), 'app.db');
  const holder = startLockHolder(file, 400);
  await holder.ready;
  const started = Date.now();
  const db = openDb(file, { busyTimeoutMs: 0 });
  const waited = Date.now() - started;
  try {
    assert.equal(Object.values(db.prepare('PRAGMA journal_mode').get())[0], 'wal');
    assert.ok(waited >= 100, `openDb returned after ${waited} ms, before the holder released the lock`);
  } finally {
    db.close();
    await holder.done;
  }
});

test('PB-1: openDb gives up with the SQLITE_BUSY error after its bounded budget when the lock is never released', async () => {
  const file = join(tempDir('rs-open-'), 'app.db');
  const holder = startLockHolder(file, OPEN_RETRY_MIN_BUDGET_MS + 1500);
  await holder.ready;
  const started = Date.now();
  assert.throws(() => openDb(file, { busyTimeoutMs: 0 }), (e) => isBusyError(e));
  const waited = Date.now() - started;
  assert.ok(waited >= OPEN_RETRY_MIN_BUDGET_MS - 50 && waited < OPEN_RETRY_MIN_BUDGET_MS + 1000, `gave up after ${waited} ms`);
  await holder.done;
});

test('PB-1: many processes opening and migrating one fresh database file at the same moment all succeed (stress)', async () => {
  const ROUNDS = 25;
  const PROCESSES = 4;
  for (let round = 0; round < ROUNDS; round++) {
    const file = join(tempDir('rs-open-race-'), 'app.db');
    const results = await Promise.all(Array.from({ length: PROCESSES }, () => runMigrateChild(file)));
    for (const r of results) assert.equal(r.code, 0, `round ${round}: a process failed: ${r.err.trim().split('\n')[0]}`);
    const applied = results.flatMap((r) => JSON.parse(r.out.trim()).applied).sort((a, b) => a - b);
    assert.deepEqual(applied, [1, 2, 3, 4, 5], `round ${round}: each migration applied exactly once`);
  }
});
