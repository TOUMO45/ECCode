// Backend rework-7 (decisions dec-mv46ovf2-017bf12d as corrected by dec-mv4740d4-015b3589, dec-mv46ovt6-01a662af, dec-mv48g2fj-018e0ca7;
// security conditions SEC-F2-C of phase-f-security-2.md). One describe per follow-up, named with its id:
//   FU-59   a refunded order cannot be marked ready or handed over; the check is per ORDER (its own payment operation), the
//           plan-wide rule for the other blocking states stays, and a sibling of a refunded order is not blocked (OQ-D2, spec row 7)
//   FU-58   the supplier route's checkRefusalReason refuses bidi override and isolate controls (U+202A-U+202E, U+2066-U+2069)
//   FU-56   the admin supplier_refusal reason is validated exactly like the supplier route (bounds, blank, controls)
//   FU-54   every stranded entry of a forced reset carries planStatus and owedRefund (true exactly for a captured operation with
//           cancel_requested_at set)
//   FU-55   refund_order writes a `denied` audit row for 404 and 422, as it does for 409
//   FU-57   an operation in refund_failed counts in metrics reconciler.unresolved
//   dec-mv48g2fj  the single-credential notice is exactly the spec sentence
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { buildLabels, loadConfig } from '../../src/config.js';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { checkRefusalReason } from '../../src/services/orders.js';
import { createVoidPort } from '../../src/services/calls.js';
import { createReconciler } from '../../src/services/reconciler.js';
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
  h.supplier = { A: await signIn(h, 'supplier-a'), B: await signIn(h, 'supplier-b') };
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
const arm = (h, fault, { value = '', remaining = 1 } = {}) =>
  h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES (?, ?, ?, '2026-10-20T06:00:00.000Z')").run(`fake_paypal:${fault}`, value, remaining);
const op = (h, orderId) => h.db.prepare('SELECT * FROM payment_operations WHERE supplier_order_id = ?').get(orderId);
const plan = (h, id) => h.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id);
const order = (h, id) => h.db.prepare('SELECT * FROM supplier_orders WHERE id = ?').get(id);
const reconcilerOf = (h) => createReconciler(h.app.deps, { saga: h.app.deps.saga });
const settle = async (h, rec = reconcilerOf(h)) => {
  await rec.tick();
  await h.app.deps.saga.idle();
};

// An approved plan with a reservation: two orders awaiting their suppliers.
async function reservedWorld(h) {
  const cafe1 = await signIn(h, 'cafe1');
  h.clock.advance(61_000);
  const { requestId, plan: made } = await approvedPlan(cafe1, DAY);
  const reserved = await reserve(cafe1, made.id, idempotencyKey(`${requestId}-${made.id}`));
  assert.equal(reserved.status, 201, reserved.text);
  const orders = Object.fromEntries(reserved.json.orders.map((o) => [o.supplier.code, o.id]));
  return { cafe1, requestId, planId: made.id, orders, reservationId: reserved.json.reservation.id };
}

// Both orders confirmed, approved at the provider and paid; the plan is executed unless `before` arms a fault that stops it.
async function executedWorld(h, { before = () => {}, finish = true } = {}) {
  const w = await reservedWorld(h);
  for (const code of ['A', 'B']) {
    assert.equal((await h.supplier[code].post(`/api/supplier/orders/${w.orders[code]}/confirm`, confirmBody(code))).status, 200);
    const created = await w.cafe1.post(`/api/orders/${w.orders[code]}/paypal/create`, {});
    assert.equal(created.status, 200, created.text);
    const approved = await postTo(`${created.json.approvalUrl}/approve`);
    const target = new URL(approved.location);
    assert.equal((await w.cafe1.get(target.pathname + target.search)).status, 303);
  }
  before(w);
  assert.equal((await w.cafe1.post(`/api/plans/${w.planId}/execute`, {})).status, 202);
  await h.app.deps.saga.idle();
  if (finish) {
    h.db.prepare("UPDATE fake_paypal_captures SET status = 'COMPLETED'").run();
    await settle(h);
    assert.equal(plan(h, w.planId).status, 'executed');
  }
  return w;
}

const refundOrder = (h, supplierOrderId) => h.admin.post('/api/admin/faults', { kind: 'refund_order', supplierOrderId });
const ready = (h, code, orderId) => h.supplier[code].post(`/api/supplier/orders/${orderId}/ready`, {});
const handover = (h, code, orderId) => h.supplier[code].post(`/api/supplier/orders/${orderId}/handover`, {});
const deniedAudit = (h) => h.db.prepare("SELECT * FROM audit_events WHERE action = 'admin.fault' AND outcome = 'denied' ORDER BY id").all();

describe('FU-59: a refunded order is not handed over, per order', () => {
  test('FU-59: the refunded order is 409 HANDOVER_BLOCKED for ready and for handover, its sibling in the same plan is marked ready and handed over (OQ-D2, spec row 7)', async () => {
    const h = await start();
    const w = await executedWorld(h);
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    assert.equal(op(h, w.orders.A).status, 'refunded');
    assert.equal(op(h, w.orders.B).status, 'captured');

    // the refunded order: no ready, no handover, the card says so
    const card = (await h.supplier.A.get('/api/supplier/orders')).json.orders.find((o) => o.id === w.orders.A);
    assert.equal(card.presentation, 'refunded');
    assert.equal(card.canMarkReady, false, 'canMarkReady agrees with the guard');
    const blocked = await ready(h, 'A', w.orders.A);
    assert.equal(blocked.status, 409, blocked.text);
    assert.equal(blocked.json.error.code, 'HANDOVER_BLOCKED');
    const handedA = await handover(h, 'A', w.orders.A);
    assert.equal(handedA.status, 409, handedA.text);
    assert.equal(handedA.json.error.code, 'HANDOVER_BLOCKED');
    assert.equal(order(h, w.orders.A).fulfilment_status, 'confirmed', 'nothing moved');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'order.ready' AND outcome = 'denied' AND entity_id = ?").get(w.orders.A).n, 1);

    // its sibling: the goods of the other supplier remain collectable
    const siblingCard = (await h.supplier.B.get('/api/supplier/orders')).json.orders.find((o) => o.id === w.orders.B);
    assert.equal(siblingCard.canMarkReady, true);
    const readyB = await ready(h, 'B', w.orders.B);
    assert.equal(readyB.status, 200, readyB.text);
    assert.equal(readyB.json.order.fulfilmentStatus, 'ready');
    const handedB = await handover(h, 'B', w.orders.B);
    assert.equal(handedB.status, 200, handedB.text);
    assert.equal(handedB.json.order.fulfilmentStatus, 'collected');
  });

  test('FU-59: an order that was already ready when its refund completed cannot be handed over any more; the sibling can', async () => {
    const h = await start();
    const w = await executedWorld(h);
    assert.equal((await ready(h, 'A', w.orders.A)).status, 200);
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    const card = (await h.supplier.A.get('/api/supplier/orders')).json.orders.find((o) => o.id === w.orders.A);
    assert.equal(card.canHandover, false);
    const blocked = await handover(h, 'A', w.orders.A);
    assert.equal(blocked.status, 409, blocked.text);
    assert.equal(blocked.json.error.code, 'HANDOVER_BLOCKED');
    assert.equal(order(h, w.orders.A).fulfilment_status, 'ready');
    assert.equal((await ready(h, 'B', w.orders.B)).status, 200);
    assert.equal((await handover(h, 'B', w.orders.B)).status, 200);
  });

  test('FU-59: the plan-wide rule for the other blocking states stays: while A is being refunded (refund_pending) or its refund failed, B is blocked too', async () => {
    for (const fault of ['refund_pending', 'refund_failed']) {
      const h = await start();
      const w = await executedWorld(h);
      arm(h, fault, { value: 'A' });
      assert.equal((await refundOrder(h, w.orders.A)).status, 200);
      assert.equal(op(h, w.orders.A).status, fault, fault);
      const blocked = await ready(h, 'B', w.orders.B);
      assert.equal(blocked.status, 409, `${fault}: ${blocked.text}`);
      assert.equal(blocked.json.error.code, 'HANDOVER_BLOCKED');
    }
  });

  test('FU-59: with no refund both orders are marked ready and handed over as before', async () => {
    const h = await start();
    const w = await executedWorld(h);
    for (const code of ['A', 'B']) {
      assert.equal((await ready(h, code, w.orders[code])).status, 200);
      assert.equal((await handover(h, code, w.orders[code])).status, 200);
    }
  });
});

describe('FU-58 / FU-56: refusal reasons refuse control and bidi characters', () => {
  const BIDI = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) => String.fromCodePoint(c));
  const CONTROLS = [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9f, 0x2028, 0x2029].map((c) => String.fromCodePoint(c));

  test('FU-58: checkRefusalReason refuses U+202A-U+202E, U+2066-U+2069 and other control characters, anywhere in the text; ordinary text, tabs, line breaks and Arabic stay valid', () => {
    for (const ch of [...BIDI, ...CONTROLS]) {
      for (const text of [`a${ch}b`, `${ch}a`, `a${ch}`]) {
        const checked = checkRefusalReason(text);
        assert.equal(checked.ok, false, `U+${ch.codePointAt(0).toString(16).toUpperCase()} in ${JSON.stringify(text)}`);
        assert.equal(checked.rule, 'characters');
      }
    }
    const arabic = String.fromCodePoint(0x644, 0x627, 0x20, 0x64a, 0x648, 0x62c, 0x62f, 0x20, 0x645, 0x62e, 0x632, 0x648, 0x646);
    const withMark = `${arabic}${String.fromCodePoint(0x200f)}`; // a plain right-to-left mark is not an override
    for (const text of ['Out of cups today', 'two\nlines\tand a tab', 'one\r\ntwo', arabic, withMark, 'x'.repeat(300)]) {
      assert.equal(checkRefusalReason(text).ok, true, JSON.stringify(text));
    }
    assert.deepEqual([checkRefusalReason('').ok, checkRefusalReason('   \n').ok, checkRefusalReason('x'.repeat(301)).ok], [false, false, false]);
  });

  test('FU-58: the supplier route answers 422 VALIDATION_FAILED for a bidi override or isolate in the reason and changes nothing; a clean reason is stored', async () => {
    const h = await start();
    const w = await reservedWorld(h);
    const refuse = (reason) => h.supplier.A.post(`/api/supplier/orders/${w.orders.A}/refuse`, { reason });
    for (const ch of [...BIDI, '\u001B', '\u0085']) {
      const res = await refuse(`Out of stock${ch}. Money was returned.`);
      assert.equal(res.status, 422, `U+${ch.codePointAt(0).toString(16)}: ${res.text}`);
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
      assert.deepEqual(res.json.error.details.fields, [{ field: 'reason', rule: 'characters' }]);
    }
    assert.equal(order(h, w.orders.A).fulfilment_status, 'awaiting_supplier', 'nothing changed');
    assert.equal(order(h, w.orders.A).refusal_reason, null);
    assert.equal(plan(h, w.planId).status, 'approved');
    const ok = await refuse('Out of stock today');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(order(h, w.orders.A).refusal_reason, 'Out of stock today');
  });

  test('FU-56: the admin supplier_refusal reason is validated like the supplier route: bidi, ESC/BEL, blank, empty, over 300 and non-strings are 422 and refuse no order', async () => {
    const h = await start();
    const w = await reservedWorld(h);
    const fault = (reason) => h.admin.post('/api/admin/faults', { kind: 'supplier_refusal', supplierCode: 'A', reason });
    const bad = [...BIDI.map((c) => `Refused${c}!`), '\u001B[31m', 'a\u0007b', '   ', '\n\t', '', 'x'.repeat(301), 5, null, ['x']];
    for (const reason of bad) {
      const res = await fault(reason);
      assert.equal(res.status, 422, `${JSON.stringify(reason)}: ${res.text}`);
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
      assert.equal(res.json.error.details.fields[0].field, 'reason');
    }
    assert.equal(order(h, w.orders.A).fulfilment_status, 'awaiting_supplier', 'no order was refused');
    assert.equal(plan(h, w.planId).status, 'approved');
    // the same reason the supplier route would take is taken here, and the default stays for an omitted reason
    const ok = await fault('x'.repeat(300));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(order(h, w.orders.A).refusal_reason, 'x'.repeat(300));
  });

  test('FU-56: an omitted reason still gets the default text', async () => {
    const h = await start();
    const w = await reservedWorld(h);
    const res = await h.admin.post('/api/admin/faults', { kind: 'supplier_refusal', supplierCode: 'A' });
    assert.equal(res.status, 200, res.text);
    assert.equal(order(h, w.orders.A).refusal_reason, 'Refused by the organiser (demo fault).');
  });
});

describe('FU-54: stranded entries carry planStatus and owedRefund', () => {
  const reset = (h) => h.admin.post('/api/admin/reset', { force: true, reason: REASON });

  test('FU-54: owedRefund is true exactly for a captured operation with cancel_requested_at set; planStatus is on every entry', async () => {
    const h = await start();
    // A captured, B capture_pending: the plan is still executing
    const w = await executedWorld(h, { before: () => arm(h, 'capture_pending', { value: 'B' }), finish: false });
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(op(h, w.orders.B).status, 'capture_pending');
    h.db.prepare("UPDATE payment_operations SET cancel_requested_at = ?, cancel_reason = 'CAPTURE_FAILED' WHERE supplier_order_id = ?").run(new Date(h.clock.now()).toISOString(), w.orders.A);
    const res = await reset(h);
    assert.equal(res.status, 200, res.text);
    const byStatus = Object.fromEntries(res.json.stranded.map((s) => [s.status, s]));
    assert.deepEqual(Object.keys(byStatus).sort(), ['capture_pending', 'captured']);
    assert.equal(byStatus.captured.owedRefund, true, 'captured with cancel_requested_at: money is owed back');
    assert.equal(byStatus.capture_pending.owedRefund, false);
    for (const entry of res.json.stranded) {
      assert.equal(entry.planStatus, 'executing', JSON.stringify(entry));
      assert.equal(typeof entry.owedRefund, 'boolean');
      assert.ok(entry.id && 'providerAuthorizationId' in entry && 'providerCaptureId' in entry, 'the existing keys stay');
    }
  });

  test('FU-54: a captured operation WITHOUT cancel_requested_at reads like a sale: owedRefund false', async () => {
    const h = await start();
    const w = await executedWorld(h, { before: () => arm(h, 'capture_pending', { value: 'B' }), finish: false });
    assert.equal(op(h, w.orders.A).status, 'captured');
    assert.equal(op(h, w.orders.A).cancel_requested_at, null);
    const res = await reset(h);
    assert.equal(res.status, 200, res.text);
    const captured = res.json.stranded.find((s) => s.status === 'captured');
    assert.equal(captured.owedRefund, false);
    assert.equal(captured.planStatus, 'executing');
  });
});

describe('FU-55: refund_order writes an audit row for 404 and 422, as for 409', () => {
  test('FU-55: an unknown order (404) and an archived one (404) each write a denied audit row with the actor and the target id', async () => {
    const h = await start();
    const w = await executedWorld(h);
    const before = deniedAudit(h).length;
    const unknown = await refundOrder(h, 987654);
    assert.equal(unknown.status, 404);
    h.db.prepare('UPDATE payment_operations SET archived_at = ? WHERE supplier_order_id = ?').run(new Date(h.clock.now()).toISOString(), w.orders.A);
    assert.equal((await refundOrder(h, w.orders.A)).status, 404);
    const rows = deniedAudit(h).slice(before);
    assert.equal(rows.length, 2);
    const admin = h.db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    assert.deepEqual(rows.map((r) => [r.actor_user_id, r.actor_role, r.outcome]), [[admin.id, 'admin', 'denied'], [admin.id, 'admin', 'denied']]);
    assert.deepEqual(rows.map((r) => JSON.parse(r.detail_json)), [
      { kind: 'refund_order', code: 'NOT_FOUND', supplierOrderId: 987654 },
      { kind: 'refund_order', code: 'NOT_FOUND', supplierOrderId: w.orders.A },
    ]);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE kind = 'refund'").get().n, 0);
  });

  test('FU-55: a malformed refund_order body (422) writes a denied audit row; so does the 409 of the same call, and nothing else changes', async () => {
    const h = await start();
    const w = await executedWorld(h);
    const before = deniedAudit(h).length;
    for (const body of [{ kind: 'refund_order' }, { kind: 'refund_order', supplierOrderId: 'x' }, { kind: 'refund_order', supplierOrderId: 0 }, { kind: 'refund_order', supplierOrderId: 1.5 }]) {
      const res = await h.admin.post('/api/admin/faults', body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    const rows = deniedAudit(h).slice(before);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.deepEqual(JSON.parse(row.detail_json), { kind: 'refund_order', code: 'VALIDATION_FAILED' });
      assert.equal(row.actor_role, 'admin');
    }
    assert.equal(op(h, w.orders.A).status, 'captured', 'nothing was refunded');
    // the 409 keeps its row
    h.db.prepare("UPDATE plan_versions SET status = 'executing' WHERE id = ?").run(w.planId);
    assert.equal((await refundOrder(h, w.orders.A)).status, 409);
    assert.equal(deniedAudit(h).length, before + 5);
  });

  test('FU-55: 422 on another fault kind is not turned into a refund_order row (only refund_order is audited by this rule)', async () => {
    const h = await start();
    const before = deniedAudit(h).length;
    assert.equal((await h.admin.post('/api/admin/faults', { kind: 'stock_depletion', supplierCode: 'zz' })).status, 422);
    assert.equal(deniedAudit(h).filter((r) => JSON.parse(r.detail_json).kind === 'refund_order').length, 0);
    assert.ok(deniedAudit(h).length >= before);
  });
});

describe('FU-57: refund_failed counts in unresolved', () => {
  test('FU-57: an operation in refund_failed is counted by metrics reconciler.unresolved, and operationsByStatus still shows it', async () => {
    const h = await start();
    const w = await executedWorld(h);
    assert.equal((await h.admin.get('/api/admin/metrics')).json.reconciler.unresolved, 0);
    arm(h, 'refund_failed', { value: 'A' });
    assert.equal((await refundOrder(h, w.orders.A)).status, 200);
    assert.equal(op(h, w.orders.A).status, 'refund_failed');
    const metrics = await h.admin.get('/api/admin/metrics');
    assert.equal(metrics.json.reconciler.unresolved, 1);
    assert.equal(metrics.json.counts.operationsByStatus.refund_failed, 1);
    // an archived refund_failed operation is not counted
    h.db.prepare('UPDATE payment_operations SET archived_at = ? WHERE supplier_order_id = ?').run(new Date(h.clock.now()).toISOString(), w.orders.A);
    assert.equal((await h.admin.get('/api/admin/metrics')).json.reconciler.unresolved, 0);
  });
});

describe('dec-mv48g2fj: the single-credential notice is the spec sentence', () => {
  test('the server sends exactly "All demo suppliers are paid to one Sandbox account" in single-credential Sandbox mode, and null otherwise', () => {
    const sandbox = buildLabels(loadConfig({ RS_PAYMENT_PROVIDER: 'paypal-sandbox', RS_PAYPAL_DEFAULT_CLIENT_ID: 'cid', RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'csecret' }));
    assert.equal(sandbox.merchantMode, 'single-credential');
    assert.equal(sandbox.singleCredentialNotice, 'All demo suppliers are paid to one Sandbox account');
    assert.equal(buildLabels(loadConfig({})).singleCredentialNotice, null);
  });
});
