// Unit tests for src/auth/general-limit.js and its use in the access hook (SEC-C-3 / FU-15).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeneralLimiter } from '../../../src/auth/general-limit.js';
import { createAccess } from '../../../src/auth/rbac.js';
import { AppError } from '../../../src/http/envelope.js';
import { insertUser, openTestDb } from './helpers.js';

const fx = openTestDb();
after(() => fx.close());
const userA = insertUser(fx.db, { username: 'gl-a' });
const userB = insertUser(fx.db, { username: 'gl-b' });
const keyCount = (key) => fx.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'general' AND user_key = ?").get(key).n;

describe('SEC-C-3: general limiter', () => {
  test('SEC-C-3: the limit-th call passes, the next is refused as 429 RATE_LIMITED general with Retry-After, and it is not counted', () => {
    const limiter = createGeneralLimiter({ db: fx.db, clock: fx.clock, limit: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) limiter.take(userA);
    assert.throws(
      () => limiter.take(userA),
      (err) => err instanceof AppError && err.status === 429 && err.code === 'RATE_LIMITED' &&
        err.details?.limit === 'general' && err.headers?.['Retry-After'] === '60',
    );
    assert.equal(keyCount(`u:${userA}`), 3);
    limiter.take(userB); // another user has its own count
    assert.equal(keyCount(`u:${userB}`), 1);
  });

  test('SEC-C-3: rows of the window edge expire, Retry-After counts down, and only u:<id> rows of that user are touched', () => {
    const limiter = createGeneralLimiter({ db: fx.db, clock: fx.clock, limit: 3, windowMs: 60_000 });
    const planKey = `plan:u:${userA}`;
    const insert = fx.db.prepare("INSERT INTO rate_events (user_key, kind, at) VALUES (?, 'general', ?)");
    const old = new Date(fx.clock.now() - 3_600_000).toISOString();
    for (let i = 0; i < 5; i++) insert.run(planKey, old); // planning rows, even old ones, are never deleted or counted here
    fx.clock.advance(30_000);
    assert.throws(() => limiter.take(userA), (err) => err.headers['Retry-After'] === '30');
    fx.clock.advance(30_000);
    limiter.take(userA);
    assert.equal(keyCount(`u:${userA}`), 1, 'older rows were deleted');
    assert.equal(keyCount(planKey), 5);
  });

  test('SEC-C-3: the count and the insert run inside one BEGIN IMMEDIATE transaction', () => {
    const seen = [];
    const spy = {
      tx: (fn) => fx.db.tx(fn),
      prepare(sql) {
        const stmt = fx.db.prepare(sql);
        return {
          get: (...a) => (seen.push({ sql: sql.slice(0, 20), inTx: fx.db.inTx }), stmt.get(...a)),
          run: (...a) => (seen.push({ sql: sql.slice(0, 20), inTx: fx.db.inTx }), stmt.run(...a)),
        };
      },
    };
    createGeneralLimiter({ db: spy, clock: fx.clock, limit: 100, windowMs: 60_000 }).take(userB);
    assert.ok(seen.length >= 3, 'delete, count and insert');
    assert.ok(seen.every((s) => s.inTx), JSON.stringify(seen));
  });

  test('SEC-C-3: bad limits are refused', () => {
    for (const bad of [{ limit: 0, windowMs: 1 }, { limit: 1.5, windowMs: 1 }, { limit: 1, windowMs: 0 }]) {
      assert.throws(() => createGeneralLimiter({ db: fx.db, clock: fx.clock, ...bad }), RangeError);
    }
  });
});

describe('SEC-C-3: the limit sits in the access hook after authentication', () => {
  const userC = insertUser(fx.db, { username: 'gl-c' });
  const user = { id: userC, username: 'gl-c', displayName: 'C', role: 'customer', supplierId: null, supplierCode: null };
  const sessions = { resolve: (id) => (id === 'live' ? { user, session: { csrfToken: 'x'.repeat(43) } } : null) };
  const ctxFor = (cookie) => ({
    req: { method: 'GET', headers: { host: 'localhost:3000', ...(cookie ? { cookie: `rs_sid=${cookie}` } : {}) } },
    publicUrl: () => 'http://localhost:3000', user: null, session: null, identified: false,
  });
  const route = { method: 'GET', template: '/api/x', policy: 'customer' };

  test('SEC-C-3: an anonymous call is 401 and is not counted; a signed-in call is counted once; the signature policy is not counted', async () => {
    const limiter = createGeneralLimiter({ db: fx.db, clock: fx.clock, limit: 2, windowMs: 60_000 });
    const access = createAccess({ sessions, publicUrl: () => 'http://localhost:3000', limiter });
    await assert.rejects(access.authorize(ctxFor(null), route), (err) => err.status === 401);
    assert.equal(keyCount(`u:${userC}`), 0);
    await access.authorize(ctxFor('live'), route);
    assert.equal(keyCount(`u:${userC}`), 1);
    await access.authorize(ctxFor('live'), route);
    await assert.rejects(access.authorize(ctxFor('live'), route), (err) => err.status === 429 && err.details.limit === 'general');
    // The webhook route authenticates by signature and is outside the per-user limit.
    await access.authorize(ctxFor(null), { method: 'POST', template: '/api/webhooks/paypal/:merchantKey', policy: 'signature' });
  });
});
