// Admin API tests (task c3-reservations-supplier-admin). Case names start with the criterion id:
//   RS-37  reset is 409 RESET_BLOCKED while any non-archived operation holds or moves money; an unforced reset ends live
//          reservations (void rule, DEMO_RESET), tombstones requests, restores the catalog with adjust ledger rows, clears
//          the fake tables, fault flags and request_create events, and audits actor and reason; a forced reset needs a
//          reason, archives (never deletes) operations and provider calls, and lists what is not terminal in `stranded`
//   RS-32  (admin half) the stock_depletion fault withdraws the supplier's offer, supersedes the plans that use it
//          (void rule included), and the re-plan leaves it out (A+E at 9500)
//   SEC-11 faults write an audit event with the actor and the target ids; fake faults are refused with a real adapter
//   RS-30  the role checks are in isolation.test.js; here the admin session is used
//   timeline and metrics: shapes, filters and paging
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { FIXTURE_DIR, createClient } from '../helpers/fixtures.js';
import { ensureAdmin } from '../../src/services/users.js';

const ADMIN_PASSWORD = 'admin-password-for-tests-0123';
const FIELDS = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90,
  material: null, deadline: '2026-10-20T11:00', budgetCents: 12000, maxPickups: 2,
});
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const fixture = (name) => JSON.parse(readFileSync(`${FIXTURE_DIR}/contracts/${name}.json`, 'utf8')).response;
const keysOf = (value) => Object.keys(value).sort();

async function signIn(h, username, password = DEMO_PASSWORD) {
  const client = createClient(h.request);
  await client.signIn(username, password);
  return client;
}

async function start(env = {}) {
  const h = await startHarness({ seed: true, env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD, RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000', ...env } });
  await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
  h.admin = await signIn(h, 'admin', ADMIN_PASSWORD);
  return h;
}

let keyCounter = 0;
async function reservedPlan(h, client, overrides = {}) {
  h.clock.advance(61_000);
  const created = await client.post('/api/requests', { text: 'I need 200 cups and 200 lids by 11:00.' });
  const requestId = created.json.request.id;
  await client.post(`/api/requests/${requestId}/confirm`, { fields: { ...FIELDS, ...overrides } });
  const plan = (await client.post(`/api/requests/${requestId}/plan`, {})).json.plan;
  const approved = await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
  assert.equal(approved.status, 200, approved.text);
  keyCounter += 1;
  const reserved = await client.post(`/api/plans/${plan.id}/reserve`, {}, { headers: { 'Idempotency-Key': `admin-flow-key-${String(keyCounter).padStart(9, '0')}` } });
  assert.equal(reserved.status, 201, reserved.text);
  return { requestId, plan, reservation: reserved.json.reservation, orders: reserved.json.orders };
}

function assertLedgerInvariant(h) {
  for (const inv of h.db.prepare('SELECT product_id, on_hand, reserved FROM inventory').all()) {
    const sum = h.db.prepare('SELECT COALESCE(SUM(delta_on_hand),0) AS a, COALESCE(SUM(delta_reserved),0) AS b FROM inventory_ledger WHERE product_id = ?').get(inv.product_id);
    assert.equal(sum.a, inv.on_hand, `ledger on_hand of product ${inv.product_id}`);
    assert.equal(sum.b, inv.reserved, `ledger reserved of product ${inv.product_id}`);
  }
}

const faults = (h, body) => h.admin.post('/api/admin/faults', body);
const reset = (h, body = {}) => h.admin.post('/api/admin/reset', body);

describe('RS-37: reset is guarded while money is held, and archives instead of deleting', () => {
  let h;
  let cafe1;
  let flow;
  before(async () => {
    h = await start();
    cafe1 = await signIn(h, 'cafe1');
    flow = await reservedPlan(h, cafe1);
  });
  after(() => h.close());

  test('RS-37: an operation in approved, authorization_pending, authorized, capture_pending, captured, refund_requested, refund_pending or unknown blocks the reset: 409 RESET_BLOCKED with the operations, nothing changed, audited as denied', async () => {
    const ops = h.db.prepare('SELECT id FROM payment_operations ORDER BY id').all();
    h.db.prepare("UPDATE payment_operations SET status = 'authorized', provider_authorization_id = 'FAKE-AUTH-1' WHERE id = ?").run(ops[0].id);
    h.db.prepare("UPDATE payment_operations SET status = 'authorization_pending', pending_since = '2026-10-20T06:05:00.000Z' WHERE id = ?").run(ops[1].id);
    const before = {
      archived: count(h, 'SELECT COUNT(*) AS n FROM payment_operations WHERE archived_at IS NOT NULL'),
      requests: count(h, 'SELECT COUNT(*) AS n FROM rescue_requests WHERE archived_at IS NULL'),
      reserved: count(h, 'SELECT SUM(reserved) AS n FROM inventory'),
    };
    const res = await reset(h, {});
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error.code, 'RESET_BLOCKED');
    assert.deepEqual(res.json.error.details, { operations: [{ id: ops[0].id, status: 'authorized' }, { id: ops[1].id, status: 'authorization_pending' }] });
    assert.deepEqual(keysOf(res.json.error), keysOf(fixture('admin-reset-blocked').error));
    assert.deepEqual(
      {
        archived: count(h, 'SELECT COUNT(*) AS n FROM payment_operations WHERE archived_at IS NOT NULL'),
        requests: count(h, 'SELECT COUNT(*) AS n FROM rescue_requests WHERE archived_at IS NULL'),
        reserved: count(h, 'SELECT SUM(reserved) AS n FROM inventory'),
      },
      before,
    );
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'admin.reset' AND outcome = 'denied'"), 1);

    for (const status of ['approved', 'capture_pending', 'captured', 'refund_requested', 'refund_pending']) {
      h.db.prepare('UPDATE payment_operations SET status = ?, pending_since = NULL WHERE id = ?').run(status, ops[1].id);
      h.db.prepare("UPDATE payment_operations SET status = 'created' WHERE id = ?").run(ops[0].id);
      assert.equal((await reset(h, {})).status, 409, status);
    }
    h.db.prepare("UPDATE payment_operations SET status = 'unknown', prev_status = 'approved', unknown_since = '2026-10-20T06:05:00.000Z' WHERE id = ?").run(ops[1].id);
    assert.equal((await reset(h, {})).status, 409, 'unknown');
    h.db.prepare("UPDATE payment_operations SET status = 'created', prev_status = NULL, unknown_since = NULL WHERE id = ?").run(ops[1].id);
  });

  test('RS-37: forced reset needs a reason of 10-500 characters (422 otherwise) and force must be a boolean', async () => {
    for (const body of [{ force: true }, { force: true, reason: 'short' }, { force: 'yes', reason: 'a long enough reason' }, { force: true, reason: 'x'.repeat(501) }]) {
      const res = await reset(h, body);
      assert.equal(res.status, 422, JSON.stringify(body).slice(0, 40));
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    }
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM rescue_requests WHERE archived_at IS NOT NULL'), 0);
  });

  test('RS-37: an unforced reset with no money held: live reservations released (void rule DEMO_RESET), requests tombstoned, catalog restored with adjust rows, operations archived not deleted, flags and counters cleared, audit with actor', async () => {
    // Dirty the world: a catalog change, an extraction and an image row, fake provider state, flags, rate events.
    h.db.prepare("UPDATE inventory SET on_hand = 4 WHERE supplier_id = (SELECT id FROM suppliers WHERE code = 'C')").run();
    h.db.prepare("INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, actor, at) SELECT supplier_id, product_id, 'restock', 3, 0, 4, 0, 'supplier_patch', 'test', '2026-10-20T06:00:00.000Z' FROM inventory WHERE on_hand = 4").run();
    h.db.prepare("INSERT INTO extractions (request_id, provider, prompt_version, schema_ok, degraded, simulated, fields_json, created_at) VALUES (?, 'fake', 'x1', 1, 0, 1, '{}', '2026-10-20T06:00:00.000Z')").run(flow.requestId);
    h.db.prepare("INSERT INTO images (request_id, file_name, mime_detected, bytes, sha256, created_at) VALUES (?, ?, 'image/png', 10, 'abc', '2026-10-20T06:00:00.000Z')").run(flow.requestId, 'a'.repeat(32));
    h.db.prepare("INSERT INTO fake_paypal_orders (id, merchant_key, amount_cents, currency, status, return_url, cancel_url, created_at) VALUES ('FAKE-1', 'A', 100, 'USD', 'CREATED', 'http://x', 'http://x', '2026-10-20T06:00:00.000Z')").run();
    h.db.prepare("INSERT INTO fake_paypal_calls (kind, merchant_key, pid, at) VALUES ('create_order', 'A', 1, '2026-10-20T06:00:00.000Z')").run();
    h.db.prepare("INSERT INTO fault_flags (name, value, remaining, created_at) VALUES ('fake_paypal:void_fail', '', NULL, '2026-10-20T06:00:00.000Z')").run();
    const productC = h.db.prepare("SELECT p.id FROM products p JOIN suppliers s ON s.id = p.supplier_id WHERE s.code = 'C' AND p.kind = 'bundle'").get().id;
    h.db.prepare("UPDATE offers SET status = 'replaced' WHERE product_id = ?").run(productC);
    h.db.prepare("INSERT INTO offers (supplier_id, product_id, price_cents, prep_fee_cents, ready_at, version, status, valid_from, demo) SELECT supplier_id, product_id, 1, prep_fee_cents, ready_at, 2, 'active', valid_from, demo FROM offers WHERE product_id = ? AND version = 1").run(productC);
    const operations = count(h, 'SELECT COUNT(*) AS n FROM payment_operations');

    const res = await reset(h, {});
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(keysOf(res.json), keysOf(fixture('admin-reset')));
    assert.equal(res.json.reset, true);
    assert.equal(res.json.archivedOperations, operations);
    assert.equal(res.json.stranded, undefined);

    // payment operations and provider calls are archived, never deleted
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM payment_operations'), operations);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM payment_operations WHERE archived_at IS NULL'), 0);
    // live plan and reservation ended through the void rule
    assert.deepEqual({ ...h.db.prepare('SELECT status, non_executable_reason FROM plan_versions WHERE id = ?').get(flow.plan.id) }, { status: 'non_executable', non_executable_reason: 'DEMO_RESET' });
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(flow.reservation.id).status, 'released');
    assert.deepEqual(h.db.prepare('SELECT fulfilment_status FROM supplier_orders ORDER BY id').all().map((o) => o.fulfilment_status), ['cancelled', 'cancelled']);
    // requests tombstoned
    const request = h.db.prepare('SELECT raw_text, archived_at FROM rescue_requests WHERE id = ?').get(flow.requestId);
    assert.equal(request.raw_text, null);
    assert.ok(request.archived_at);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM extractions'), 0);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images'), 0);
    assert.equal((await cafe1.get(`/api/requests/${flow.requestId}`)).status, 404, 'an archived request is gone for its owner');
    // catalog and inventory back to RS-FIX-1, with adjust rows
    assert.equal(h.db.prepare("SELECT on_hand FROM inventory WHERE product_id = ?").get(productC).on_hand, 1);
    assert.equal(count(h, 'SELECT SUM(reserved) AS n FROM inventory'), 0);
    const adjust = h.db.prepare("SELECT delta_on_hand, ref_type FROM inventory_ledger WHERE ref_type = 'admin_reset' AND product_id = ?").all(productC).map((r) => ({ ...r }));
    assert.deepEqual(adjust, [{ delta_on_hand: -3, ref_type: 'admin_reset' }]);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'release' AND ref_id = ?", flow.reservation.id), 2, 'the void rule returned the reserved units with release rows');
    const offer = h.db.prepare("SELECT price_cents, version, status FROM offers WHERE product_id = ? AND status IN ('active','withdrawn')").get(productC);
    assert.deepEqual({ ...offer }, { price_cents: 4800, version: 3, status: 'active' });
    assertLedgerInvariant(h);
    // fake provider state, flags and the daily counters
    for (const table of ['fake_paypal_orders', 'fake_paypal_calls', 'fault_flags']) assert.equal(count(h, `SELECT COUNT(*) AS n FROM ${table}`), 0, table);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'request_create'"), 0);
    // audit event: actor and result
    const audit = h.db.prepare("SELECT actor_user_id, actor_role, outcome, detail_json FROM audit_events WHERE action = 'admin.reset' AND outcome = 'ok'").get();
    assert.equal(audit.actor_user_id, h.admin.user.id);
    assert.equal(audit.actor_role, 'admin');
    assert.equal(JSON.parse(audit.detail_json).archivedOperations, operations);
  });

  test('RS-37: after the reset a customer can start again, and the catalog plans the base case (A+B at 8400)', async () => {
    h.clock.advance(61_000);
    const created = await cafe1.post('/api/requests', { text: 'A fresh start after the demo reset.' });
    assert.equal(created.status, 201);
    await cafe1.post(`/api/requests/${created.json.request.id}/confirm`, { fields: FIELDS });
    const plan = await cafe1.post(`/api/requests/${created.json.request.id}/plan`, {});
    assert.equal(plan.json.plan.body.totalCents, 8400);
  });
});

describe('RS-37: forced reset archives with a recorded reason and lists what the provider still holds', () => {
  let h;
  before(async () => {
    h = await start();
  });
  after(() => h.close());

  test('RS-37 / SEC-11: force + reason resets although an authorization is held: operations archived (rows kept), void queued through the port, `stranded` and the audit event name the authorized operation and the reason', async () => {
    const cafe1 = await signIn(h, 'cafe1');
    const flow = await reservedPlan(h, cafe1);
    const ops = h.db.prepare('SELECT id, supplier_order_id FROM payment_operations ORDER BY id').all();
    h.db.prepare("UPDATE payment_operations SET status = 'authorized', provider_authorization_id = 'FAKE-AUTH-9', authorization_expires_at = '2026-11-18T06:00:00.000Z' WHERE id = ?").run(ops[0].id);
    h.db.prepare("INSERT INTO provider_calls (payment_operation_id, kind, attempt, operation_key, status, created_at) VALUES (?, 'authorize', 1, ?, 'succeeded', '2026-10-20T06:03:00.000Z')").run(ops[0].id, `so:${ops[0].supplier_order_id}:authorize:1`);
    assert.equal((await reset(h, {})).status, 409);

    const reason = 'Demo retake before the judging session';
    const res = await reset(h, { force: true, reason });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.archivedOperations, 2);
    assert.deepEqual(res.json.stranded, [{ id: ops[0].id, status: 'authorized', providerAuthorizationId: 'FAKE-AUTH-9', providerCaptureId: null }]);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM payment_operations'), 2, 'never deleted');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM payment_operations WHERE archived_at IS NOT NULL'), 2);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM provider_calls WHERE archived_at IS NOT NULL'), 1);
    assert.deepEqual(h.app.deps.voidRule.provider.queued.map((i) => i.operationKey), [`so:${ops[0].supplier_order_id}:void:1`]);
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(flow.plan.id).status, 'non_executable');
    const audit = h.db.prepare("SELECT detail_json FROM audit_events WHERE action = 'admin.reset' AND outcome = 'ok'").get();
    const detail = JSON.parse(audit.detail_json);
    assert.equal(detail.force, true);
    assert.equal(detail.reason, reason);
    assert.deepEqual(detail.stranded, [{ id: ops[0].id, status: 'authorized' }]);
    assertLedgerInvariant(h);
  });

  test('F-TR-15: the reset clears request_create events, so a customer at the daily limit can create requests again', async () => {
    const limited = await start({ RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '2' });
    try {
      const cafe2 = await signIn(limited, 'cafe2');
      assert.equal((await cafe2.post('/api/requests', { text: 'First request today.' })).status, 201);
      assert.equal((await cafe2.post('/api/requests', { text: 'Second request today.' })).status, 201);
      assert.equal((await cafe2.post('/api/requests', { text: 'Third request today.' })).status, 429);
      assert.equal((await reset(limited, {})).status, 200);
      assert.equal((await cafe2.post('/api/requests', { text: 'First request after the reset.' })).status, 201);
    } finally {
      await limited.close();
    }
  });
});

describe('RS-32 (admin half) and SEC-11: the fault routes', () => {
  let h;
  let cafe1;
  let supplierB;
  before(async () => {
    h = await start();
    cafe1 = await signIn(h, 'cafe1');
    supplierB = await signIn(h, 'supplier-b');
  });
  after(() => h.close());

  test('RS-32: stock_depletion withdraws B\'s offer, supersedes the plan that uses it (OFFER_WITHDRAWN), cancels its orders and voids its operations; the re-plan is A+E at 9500', async () => {
    const flow = await reservedPlan(h, cafe1);
    const res = await faults(h, { kind: 'stock_depletion', supplierCode: 'B' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(keysOf(res.json), keysOf(fixture('admin-faults')));
    assert.deepEqual(res.json.applied, { kind: 'stock_depletion', supplierCode: 'B' });
    assert.deepEqual(res.json.superseded, [flow.plan.id]);

    assert.deepEqual({ ...h.db.prepare('SELECT status, supersede_reason FROM plan_versions WHERE id = ?').get(flow.plan.id) }, { status: 'superseded', supersede_reason: 'OFFER_WITHDRAWN' });
    const offers = h.db.prepare("SELECT version, status FROM offers WHERE supplier_id = (SELECT id FROM suppliers WHERE code = 'B') ORDER BY version").all().map((o) => [o.version, o.status]);
    assert.deepEqual(offers, [[1, 'replaced'], [2, 'withdrawn']]);
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE id = ?').get(flow.reservation.id).status, 'released');
    assert.deepEqual(h.db.prepare('SELECT fulfilment_status FROM supplier_orders ORDER BY id').all().map((o) => o.fulfilment_status), ['cancelled', 'cancelled']);
    assert.deepEqual(h.db.prepare('SELECT status FROM payment_operations ORDER BY id').all().map((o) => o.status), ['voided', 'voided']);
    assert.equal(count(h, 'SELECT SUM(reserved) AS n FROM inventory'), 0);
    assert.equal(h.db.prepare('SELECT reason FROM replan_queue WHERE request_id = ?').get(flow.requestId).reason, 'OFFER_WITHDRAWN');
    const audit = h.db.prepare("SELECT actor_user_id, actor_role, detail_json FROM audit_events WHERE action = 'admin.fault'").get();
    assert.equal(audit.actor_user_id, h.admin.user.id);
    assert.equal(audit.actor_role, 'admin');
    assert.deepEqual(JSON.parse(audit.detail_json), { kind: 'stock_depletion', supplierCode: 'B', withdrawn: 1, superseded: 1 });

    assert.equal((await cafe1.get(`/api/requests/${flow.requestId}`)).json.rescueStatus.status, 'replanning');
    h.clock.advance(61_000);
    const replan = await cafe1.post(`/api/requests/${flow.requestId}/plan`, {});
    assert.equal(replan.status, 201, replan.text);
    assert.deepEqual(replan.json.plan.body.suppliers.map((s) => s.supplierCode), ['A', 'E']);
    assert.equal(replan.json.plan.body.totalCents, 9500);
    assertLedgerInvariant(h);
  });

  test('stock_depletion with nothing to withdraw is 200 with no plans; an unknown or malformed supplier code is 404 / 422; a missing kind is 422', async () => {
    const again = await faults(h, { kind: 'stock_depletion', supplierCode: 'B' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.superseded, []);
    assert.equal((await faults(h, { kind: 'stock_depletion', supplierCode: 'Z' })).status, 404);
    for (const body of [{ kind: 'stock_depletion', supplierCode: 'b' }, { kind: 'stock_depletion' }, { kind: 'nonsense' }, {}, { kind: 'stock_depletion', supplierCode: 'BB' }]) {
      const res = await faults(h, body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    }
  });

  test('supplier_refusal refuses every open pre-claim order of the supplier through the supplier-route service (SUPPLIER_REFUSED, re-plan queued) and audits actor and target ids', async () => {
    const h2 = await start();
    try {
      const customer = await signIn(h2, 'cafe2');
      const flow = await reservedPlan(h2, customer);
      const bOrder = flow.orders.find((o) => o.supplier.code === 'B').id;
      const res = await h2.admin.post('/api/admin/faults', { kind: 'supplier_refusal', supplierCode: 'B', reason: 'The organiser asked B to refuse' });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.applied, { kind: 'supplier_refusal', supplierCode: 'B', supplierOrderIds: [bOrder] });
      const order = h2.db.prepare('SELECT fulfilment_status, refusal_reason FROM supplier_orders WHERE id = ?').get(bOrder);
      assert.deepEqual({ ...order }, { fulfilment_status: 'refused', refusal_reason: 'The organiser asked B to refuse' });
      assert.deepEqual({ ...h2.db.prepare('SELECT status, non_executable_reason FROM plan_versions WHERE id = ?').get(flow.plan.id) }, { status: 'non_executable', non_executable_reason: 'SUPPLIER_REFUSED' });
      assert.equal(h2.db.prepare('SELECT reason FROM replan_queue').get().reason, 'SUPPLIER_REFUSED');
      const audit = h2.db.prepare("SELECT actor_role, detail_json FROM audit_events WHERE action = 'admin.fault'").get();
      assert.equal(audit.actor_role, 'admin');
      assert.deepEqual(JSON.parse(audit.detail_json), { kind: 'supplier_refusal', supplierCode: 'B', orders: 1 });
      const again = await h2.admin.post('/api/admin/faults', { kind: 'supplier_refusal', supplierCode: 'B' });
      assert.deepEqual(again.json.applied.supplierOrderIds, [], 'nothing left to refuse');
    } finally {
      await h2.close();
    }
  });

  test('fake_paypal and fake_model faults are stored as fault flags with count and supplier; clear removes them; the audit event names the fault', async () => {
    const a = await faults(h, { kind: 'fake_paypal', fault: 'authorize_denied', supplierCode: 'B', count: 2 });
    assert.equal(a.status, 200, a.text);
    assert.deepEqual(a.json.applied, { kind: 'fake_paypal', fault: 'authorize_denied', supplierCode: 'B', count: 2 });
    assert.equal((await faults(h, { kind: 'fake_paypal', fault: 'lost_response:authorize' })).status, 200);
    assert.equal((await faults(h, { kind: 'fake_paypal', fault: 'timeout:capture', count: 1 })).status, 200);
    assert.equal((await faults(h, { kind: 'fake_model', fault: 'schema_invalid', count: 3 })).status, 200);
    const flags = h.db.prepare('SELECT name, value, remaining FROM fault_flags ORDER BY name').all().map((f) => ({ ...f }));
    assert.deepEqual(flags, [
      { name: 'fake_model:schema_invalid', value: '', remaining: 3 },
      { name: 'fake_paypal:authorize_denied', value: 'B', remaining: 2 },
      { name: 'fake_paypal:lost_response:authorize', value: '', remaining: null },
      { name: 'fake_paypal:timeout:capture', value: '', remaining: 1 },
    ]);
    const audited = h.db.prepare("SELECT detail_json FROM audit_events WHERE action = 'admin.fault' AND detail_json LIKE '%authorize_denied%'").get();
    assert.deepEqual(JSON.parse(audited.detail_json), { kind: 'fake_paypal', fault: 'authorize_denied', supplierCode: 'B', count: 2 });

    const cleared = await faults(h, { kind: 'clear' });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.json.applied, { kind: 'clear' });
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM fault_flags'), 0);
  });

  test('faults validate: unknown fault names, a bad kind suffix, count outside 1-10, an unknown supplier (404) and test-only faults without RS_TEST_HOOKS are refused and store nothing', async () => {
    for (const body of [
      { kind: 'fake_paypal', fault: 'explode' },
      { kind: 'fake_paypal', fault: 'lost_response:nothing' },
      { kind: 'fake_paypal', fault: 'authorize_denied', count: 0 },
      { kind: 'fake_paypal', fault: 'authorize_denied', count: 11 },
      { kind: 'fake_paypal', fault: 'freeze_after_capture_apply' },
      { kind: 'fake_paypal', fault: 'crash_after_return_commit' },
      { kind: 'fake_model', fault: 'explode' },
      { kind: 'fake_model' },
    ]) {
      const res = await faults(h, body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    assert.equal((await faults(h, { kind: 'fake_paypal', fault: 'authorize_denied', supplierCode: 'Q' })).status, 404);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM fault_flags'), 0);
  });

  test('RS_TEST_HOOKS=1 accepts the test-only faults', async () => {
    const hooked = await start({ RS_TEST_HOOKS: '1' });
    try {
      for (const fault of ['freeze_after_capture_apply', 'freeze_before_capture_apply', 'crash_after_return_commit', 'capture_lands_after_void_intent']) {
        assert.equal((await hooked.admin.post('/api/admin/faults', { kind: 'fake_paypal', fault })).status, 200, fault);
      }
      assert.equal(count(hooked, 'SELECT COUNT(*) AS n FROM fault_flags'), 4);
    } finally {
      await hooked.close();
    }
  });

  test('FAULTS_UNAVAILABLE: with a real payment adapter the fake_paypal fault is 409 and nothing is stored; clear and stock_depletion still work', async () => {
    const real = await start({
      RS_PAYMENT_PROVIDER: 'paypal-sandbox',
      RS_PAYPAL_DEFAULT_CLIENT_ID: 'sandbox-client-id-for-tests-0123456789',
      RS_PAYPAL_DEFAULT_CLIENT_SECRET: 'sandbox-client-secret-for-tests-0123456789',
      RS_PAYPAL_DEFAULT_WEBHOOK_ID: 'sandbox-webhook-id-for-tests-0123456789',
    });
    try {
      const res = await real.admin.post('/api/admin/faults', { kind: 'fake_paypal', fault: 'authorize_denied' });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.error.code, 'FAULTS_UNAVAILABLE');
      assert.equal(count(real, 'SELECT COUNT(*) AS n FROM fault_flags'), 0);
      assert.equal((await real.admin.post('/api/admin/faults', { kind: 'clear' })).status, 200);
      assert.equal((await real.admin.post('/api/admin/faults', { kind: 'stock_depletion', supplierCode: 'A' })).status, 200);
    } finally {
      await real.close();
    }
  });

  test('refund_order: only an operation captured under an executed plan; it becomes refund_requested with a queued refund call so:<id>:refund:1; anything else is 409 INVALID_STATE, an unknown order 404', async () => {
    const h2 = await start();
    try {
      const customer = await signIn(h2, 'cafe1');
      const flow = await reservedPlan(h2, customer);
      const order = flow.orders[0];
      const refund = (id) => h2.admin.post('/api/admin/faults', { kind: 'refund_order', supplierOrderId: id });
      assert.equal((await refund(987654)).status, 404);
      const early = await refund(order.id);
      assert.equal(early.status, 409);
      assert.equal(early.json.error.code, 'INVALID_STATE');

      h2.db.prepare("UPDATE plan_versions SET status = 'executed' WHERE id = ?").run(flow.plan.id);
      h2.db.prepare("UPDATE reservations SET status = 'consumed' WHERE id = ?").run(flow.reservation.id);
      h2.db.prepare("UPDATE payment_operations SET status = 'captured', provider_capture_id = 'FAKE-CAP-1' WHERE supplier_order_id = ?").run(order.id);
      const ok = await refund(order.id);
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual(ok.json.applied, { kind: 'refund_order', supplierOrderId: order.id });
      assert.equal(h2.db.prepare('SELECT status FROM payment_operations WHERE supplier_order_id = ?').get(order.id).status, 'refund_requested');
      const call = h2.db.prepare('SELECT kind, operation_key, status, started_at FROM provider_calls').get();
      assert.deepEqual({ ...call }, { kind: 'refund', operation_key: `so:${order.id}:refund:1`, status: 'intent', started_at: null });
      assert.equal((await refund(order.id)).status, 409, 'a second refund is refused');
      assert.equal(count(h2, 'SELECT COUNT(*) AS n FROM provider_calls'), 1);
    } finally {
      await h2.close();
    }
  });
});

describe('timeline and metrics', () => {
  let h;
  let cafe1;
  let cafe2;
  let flow;
  let other;
  before(async () => {
    h = await start();
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
    flow = await reservedPlan(h, cafe1);
    other = await cafe2.post('/api/requests', { text: 'Another customer\'s unrelated request.' });
    h.clock.advance(1000);
    const ops = h.db.prepare('SELECT id, supplier_order_id FROM payment_operations ORDER BY id').all();
    h.db.prepare("INSERT INTO provider_calls (payment_operation_id, kind, attempt, operation_key, status, started_at, finished_at, created_at) VALUES (?, 'create_order', 1, ?, 'succeeded', '2026-10-20T06:03:00.000Z', '2026-10-20T06:03:00.040Z', '2026-10-20T06:03:00.000Z')").run(ops[0].id, `so:${ops[0].supplier_order_id}:create_order:1`);
    h.db.prepare("INSERT INTO provider_calls (payment_operation_id, kind, attempt, operation_key, status, started_at, finished_at, created_at) VALUES (?, 'create_order', 1, ?, 'succeeded', '2026-10-20T06:03:01.000Z', '2026-10-20T06:03:01.010Z', '2026-10-20T06:03:01.000Z')").run(ops[1].id, `so:${ops[1].supplier_order_id}:create_order:1`);
  });
  after(() => h.close());

  test('the timeline merges audit, ledger and provider-call events in time order, each with ids, statuses and codes only', async () => {
    const res = await h.admin.get('/api/admin/timeline');
    assert.equal(res.status, 200, res.text);
    const events = res.json.events;
    assert.deepEqual(keysOf(events[0]), keysOf(fixture('admin-timeline').events[0]));
    assert.deepEqual([...new Set(events.map((e) => e.source))].sort(), ['audit', 'ledger', 'provider_call']);
    assert.ok(events.every((e, i) => i === 0 || events[i - 1].at <= e.at), 'time order');
    assert.equal(new Set(events.map((e) => e.cursor)).size, events.length, 'cursors are unique');
    const created = events.find((e) => e.type === 'reservation.create');
    assert.equal(created.source, 'audit');
    assert.equal(created.entityType, 'reservation');
    assert.equal(created.entityId, flow.reservation.id);
    assert.equal(created.detail.outcome, 'ok');
    const ledger = events.filter((e) => e.source === 'ledger' && e.type === 'reserve');
    assert.equal(ledger.length, 2);
    assert.deepEqual(Object.keys(ledger[0].detail).sort(), ['deltaOnHand', 'deltaReserved', 'onHandAfter', 'refId', 'refType', 'reservedAfter']);
    const call = events.find((e) => e.source === 'provider_call');
    assert.deepEqual(call.detail, { status: 'succeeded', attempt: 1, errorCode: null });
    assert.equal(JSON.stringify(res.json).includes('I need 200 cups'), false, 'no request text');
  });

  test('requestId limits the timeline to that request\'s entities (plan, reservation, orders, operations, their ledger and provider rows)', async () => {
    const mine = await h.admin.get(`/api/admin/timeline?requestId=${flow.requestId}`);
    assert.equal(mine.status, 200);
    const sources = new Set(mine.json.events.map((e) => e.source));
    assert.ok(sources.has('audit') && sources.has('ledger') && sources.has('provider_call'));
    assert.ok(mine.json.events.every((e) => !(e.source === 'audit' && e.entityType === 'request' && e.entityId === other.json.request.id)));
    const theirs = await h.admin.get(`/api/admin/timeline?requestId=${other.json.request.id}`);
    assert.deepEqual(theirs.json.events.map((e) => [e.source, e.type]), [['audit', 'request.create']]);
    assert.deepEqual((await h.admin.get('/api/admin/timeline?requestId=987654')).json.events, []);
  });

  test('limit and afterId page through the timeline without gaps or repeats; bad parameters are 422', async () => {
    const all = (await h.admin.get('/api/admin/timeline?limit=500')).json.events;
    assert.ok(all.length > 8);
    const paged = [];
    let cursor = null;
    for (let i = 0; i < 100; i += 1) {
      const res = await h.admin.get(`/api/admin/timeline?limit=3${cursor ? `&afterId=${cursor}` : ''}`);
      assert.equal(res.status, 200, res.text);
      if (res.json.events.length === 0) break;
      assert.ok(res.json.events.length <= 3);
      paged.push(...res.json.events);
      cursor = res.json.events.at(-1).cursor;
    }
    assert.deepEqual(paged.map((e) => e.cursor), all.map((e) => e.cursor));
    for (const query of ['limit=0', 'limit=501', 'limit=abc', 'afterId=abc', 'afterId=1', 'requestId=abc', 'requestId=0']) {
      const res = await h.admin.get(`/api/admin/timeline?${query}`);
      assert.equal(res.status, 422, query);
      assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    }
  });

  test('metrics: counts by status (archived operations excluded), reconciler fields, provider latency percentiles and the model budget', async () => {
    const res = await h.admin.get('/api/admin/metrics');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(keysOf(res.json), keysOf(fixture('admin-metrics')));
    assert.deepEqual(res.json.counts.operationsByStatus, { created: 2 });
    assert.deepEqual(res.json.counts.plansByStatus, { approved: 1 });
    assert.deepEqual(res.json.counts.reservationsByStatus, { active: 1 });
    assert.deepEqual(res.json.reconciler, { lastTickAt: null, lastTickMs: null, unresolved: 0 });
    assert.deepEqual(res.json.providerLatencyMs, { create_order: { p50: 10, p95: 40, n: 2 } });
    assert.deepEqual(res.json.model, { spentTodayUsd: 0, budgetUsd: h.config.modelDailyBudgetUsd });
    h.db.prepare("UPDATE payment_operations SET archived_at = '2026-10-20T06:10:00.000Z' WHERE id = (SELECT MIN(id) FROM payment_operations)").run();
    const archived = await h.admin.get('/api/admin/metrics');
    assert.deepEqual(archived.json.counts.operationsByStatus, { created: 1 });
  });
});
