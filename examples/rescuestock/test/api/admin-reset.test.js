// SEC-11 / RS-37 (task f2-compensation-takeover-admin; spec: Admin routes > Reset, Forced reset):
//   RS-37   an unforced reset is refused (409 RESET_BLOCKED) while money is held, and refuses without side effects; a reset archives
//           operations and provider calls, never deletes them
//   SEC-11  a forced reset first VOIDS every authorized operation and sends the voids, then runs ONE read-resolve pass over the
//           unknown and *_pending operations bounded to 30 s in total, and only then archives; whatever is still not terminal is listed
//           in the response (`stranded`) and in the audit event
//   RS-38   a reset leaves the stock exactly at RS-FIX-1 and the ledger sums equal the columns; a reconciling reservation is closed by
//           the reset and is never restocked on top of the restored stock afterwards
// The real void port is installed (the app's default is a recorder that sends nothing), as startApp does.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { createVoidPort } from '../../src/services/calls.js';
import { createReconciler } from '../../src/services/reconciler.js';
import { RESET_RESOLVE_BUDGET_MS, resetDemo } from '../../src/services/admin.js';
import { ensureAdmin } from '../../src/services/users.js';
import { createVoidRule } from '../../src/services/void-rule.js';

const DAY = '2026-10-20';
const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const REASON = 'Demo retake before the judging session';
const READY = Object.freeze({ A: '2026-10-20T07:00:00.000Z', B: '2026-10-20T07:30:00.000Z' });
const harnesses = [];
after(async () => {
  for (const h of harnesses) await h.close();
});

async function signIn(h, username, password = DEMO_PASSWORD) {
  const client = createClient(h.request);
  await client.signIn(username, password);
  return client;
}

async function start(env = {}) {
  const h = await startHarness({ seed: true, env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD, RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', ...env } });
  harnesses.push(h);
  h.app.deps.voidRule = createVoidRule({ clock: h.clock, provider: createVoidPort({ clock: h.clock }) });
  await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
  h.admin = await signIn(h, 'admin', ADMIN_PASSWORD);
  h.seeded = h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory ORDER BY product_id').all().map((r) => ({ ...r }));
  return h;
}

function postTo(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Length': '0' }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null }));
    });
    req.on('error', reject);
    req.end();
  });
}

const confirmBody = (code) => ({ lines: [{ offerId: code === 'A' ? 1 : 2, committedBundles: 1 }], committedReadyAt: READY[code] });

async function world(h) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, plan.id, idempotencyKey(`${requestId}-${plan.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  for (const code of ['A', 'B']) {
    const supplier = await signIn(h, `supplier-${code.toLowerCase()}`);
    assert.equal((await supplier.post(`/api/supplier/orders/${orders[code]}/confirm`, confirmBody(code))).status, 200);
    const created = await cafe1.post(`/api/orders/${orders[code]}/paypal/create`, {});
    assert.equal(created.status, 200, created.text);
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    const target = new URL(approved.location);
    assert.equal((await cafe1.get(target.pathname + target.search)).status, 303);
  }
  return { cafe1, requestId, planId: plan.id, orders, reservationId: reserved.json.reservation.id };
}

const execute = (w) => w.cafe1.post(`/api/plans/${w.planId}/execute`, {});
const reset = (h, body = {}) => h.admin.post('/api/admin/reset', body);
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const reservation = (h, id) => h.db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
// The reset clears the fake's own tables (and its call counter), so what was SENT is read from the journal, which is archived, not
// deleted; what was READ is seen through a spy on the payment port.
const sentKeys = (h, kind) =>
  h.db.prepare('SELECT operation_key FROM provider_calls WHERE kind = ? AND send_count > 0 ORDER BY id').all(kind).map((r) => r.operation_key);
function spy(h) {
  const real = h.app.deps.payments;
  const log = [];
  // A plain copy (the real port is frozen, so a Proxy could not return wrapped methods).
  h.app.deps.payments = Object.fromEntries(
    Object.entries(real).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? (...args) => {
            log.push(name);
            return value.apply(real, args);
          }
        : value,
    ]),
  );
  return { log, count: (name) => log.filter((n) => n === name).length, restore: () => { h.app.deps.payments = real; } };
}
const fakeCalls = (h, kind) => h.db.prepare('SELECT * FROM fake_paypal_calls WHERE kind = ? ORDER BY id').all(kind);
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const resetAudit = (h) => JSON.parse(h.db.prepare("SELECT detail_json FROM audit_events WHERE action = 'admin.reset' AND outcome = 'ok' ORDER BY id DESC LIMIT 1").get().detail_json);
const restockRows = (h) => count(h, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'restock'");
const stock = (h) => h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory ORDER BY product_id').all().map((r) => ({ ...r }));

function assertLedger(h, label) {
  for (const inv of h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory').all()) {
    const sum = h.db.prepare('SELECT COALESCE(SUM(delta_on_hand),0) AS a, COALESCE(SUM(delta_reserved),0) AS b FROM inventory_ledger WHERE product_id = ?').get(inv.product_id);
    assert.equal(sum.a, inv.on_hand, `${label}: ledger on_hand of product ${inv.product_id}`);
    assert.equal(sum.b, inv.reserved, `${label}: ledger reserved of product ${inv.product_id}`);
  }
}

describe('SEC-11: a forced reset voids what is authorized before it archives', () => {
  test('SEC-11: authorized operations of an approved plan are voided at the provider (one void each, the deterministic key), nothing is stranded, rows are archived not deleted', async () => {
    const h = await start();
    const w = await world(h);
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['authorized', 'authorized']);

    const blocked = await reset(h, {});
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'RESET_BLOCKED');
    assert.deepEqual(sentKeys(h, 'void'), [], 'an unforced reset sends nothing');

    const probe = spy(h);
    const res = await reset(h, { force: true, reason: REASON });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.reset, true);
    assert.equal(res.json.archivedOperations, 2);
    assert.equal('stranded' in res.json, false, 'the voids completed: nothing is left at the provider');
    assert.equal(probe.count('voidAuthorization'), 2, 'one void per authorization');
    assert.deepEqual(sentKeys(h, 'void').sort(), [`so:${w.orders.A}:void:1`, `so:${w.orders.B}:void:1`].sort());
    assert.deepEqual([op(h, w.orders.A).status, op(h, w.orders.B).status], ['voided', 'voided']);
    assert.ok(op(h, w.orders.A).archived_at && op(h, w.orders.B).archived_at);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM payment_operations'), 2, 'never deleted');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM provider_calls WHERE archived_at IS NULL'), 0, 'every provider call is archived');
    assert.ok(count(h, 'SELECT COUNT(*) AS n FROM provider_calls') >= 6, 'and kept: create_order, authorize and void per order');
    assert.equal(plan(h, w.planId).non_executable_reason, 'DEMO_RESET');
    const detail = resetAudit(h);
    assert.equal(detail.force, true);
    assert.equal(detail.reason, REASON);
    assert.equal(detail.authorized, 2);
    assert.deepEqual(detail.stranded, []);
    assertLedger(h, 'after the reset');
    assert.deepEqual(stock(h), h.seeded);
  });

  test('SEC-11: an authorized operation whose plan is executing is voided too (the void rule only sees approved plans); a capture that is still PENDING is listed as stranded with its provider ids', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_pending', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'capture_pending');
    assert.equal(op(h, w.orders.B).status, 'authorized');
    assert.equal(plan(h, w.planId).status, 'executing');
    const pendingCaptureId = op(h, w.orders.A).provider_capture_id;
    const authA = op(h, w.orders.A).provider_authorization_id;

    const probe = spy(h);
    const res = await reset(h, { force: true, reason: REASON });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.stranded, [{ id: op(h, w.orders.A).id, status: 'capture_pending', providerAuthorizationId: authA, providerCaptureId: pendingCaptureId }]);
    assert.deepEqual(sentKeys(h, 'void'), [`so:${w.orders.B}:void:1`], 'B was authorized, so B was voided; A holds a capture and is not');
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.equal(op(h, w.orders.A).status, 'capture_pending');
    assert.ok(op(h, w.orders.A).archived_at, 'archived all the same');
    assert.deepEqual(resetAudit(h).stranded, [{ id: op(h, w.orders.A).id, status: 'capture_pending' }]);
    assert.equal(probe.count('getCapture'), 1, 'the pending capture was read once');
    assert.equal(probe.count('captureAuthorization'), 0, 'and nothing was captured');
    assertLedger(h, 'after the reset');
  });

  test('SEC-11: the read-resolve pass resolves an unknown operation by reading (the lost capture is found COMPLETED) before it archives; the captured money is listed as stranded', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'lost_response:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');
    const probe = spy(h);

    const res = await reset(h, { force: true, reason: REASON });
    assert.equal(res.status, 200, res.text);
    assert.equal(probe.count('captureAuthorization'), 0, 'the pass reads; it never sends a capture');
    assert.ok(probe.count('getAuthorization') >= 1);
    assert.equal(op(h, w.orders.A).status, 'captured', 'resolved from the provider state before the archive');
    assert.equal(res.json.stranded.length, 1);
    assert.equal(res.json.stranded[0].status, 'captured');
    assert.match(res.json.stranded[0].providerCaptureId, /^FAKECAP-/);
    assert.equal(op(h, w.orders.B).status, 'voided');
    assert.equal(resetAudit(h).resolved >= 1, true);
  });

  test('SEC-11: an unknown void whose answer was lost is read (VOIDED) and the operation ends voided, not stranded', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'lost_response:void', { value: 'A' });
    assert.equal((await w.cafe1.post(`/api/plans/${w.planId}/abandon`, {})).status, 200);
    assert.equal(op(h, w.orders.A).status, 'unknown', 'the void applied at the provider but its answer was lost');
    assert.equal(op(h, w.orders.B).status, 'voided');
    const probe = spy(h);

    const res = await reset(h, { force: true, reason: REASON });
    assert.equal(res.status, 200, res.text);
    assert.equal('stranded' in res.json, false);
    assert.equal(probe.count('voidAuthorization'), 0, 'read, not sent again');
    assert.equal(op(h, w.orders.A).status, 'voided');
  });

  test('SEC-11: the pass is bounded: a provider that never answers ends it at the budget; the unknown operation is stranded and the audit says so', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'lost_response:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'unknown');
    const real = h.app.deps.payments;
    h.app.deps.payments = { ...real, getAuthorization: () => new Promise(() => {}), getOrder: () => new Promise(() => {}) };

    const admin = h.db.prepare("SELECT id, role FROM users WHERE username = 'admin'").get();
    const started = performance.now();
    const body = await resetDemo({ ...h.app.deps, requestId: 'req-bounded' }, { id: admin.id, role: admin.role }, { force: true, reason: REASON }, { resolveBudgetMs: 150 });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5_000, `the reset returned after ${Math.round(elapsed)} ms instead of waiting for the provider`);
    assert.equal(body.reset, true);
    assert.deepEqual(body.stranded.map((s) => [s.id, s.status]), [[op(h, w.orders.A).id, 'unknown']]);
    assert.equal(resetAudit(h).resolveTimedOut, true);
    assert.equal(op(h, w.orders.A).archived_at !== null, true);
    h.app.deps.payments = real;
  });

  test('SEC-11: the budget is 30 seconds', () => {
    assert.equal(RESET_RESOLVE_BUDGET_MS, 30_000);
  });
});

describe('RS-37: the guard and the archive', () => {
  test('RS-37: a refused reset (money held, no force) changes nothing: no provider call, no archive, no void rule, a denied audit row', async () => {
    const h = await start();
    const w = await world(h);
    const probe = spy(h);
    const res = await reset(h, {});
    assert.equal(res.status, 409);
    assert.deepEqual(res.json.error.details.operations.map((o) => o.status), ['authorized', 'authorized']);
    assert.deepEqual(probe.log, [], 'no provider call, read or write');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM payment_operations WHERE archived_at IS NOT NULL'), 0);
    assert.equal(plan(h, w.planId).status, 'approved');
    assert.equal(reservation(h, w.reservationId).status, 'active');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.reset' AND outcome = 'denied'"), 1);
  });

  test('RS-37: operations that are already archived are ignored by the reconciler: a tick after the reset sends, reads and resolves nothing', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'lost_response:capture', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    const real = h.app.deps.payments;
    h.app.deps.payments = { ...real, getAuthorization: () => new Promise(() => {}), getOrder: () => new Promise(() => {}) };
    const admin = h.db.prepare("SELECT id, role FROM users WHERE username = 'admin'").get();
    await resetDemo({ ...h.app.deps, requestId: 'req-archived' }, admin, { force: true, reason: REASON }, { resolveBudgetMs: 100 });
    h.app.deps.payments = real;

    const probe = spy(h);
    const rec = createReconciler(h.app.deps, { saga: h.app.deps.saga });
    h.clock.advance(h.config.sagaLeaseMs * 3);
    const summary = await rec.tick();
    await h.app.deps.saga.idle();
    assert.deepEqual([summary.resolved, summary.polled, summary.takenOver, summary.sent], [0, 0, 0, 0]);
    assert.deepEqual(probe.log, [], 'no provider call after the archive');
    assert.equal(op(h, w.orders.A).status, 'unknown', 'left exactly as the reset found it');
  });
});

describe('RS-38: a reset and the stock', () => {
  test('RS-38: a reservation still reconciling (a refund pending) is closed by a forced reset WITHOUT restock rows; the stock is the seed and stays so after the next ticks', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    arm(h, 'refund_pending', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'refund_pending');
    assert.equal(reservation(h, w.reservationId).status, 'reconciling');
    assert.equal((await reset(h, {})).status, 409, 'refund_pending holds money');

    const res = await reset(h, { force: true, reason: REASON });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.stranded.map((s) => s.status), ['refund_pending']);
    assert.equal(reservation(h, w.reservationId).status, 'released');
    assert.deepEqual(stock(h), h.seeded);

    const rec = createReconciler(h.app.deps, { saga: h.app.deps.saga });
    await rec.tick();
    await rec.tick();
    await h.app.deps.saga.idle();
    assert.equal(restockRows(h), 0, 'the reconciler never restocks a reservation the reset already closed');
    assert.deepEqual(stock(h), h.seeded, 'the stock is not counted twice');
    assertLedger(h, 'after the ticks');
  });

  test('RS-38: the same holds for an unforced reset with a reconciling reservation whose refund failed (refund_failed is terminal, so the reset is allowed)', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_declined', { value: 'B' });
    arm(h, 'refund_failed', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal(op(h, w.orders.A).status, 'refund_failed');
    assert.equal(reservation(h, w.reservationId).status, 'reconciling');

    const res = await reset(h, {});
    assert.equal(res.status, 200, res.text);
    assert.equal(reservation(h, w.reservationId).status, 'released');
    await createReconciler(h.app.deps, { saga: h.app.deps.saga }).tick();
    assert.equal(restockRows(h), 0);
    assert.deepEqual(stock(h), h.seeded);
    assertLedger(h, 'after the tick');
  });

  test('RS-38: an executing plan whose operations the reset archived is never taken over, resumed or marked executed, even when its capture completes later', async () => {
    const h = await start();
    const w = await world(h);
    arm(h, 'capture_pending', { value: 'A' });
    assert.equal((await execute(w)).status, 202);
    await h.app.deps.saga.idle();
    assert.equal((await reset(h, { force: true, reason: REASON })).status, 200);
    const probe = spy(h);
    h.db.prepare("UPDATE fake_paypal_captures SET status = 'COMPLETED'").run();
    h.clock.advance(h.config.sagaLeaseMs * 3);
    const rec = createReconciler(h.app.deps, { saga: h.app.deps.saga });
    const summary = await rec.tick();
    await h.app.deps.saga.idle();
    assert.equal(summary.takenOver, 0);
    assert.equal(plan(h, w.planId).status, 'executing', 'not executed: its operations are archived');
    assert.equal(plan(h, w.planId).lease_epoch, 1);
    assert.deepEqual(probe.log, [], 'no capture, and not even a read, for an archived operation');
  });
});
