// In-process worlds for the recovery states of phase F, used by the contract rows of test/api/contracts.test.js that drive
// test/fixtures/contracts/recovery/*.json (supplier refusal, supersession, expiry, abandon, refunds, forced reset). Every builder takes
// a harness from recoveryHarness() (a fresh seeded database, fixed clock, fake adapters, the REAL void port unless `realVoids` is false)
// and drives the real routes; where a state cannot be reached by a route in one step (the drain, the clock) it calls the service the
// reconciler calls. Nothing here reads a fixture and nothing contacts a host other than 127.0.0.1.
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from './app-harness.js';
import { createClient } from './fixtures.js';
import { approveAtFake, cancelAtFake } from './payment-flow.js';
import { approvedPlan, idempotencyKey, reserve } from './plan-flow.js';
import { createVoidPort } from '../../src/services/calls.js';
import { expireDueReservations } from '../../src/services/reservations.js';
import { drainReplanQueue } from '../../src/services/reconciler.js';
import { ensureAdmin } from '../../src/services/users.js';
import { createVoidRule } from '../../src/services/void-rule.js';

export const DAY = '2026-10-20';
export const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const OFFER_IDS = Object.freeze({ A: 1, B: 2 });

/** A seeded in-process application. realVoids false keeps the no-op void port, so a queued void stays outstanding. */
export async function recoveryHarness({ realVoids = true, env = {} } = {}) {
  const h = await startHarness({
    seed: true,
    env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', RS_ADMIN_PASSWORD: ADMIN_PASSWORD, ...env },
  });
  try {
    await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
    if (realVoids) h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  } catch (err) {
    await h.close();
    throw err;
  }
  return h;
}

export async function signInAs(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, username === 'admin' ? ADMIN_PASSWORD : DEMO_PASSWORD);
  return client;
}

export const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
export const armFault = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
export const productOf = (h, code) =>
  h.db.prepare("SELECT p.id FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE s.code = ? AND p.kind = 'bundle'").get(code).id;

/**
 * cafe1 with an approved A + B plan, reserved; `confirm` lists the suppliers who confirm their order, `pay` the suppliers whose
 * PayPal order the buyer approves at the fake page (authorized by the return handler), `cancelPay` the ones cancelled at the fake page.
 * Returns { cafe1, requestId, plan, planId, orders: {A, B}, reservationId }.
 */
export async function reservedWorld(h, { confirm = [], pay = [], cancelPay = [] } = {}) {
  const cafe1 = await signInAs(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const w = {
    cafe1, requestId, plan, planId: plan.id, reservationId: reserved.json.reservation.id,
    orders: Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id])),
  };
  const order = (code) => ({ lines: [{ offerId: OFFER_IDS[code], committedBundles: 1 }], committedReadyAt: READY[code] });
  for (const code of new Set([...confirm, ...pay, ...cancelPay])) {
    const supplier = await signInAs(h, `supplier-${code.toLowerCase()}`);
    const res = await supplier.post(`/api/supplier/orders/${w.orders[code]}/confirm`, order(code));
    assert.equal(res.status, 200, res.text);
  }
  for (const code of pay) await payFor(w, code);
  for (const code of cancelPay) {
    const created = await cafe1.post(`/api/orders/${w.orders[code]}/paypal/create`, {});
    assert.equal(created.status, 200, created.text);
    const { back } = await cancelAtFake(cafe1, created.json.approvalUrl);
    assert.equal(back.status, 303, back.text);
  }
  return w;
}

/** The buyer creates the PayPal order of supplier `code`'s order and approves it at the fake page; the return handler authorizes. */
export async function payFor(w, code) {
  const created = await w.cafe1.post(`/api/orders/${w.orders[code]}/paypal/create`, {});
  assert.equal(created.status, 200, created.text);
  const { ret } = await approveAtFake(w.cafe1, created.json.approvalUrl);
  assert.equal(ret.status, 303, ret.text);
  return ret;
}

/** A plan paid for and executed: both operations captured. */
export async function executedWorld(h) {
  const w = await reservedWorld(h, { pay: ['A', 'B'] });
  const claim = await w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
  assert.equal(claim.status, 202, claim.text);
  await h.app.deps.saga.idle();
  assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(w.planId).status, 'executed');
  return w;
}

export const viewOf = (w) => w.cafe1.get(`/api/requests/${w.requestId}`);

/** Supplier A raises its price: the approved plan is superseded; the re-plan is queued (not drained). */
export async function priceChange(h, code = 'A') {
  const supplier = await signInAs(h, `supplier-${code.toLowerCase()}`);
  const res = await supplier.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [{ productId: productOf(h, code), priceCents: 4600 }] } });
  assert.equal(res.status, 200, res.text);
  return res;
}

export const drain = (h) => drainReplanQueue(h.app.deps);

/** The clock passes the reservation's expiry and the expiry pass runs, as the reconciler does. */
export function expireReservation(h) {
  h.clock.advance(31 * 60 * 1000);
  const pass = expireDueReservations(h.app.deps);
  assert.equal(pass.expired.length, 1, 'one reservation expired');
}
