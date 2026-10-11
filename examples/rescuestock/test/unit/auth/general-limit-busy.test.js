// SEC-R-1 (rework-1 review): the general limiter takes the SQLite write lock (BEGIN IMMEDIATE) on every signed-in call, so a long
// write elsewhere (the reconciler tick, a saga step) turned every signed-in GET into a wait and then a 503. For GET and HEAD a
// busy error now fails open: the request proceeds uncounted and one `rate_limit.busy_open` line is logged. Anything that can
// change state keeps failing closed (the busy error surfaces and the app maps it to 503 DB_BUSY).
// The lock is held by another OS process (test/helpers/lock-holder.js), so SQLite really answers SQLITE_BUSY.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeneralLimiter } from '../../../src/auth/general-limit.js';
import { createAccess } from '../../../src/auth/rbac.js';
import { openDb } from '../../../src/db/connection.js';
import { mapDbError } from '../../../src/db/errors.js';
import { AppError } from '../../../src/http/envelope.js';
import { createLogger } from '../../../src/log.js';
import { holdWriteLock } from '../../helpers/lock-proc.js';
import { insertUser, openTestDb } from './helpers.js';

const fx = openTestDb(); // busy_timeout 1000 ms
after(() => fx.close());
const user = insertUser(fx.db, { username: 'busy-a' });
const USERNAME = 'busy-a';
const count = () => fx.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?").get(`u:${user}`).n;

function logger() {
  const lines = [];
  return { lines, log: createLogger({ write: (line) => lines.push(JSON.parse(line)) }).child('req-busy-1') };
}

describe('SEC-R-1: a held write lock', () => {
  let lock;
  let quick; // a second connection with a short busy timeout, so the fail-closed cases do not each wait a second
  before(async () => {
    quick = openDb(`${fx.dir}/app.db`, { busyTimeoutMs: 100 });
    lock = await holdWriteLock(`${fx.dir}/app.db`);
  });
  after(async () => {
    await lock.release();
    quick.close();
  });

  test('SEC-R-1: a GET under a held write lock proceeds without waiting for the busy timeout, is not counted, and logs one rate_limit.busy_open line with the request id and no identifiers', () => {
    const limiter = createGeneralLimiter({ db: fx.db, clock: fx.clock, limit: 5, windowMs: 60_000 });
    const { lines, log } = logger();
    const started = Date.now();
    limiter.take(user, { method: 'GET', log, requestId: 'req-busy-1' }); // does not throw
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `the read waited ${elapsed} ms (busy timeout ${fx.db.busyTimeoutMs} ms)`);
    assert.equal(fx.db.busyTimeoutMs, 1000);
    assert.equal(Object.values(fx.db.prepare('PRAGMA busy_timeout').get())[0], 1000, 'the connection busy timeout is restored');
    assert.equal(count(), 0, 'the call was not counted');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].msg, 'rate_limit.busy_open');
    assert.equal(lines[0].requestId, 'req-busy-1');
    assert.doesNotMatch(JSON.stringify(lines[0]), new RegExp(`${USERNAME}|"userId"|u:${user}`), 'no identifier in the line');
  });

  test('SEC-R-1: HEAD fails open the same way', () => {
    const limiter = createGeneralLimiter({ db: fx.db, clock: fx.clock, limit: 5, windowMs: 60_000 });
    const { lines, log } = logger();
    limiter.take(user, { method: 'HEAD', log });
    assert.equal(count(), 0);
    assert.equal(lines.length, 1);
  });

  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    test(`SEC-R-1: a ${method} under the held write lock keeps the existing refusal (the busy error, 503 DB_BUSY with Retry-After 1), is not counted and logs nothing`, () => {
      const limiter = createGeneralLimiter({ db: quick, clock: fx.clock, limit: 5, windowMs: 60_000 });
      const { lines, log } = logger();
      let caught = null;
      try {
        limiter.take(user, { method, log });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'the busy error surfaces');
      const mapped = mapDbError(caught);
      assert.ok(mapped instanceof AppError && mapped.status === 503 && mapped.code === 'DB_BUSY' && mapped.headers['Retry-After'] === '1', String(caught));
      assert.equal(count(), 0);
      assert.deepEqual(lines, []);
    });
  }

  test('SEC-R-1: a call that names no method (the old take(userId) form) is treated as state-changing and fails closed', () => {
    const limiter = createGeneralLimiter({ db: quick, clock: fx.clock, limit: 5, windowMs: 60_000 });
    assert.throws(() => limiter.take(user), (err) => mapDbError(err).code === 'DB_BUSY');
  });
});

describe('SEC-R-1: without a lock, nothing changes', () => {
  test('SEC-R-1: a GET is counted and a GET over the limit is still 429 RATE_LIMITED general (only a busy error fails open)', () => {
    const limiter = createGeneralLimiter({ db: fx.db, clock: fx.clock, limit: 2, windowMs: 60_000 });
    limiter.take(user, { method: 'GET' });
    limiter.take(user, { method: 'HEAD' });
    assert.equal(count(), 2);
    assert.throws(
      () => limiter.take(user, { method: 'GET' }),
      (err) => err instanceof AppError && err.status === 429 && err.details?.limit === 'general',
    );
    assert.equal(count(), 2);
  });

  test('SEC-R-1: a GET whose transaction fails for any other reason than busy is not swallowed', () => {
    const boom = new Error('disk I/O error');
    const broken = { tx: () => { throw boom; }, prepare: () => assert.fail('unused') };
    const limiter = createGeneralLimiter({ db: broken, clock: fx.clock, limit: 5, windowMs: 60_000 });
    assert.throws(() => limiter.take(user, { method: 'GET' }), (err) => err === boom);
  });

  test('SEC-R-1: a GET busy error on a database object without pragma access still fails open, and the log is optional', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    const limiter = createGeneralLimiter({ db: { tx: () => { throw busy; } }, clock: fx.clock, limit: 5, windowMs: 60_000 });
    limiter.take(user, { method: 'GET' });
    assert.throws(() => limiter.take(user, { method: 'POST' }), (err) => err === busy);
  });
});

// The access hook is what calls the limiter. It has to hand over the method, the request logger and the request id; until
// src/auth/rbac.js does, a GET reaches take(userId) with no method and fails closed. rbac.js is outside rework-4's files.
describe('SEC-R-1: the access hook passes the method to the limiter', () => {
  // todo: src/auth/rbac.js line 64 must call limiter.take(ctx.user.id, { method: req.method, log: ctx.log, requestId: ctx.requestId }).
  test('SEC-R-1: authorize() gives limiter.take the request method, the logger and the request id', { todo: 'src/auth/rbac.js is outside the files of rework-4' }, async () => {
    const seen = [];
    const limiter = { take: (id, info) => seen.push([id, info]) };
    const account = { id: user, username: USERNAME, displayName: 'B', role: 'customer', supplierId: null, supplierCode: null };
    const sessions = { resolve: () => ({ user: account, session: { csrfToken: 'x'.repeat(43) } }) };
    const access = createAccess({ sessions, publicUrl: () => 'http://localhost:3000', limiter });
    const log = { marker: true };
    const ctx = {
      req: { method: 'GET', headers: { host: 'localhost:3000', cookie: 'rs_sid=live' } },
      publicUrl: () => 'http://localhost:3000', user: null, session: null, identified: false, log, requestId: 'req-1',
    };
    await access.authorize(ctx, { method: 'GET', template: '/api/x', policy: 'customer' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], user);
    assert.deepEqual([seen[0][1]?.method, seen[0][1]?.log, seen[0][1]?.requestId], ['GET', log, 'req-1']);
  });
});
