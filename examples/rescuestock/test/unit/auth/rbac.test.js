// Unit tests for src/auth/rbac.js and the startup policy check (RS-30, T4, ARCH-25).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../src/app.js';
import { WEBHOOK_TEMPLATE, createAccess } from '../../../src/auth/rbac.js';
import { loadConfig } from '../../../src/config.js';
import { AppError } from '../../../src/http/envelope.js';
import { createRouter } from '../../../src/http/router.js';
import { openTestDb } from './helpers.js';

const TOKEN = 'session-csrf-token-0123456789abcdef0123456789a';
const USERS = {
  customer: { id: 1, username: 'cafe1', displayName: 'Cafe', role: 'customer', supplierId: null, supplierCode: null },
  supplier: { id: 2, username: 'supplier-a', displayName: 'Supplier A', role: 'supplier', supplierId: 1, supplierCode: 'A' },
  admin: { id: 3, username: 'admin', displayName: 'Administrator', role: 'admin', supplierId: null, supplierCode: null },
};

// A session store stub: the cookie value is the role name.
function accessFor() {
  const sessions = {
    resolve: (id) => (USERS[id] ? { user: USERS[id], session: { csrfToken: TOKEN } } : null),
  };
  return createAccess({ sessions, publicUrl: () => 'http://localhost:3000' });
}

function ctxFor({ method = 'GET', role = null, token, origin, template = '/api/x' } = {}) {
  const headers = { host: 'localhost:3000' };
  if (role) headers.cookie = `rs_sid=${role}`;
  if (token) headers['x-csrf-token'] = token;
  if (origin !== undefined) headers.origin = origin;
  return { req: { method, headers }, publicUrl: () => 'http://localhost:3000', user: null, session: null, identified: false, template };
}

async function outcome(access, policy, ctxOptions, route = {}) {
  const ctx = ctxFor(ctxOptions);
  try {
    await access.authorize(ctx, { method: ctxOptions?.method ?? 'GET', template: '/api/x', policy, ...route });
    return { ok: true, user: ctx.user };
  } catch (err) {
    assert.ok(err instanceof AppError, `typed error, got ${err?.stack}`);
    return { ok: false, status: err.status, code: err.code };
  }
}

describe('RS-30: RBAC matrix (anonymous 401, wrong role 403)', () => {
  const access = accessFor();
  const expected = {
    session: { anonymous: 401, customer: 200, supplier: 200, admin: 200 },
    customer: { anonymous: 401, customer: 200, supplier: 403, admin: 403 },
    supplier: { anonymous: 401, customer: 403, supplier: 200, admin: 403 },
    admin: { anonymous: 401, customer: 403, supplier: 403, admin: 200 },
  };
  for (const [policy, byRole] of Object.entries(expected)) {
    for (const [who, status] of Object.entries(byRole)) {
      test(`RS-30: policy ${policy} for ${who} on GET -> ${status}`, async () => {
        const result = await outcome(access, policy, { role: who === 'anonymous' ? null : who });
        if (status === 200) assert.equal(result.ok, true);
        else assert.deepEqual({ status: result.status, code: result.code }, { status, code: status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN' });
      });
    }
  }

  test('RS-30: admin routes: anonymous 401, customer and supplier 403, only role admin passes (T4)', async () => {
    for (const method of ['GET', 'POST']) {
      const token = method === 'POST' ? TOKEN : undefined;
      assert.equal((await outcome(access, 'admin', { method })).status, 401);
      assert.equal((await outcome(access, 'admin', { method, role: 'customer', token })).status, 403);
      assert.equal((await outcome(access, 'admin', { method, role: 'supplier', token })).status, 403);
      assert.equal((await outcome(access, 'admin', { method, role: 'admin', token })).ok, true);
    }
  });

  test('RS-30: a wrong role is 403 FORBIDDEN even without a CSRF token (the role is judged first)', async () => {
    const result = await outcome(access, 'admin', { method: 'POST', role: 'customer' });
    assert.deepEqual({ status: result.status, code: result.code }, { status: 403, code: 'FORBIDDEN' });
  });

  test('RS-30: an unknown policy and a non-public policy name other than the six are denied (default deny)', async () => {
    const result = await outcome(access, 'everyone', { role: 'admin' });
    assert.deepEqual({ status: result.status, code: result.code }, { status: 403, code: 'FORBIDDEN' });
    const pub = await outcome(access, 'public', { role: 'admin' });
    assert.equal(pub.ok, false, 'public never reaches the hook; if it does it is not waved through');
  });
});

describe('T6: CSRF on state-changing routes through the hook', () => {
  const access = accessFor();
  const csrfFailed = (r) => assert.deepEqual({ status: r.status, code: r.code }, { status: 403, code: 'CSRF_FAILED' });

  test('T6: a POST needs the session token; GET does not', async () => {
    assert.equal((await outcome(access, 'customer', { role: 'customer' })).ok, true);
    csrfFailed(await outcome(access, 'customer', { method: 'POST', role: 'customer' }));
    csrfFailed(await outcome(access, 'customer', { method: 'POST', role: 'customer', token: 'wrong' }));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await outcome(access, 'customer', { method, role: 'customer', token: TOKEN })).ok, true, method);
      csrfFailed(await outcome(access, 'customer', { method, role: 'customer' }));
    }
  });

  test('T6: a wrong Origin is refused before anything else, even for an anonymous caller', async () => {
    csrfFailed(await outcome(access, 'customer', { method: 'POST', role: 'customer', token: TOKEN, origin: 'http://evil.example' }));
    csrfFailed(await outcome(access, 'customer', { method: 'POST', origin: 'http://evil.example' }));
    assert.equal((await outcome(access, 'customer', { method: 'POST', role: 'customer', token: TOKEN, origin: 'http://localhost:3000' })).ok, true);
  });

  test('T6: only POST /api/webhooks/paypal/:merchantKey with policy signature skips session and CSRF', async () => {
    const hook = { method: 'POST', template: WEBHOOK_TEMPLATE };
    assert.equal((await outcome(access, 'signature', { method: 'POST' }, hook)).ok, true);
    assert.equal((await outcome(access, 'signature', { method: 'POST', origin: 'http://evil.example' }, hook)).ok, true, 'signature-authenticated: no Origin rule');
    const other = await outcome(access, 'signature', { method: 'POST' }, { method: 'POST', template: '/api/orders/:id/refund' });
    assert.deepEqual({ status: other.status, code: other.code }, { status: 403, code: 'FORBIDDEN' });
    const wrongMethod = await outcome(access, 'signature', { method: 'GET' }, { method: 'GET', template: WEBHOOK_TEMPLATE });
    assert.equal(wrongMethod.status, 403);
  });
});

describe('RS-30: handlers of public routes use identify and requireRole', () => {
  const access = accessFor();
  test('RS-30: identify never throws; requireRole is 401 for nobody and 403 for the wrong role', () => {
    const anon = ctxFor();
    assert.equal(access.identify(anon), null);
    assert.equal(anon.session, null);
    const staleCookie = ctxFor({ role: 'nobody' });
    assert.equal(access.identify(staleCookie), null);
    assert.equal(staleCookie.sessionId, 'nobody', 'the raw cookie value is kept so sign-in can destroy it');
    const customer = ctxFor({ role: 'customer' });
    assert.equal(access.requireRole(customer, 'customer').id, 1);
    assert.throws(() => access.requireRole(ctxFor({ role: 'supplier' }), 'customer'), (e) => e.status === 403);
    assert.throws(() => access.requireRole(ctxFor(), 'customer'), (e) => e.status === 401);
  });
});

describe('RS-30: startup refuses a route without a policy', () => {
  const t = openTestDb();
  after(() => t.close());
  const config = loadConfig({ PORT: '0', RS_DB_PATH: `${t.dir}/x.db`, RS_UPLOAD_DIR: `${t.dir}/u`, RS_TEST_OFFLINE: '1' });

  test('RS-30: createApp throws for a route registered without a policy or with an unknown one', () => {
    for (const options of [{}, { policy: undefined }, { policy: 'everyone' }, { policy: 'Admin' }]) {
      assert.throws(
        () => createApp({ db: t.db, clock: t.clock, config, routes: [(router) => router.add('GET', '/api/rogue', () => ({}), options)] }),
        /no valid policy/,
      );
    }
  });

  test('RS-30: every route of the shipped table declares one of the six policies, and public mutating routes are the auth pair only', () => {
    const app = createApp({ db: t.db, clock: t.clock, config });
    const routes = app.router.list();
    assert.ok(routes.length >= 7);
    const valid = new Set(['public', 'session', 'customer', 'supplier', 'admin', 'signature']);
    for (const r of routes) assert.ok(valid.has(r.policy), `${r.method} ${r.template}`);
    const publicMutating = routes.filter((r) => r.policy === 'public' && r.method !== 'GET').map((r) => `${r.method} ${r.template}`).sort();
    assert.deepEqual(publicMutating, ['POST /api/auth/register', 'POST /api/auth/signin'], 'a new public state-changing route needs its own CSRF check and a decision');
    assert.equal(createRouter().list().length, 0);
  });
});
