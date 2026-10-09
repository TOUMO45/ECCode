import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../src/db/connection.js';
import { REQUEST_ID_PATTERN } from '../../../src/http/request-id.js';
import { startTestApp } from './app-fixture.js';

function writeRoute(router, { db }) {
  router.add(
    'POST',
    '/api/test/write',
    () => {
      db.tx(() => {
        db.prepare("INSERT INTO meta (key, value) VALUES ('written', 'yes') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
      });
      return { status: 200, body: { written: true } };
    },
    { policy: 'public' },
  );
}

test('RS-14: SQLITE_BUSY after the busy timeout answers 503 DB_BUSY with Retry-After: 1 in the error envelope', async () => {
  const t = await startTestApp({ routes: [writeRoute], dbBusyTimeoutMs: 0 });
  const holder = openDb(t.config.dbPath, { busyTimeoutMs: 0 });
  try {
    holder.exec('BEGIN IMMEDIATE');
    const busy = await t.request({ method: 'POST', path: '/api/test/write', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(busy.status, 503);
    assert.equal(busy.json.error.code, 'DB_BUSY');
    assert.equal(busy.headers['retry-after'], '1');
    assert.match(busy.json.error.requestId, REQUEST_ID_PATTERN);
    assert.equal(busy.json.error.requestId, busy.headers['x-request-id']);
    assert.doesNotMatch(busy.text, /SQLITE|database is locked|INSERT/i);
    assert.equal(t.db.inTx, false, 'the failed transaction left no state behind');
    holder.exec('ROLLBACK');

    const retry = await t.request({ method: 'POST', path: '/api/test/write', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(retry.status, 200, 'the same request succeeds once the lock is gone');
    assert.equal(retry.json.written, true);
  } finally {
    try {
      holder.exec('ROLLBACK');
    } catch {
      // Already rolled back.
    }
    holder.close();
    await t.close();
  }
});

test('RS-14: DB_BUSY is not logged as an unexpected error', async () => {
  const t = await startTestApp({ routes: [writeRoute], dbBusyTimeoutMs: 0 });
  const holder = openDb(t.config.dbPath, { busyTimeoutMs: 0 });
  try {
    holder.exec('BEGIN IMMEDIATE');
    const busy = await t.request({ method: 'POST', path: '/api/test/write', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(busy.status, 503);
    await new Promise((resolve) => setImmediate(resolve));
    const entries = t.logEntries();
    assert.ok(!entries.some((e) => e.msg === 'http.error'));
    const line = entries.find((e) => e.msg === 'http.request' && e.requestId === busy.headers['x-request-id']);
    assert.equal(line.status, 503);
    assert.equal(line.code, 'DB_BUSY');
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
    await t.close();
  }
});
