// RS-14 (lock half): a server with busy_timeout = 0 (RS_DB_BUSY_TIMEOUT_MS=0) answers reserve with 503 DB_BUSY and
// Retry-After while another OS process holds the write lock (BEGIN IMMEDIATE). SQLITE_BUSY is mapped, never leaked
// as a 500, nothing is stored, and the same Idempotency-Key succeeds after the lock is released (a 5xx is not stored).
//
// PB-4 / FU-10: the server is started (migrations need the write lock) and the plan is approved BEFORE the lock is
// taken; only the reserve call runs under the lock.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '../helpers/fixtures.js';
import { holdWriteLock } from '../helpers/lock-proc.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { SEED_PASSWORD, startServer, upcomingDemoDate } from '../helpers/server-proc.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

describe('RS-14: a held write lock and busy_timeout = 0 give 503 DB_BUSY with Retry-After', () => {
  test('RS-14: reserve under a lock held by another process is 503 DB_BUSY + Retry-After, stores nothing, and the same key succeeds once the lock is released', async () => {
    const demoDate = upcomingDemoDate();
    const server = await startServer({ env: { RS_DB_BUSY_TIMEOUT_MS: '0', RS_DEMO_DATE: demoDate }, seed: true });
    cleanups.push(() => server.cleanup());

    const client = createClient(server.request);
    await client.signIn('cafe1', SEED_PASSWORD);
    const { plan } = await approvedPlan(client, demoDate);
    const key = idempotencyKey('busy1');

    const lock = await holdWriteLock(server.dbPath);
    cleanups.push(() => lock.release());
    assert.notEqual(lock.pid, server.pid, 'the lock is held by a different process');

    const busy = await reserve(client, plan.id, key);
    assert.equal(busy.status, 503, busy.text);
    assert.equal(busy.json.error.code, 'DB_BUSY');
    assert.equal(busy.headers['retry-after'], '1', 'Retry-After tells the client to try again');
    assert.equal(typeof busy.json.error.requestId, 'string');
    assert.equal(busy.headers['x-request-id'], busy.json.error.requestId);
    assert.doesNotMatch(busy.text, /SQLITE|database is locked|stack/i, 'the answer leaks no SQL or driver text');
    assert.doesNotMatch(`${server.stderr()}`, /Error|SQLITE/, 'the server wrote no stack trace');

    await lock.release();

    const reader = new DatabaseSync(server.dbPath, { readOnly: true });
    try {
      assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, 0, 'no reservation was stored');
      assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get().n, 0, 'a 5xx is not stored under the key');
      assert.equal(reader.prepare('SELECT COALESCE(SUM(reserved), 0) AS n FROM inventory').get().n, 0);
    } finally {
      reader.close();
    }

    const retry = await reserve(client, plan.id, key);
    assert.equal(retry.status, 201, retry.text);
    assert.equal(retry.json.reservation.status, 'active');
  });

  test('RS-14: without the lock the same server answers reserve normally (the 503 comes from the lock, not from busy_timeout = 0)', async () => {
    const demoDate = upcomingDemoDate();
    const server = await startServer({ env: { RS_DB_BUSY_TIMEOUT_MS: '0', RS_DEMO_DATE: demoDate }, seed: true });
    cleanups.push(() => server.cleanup());
    const client = createClient(server.request);
    await client.signIn('cafe2', SEED_PASSWORD);
    const { plan } = await approvedPlan(client, demoDate);
    const res = await reserve(client, plan.id, idempotencyKey('free1'));
    assert.equal(res.status, 201, res.text);
  });
});
