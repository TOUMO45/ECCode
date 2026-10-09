import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCsrf, safeEqual, originOk, loadCsrfKey } from '../../../src/auth/csrf.js';
import { createLoginLimiter } from '../../../src/auth/ratelimit.js';
import { authorize, POLICY } from '../../../src/auth/rbac.js';
import { openDb } from '../../../src/db/connection.js';
import { migrate } from '../../../src/db/migrate.js';
import crypto from 'node:crypto';

test('csrf pre-login token verifies, tampering fails', () => {
  const c = createCsrf(crypto.randomBytes(32));
  const t = c.issue();
  assert.equal(c.verifyPrelogin(t), true);
  assert.equal(c.verifyPrelogin(`${t}x`), false);
  assert.equal(c.verifyPrelogin(`A${t.slice(1)}`), false);
  assert.equal(c.verifyPrelogin('nodot'), false);
  assert.equal(c.verifyPrelogin(undefined), false);
  assert.equal(createCsrf(crypto.randomBytes(32)).verifyPrelogin(t), false);
});

test('csrf key persists in meta so tokens survive restart', () => {
  const db = openDb(':memory:');
  migrate(db);
  const t = createCsrf(loadCsrfKey(db)).issue();
  assert.equal(createCsrf(loadCsrfKey(db)).verifyPrelogin(t), true);
});

test('safeEqual and originOk', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', undefined), false);
  assert.equal(originOk({ host: 'x:1' }), true);
  assert.equal(originOk({ host: 'x:1', origin: 'http://x:1' }), true);
  assert.equal(originOk({ host: 'x:1', origin: 'http://evil.test' }), false);
  assert.equal(originOk({ host: 'x:1', origin: 'null' }), false);
});

test('limiter: 5 failures then limited with Retry-After; window slides; success clears', () => {
  let now = 1_000_000;
  const l = createLoginLimiter({ clock: () => now });
  for (let i = 0; i < 5; i++) { assert.equal(l.check('k').limited, false); l.fail('k'); now += 1000; }
  const r = l.check('k');
  assert.equal(r.limited, true);
  assert.ok(r.retryAfterSeconds > 0 && r.retryAfterSeconds <= 900);
  now += 15 * 60 * 1000;
  assert.equal(l.check('k').limited, false);
  l.fail('k'); l.clear('k');
  assert.equal(l.size, 0);
});

test('limiter: map is capped and evicts oldest first; expired keys are swept', () => {
  let now = 0;
  const l = createLoginLimiter({ clock: () => now, maxKeys: 100 });
  for (let i = 0; i < 250; i++) { l.fail(`u${i}`); now += 1; }
  assert.equal(l.size, 100);
  assert.equal(l.check('u0').limited, false);
  now += 20 * 60 * 1000;
  l.fail('fresh');
  assert.equal(l.size, 1);
});

test('rbac: default deny, matrix per spec 3.9', () => {
  const u = (role) => ({ role });
  assert.equal(authorize(u('viewer'), 'postmortem.read'), true);
  assert.equal(authorize(u('viewer'), 'incident.list'), false);
  assert.equal(authorize(u('responder'), 'draft.generate'), true);
  assert.equal(authorize(u('responder'), 'draft.publish'), false);
  assert.equal(authorize(u('lead'), 'audit.read'), true);
  assert.equal(authorize(u('lead'), 'nonsense'), false);
  assert.equal(authorize(u('root'), 'me'), false);
  assert.equal(authorize(null, 'me'), false);
  assert.equal(authorize(u('lead'), '__proto__'), false);
  assert.ok(Object.isFrozen(POLICY));
});
