// technical-reviewer probe (phase C, RS-36 (i)-(iv) on the live endpoint), independent of c2's rescue-status test.
// Each case: a fresh seeded harness; cafe1 makes a request, confirms the canonical fields, plans (A + B), approves and
// reserves through the API (so the orders and payment operations are the ones c3 writes). The probe then moves the
// persisted rows to the case's state with SQL (the payment routes arrive in phase E) and reads
// GET /api/requests/:id, comparing rescueStatus.status. Case (iv) plans the new version through the API.
// Also: the schema has no column that stores a rescue status (PRAGMA table_info over every table).
// Usage: node tr-phc-rs36.mjs   Exit 0 = every case gives the brief's status.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const imp = (p) => import(pathToFileURL(join(root, p)));
const { DEMO_PASSWORD, DEMO_DATE, startHarness } = await imp('test/helpers/app-harness.js');
const { createClient } = await imp('test/helpers/fixtures.js');
const { approvedPlan, reserve, idempotencyKey } = await imp('test/helpers/plan-flow.js');

const results = [];
let failed = 0;

async function base() {
  const h = await startHarness({ seed: true, record: false });
  const c = createClient(h.request);
  await c.signIn('cafe1', DEMO_PASSWORD);
  const { requestId, plan } = await approvedPlan(c, DEMO_DATE);
  const r = await reserve(c, plan.id, idempotencyKey('rs36'));
  if (r.status !== 201) throw new Error('reserve failed ' + r.status + ' ' + r.text);
  const orders = h.db.prepare('SELECT so.id, s.code FROM supplier_orders so JOIN suppliers s ON s.id = so.supplier_id WHERE so.plan_version_id = ? ORDER BY s.code').all(plan.id);
  const ops = Object.fromEntries(orders.map((o) => [o.code, h.db.prepare('SELECT id FROM payment_operations WHERE supplier_order_id = ?').get(o.id).id]));
  const ord = Object.fromEntries(orders.map((o) => [o.code, o.id]));
  const nowIso = (deltaMs = 0) => new Date(h.clock.now() + deltaMs).toISOString();
  const sql = (text, ...args) => h.db.prepare(text).run(...args);
  return { h, c, requestId, plan, ord, ops, nowIso, sql };
}

async function expect(name, ctx, want) {
  const v = await ctx.c.get(`/api/requests/${ctx.requestId}`);
  const got = v.json?.rescueStatus?.status;
  const ok = v.status === 200 && got === want;
  if (!ok) failed++;
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got} (rule ${v.json?.rescueStatus?.rule}) expected ${want}`);
}

function executed(x, fA, fB, opA = 'captured', opB = 'captured') {
  x.sql("UPDATE plan_versions SET status = 'executed' WHERE id = ?", x.plan.id);
  x.sql("UPDATE reservations SET status = 'consumed' WHERE plan_version_id = ?", x.plan.id);
  x.sql('UPDATE supplier_orders SET fulfilment_status = ? WHERE id = ?', fA, x.ord.A);
  x.sql('UPDATE supplier_orders SET fulfilment_status = ? WHERE id = ?', fB, x.ord.B);
  x.sql('UPDATE payment_operations SET status = ? WHERE id = ?', opA, x.ops.A);
  x.sql('UPDATE payment_operations SET status = ? WHERE id = ?', opB, x.ops.B);
}

function refused(x, opA, extra = {}) {
  x.sql("UPDATE plan_versions SET status = 'non_executable', non_executable_reason = 'SUPPLIER_REFUSED', reason_detail_json = ? WHERE id = ?", JSON.stringify({ supplierCode: 'B', refusal: 'no lids' }), x.plan.id);
  x.sql("UPDATE reservations SET status = 'released' WHERE plan_version_id = ?", x.plan.id);
  x.sql("UPDATE supplier_orders SET fulfilment_status = 'refused', refusal_reason = 'no lids' WHERE id = ?", x.ord.B);
  x.sql("UPDATE supplier_orders SET fulfilment_status = 'cancelled' WHERE id = ?", x.ord.A);
  x.sql("UPDATE payment_operations SET status = 'voided', cancel_requested_at = ? WHERE id = ?", x.nowIso(), x.ops.B);
  x.sql('UPDATE payment_operations SET status = ?, cancel_requested_at = ?, unknown_since = ?, pending_since = ?, void_failed = ?, prev_status = ? WHERE id = ?',
    opA, x.nowIso(), extra.unknownSince ?? null, extra.pendingSince ?? null, extra.voidFailed ?? 0, extra.prev ?? null, x.ops.A);
}

const cases = [
  ['(iii) control: executed, both captured, both collected', (x) => executed(x, 'collected', 'collected'), 'collected'],
  ['(iii) one ready, one collected', (x) => executed(x, 'ready', 'collected'), 'ready_for_pickup'],
  ['(i) refund_requested while every other order is collected', (x) => executed(x, 'collected', 'collected', 'refund_requested', 'captured'), 'refunding'],
  ['(i) refund_pending on one order', (x) => executed(x, 'collected', 'collected', 'captured', 'refund_pending'), 'refunding'],
  ['(ii) refusal, other operation still authorized', (x) => refused(x, 'authorized', { prev: 'approved' }), 'cancelling'],
  ['(ii) refusal, other operation authorization_pending', (x) => refused(x, 'authorization_pending', { pendingSince: x.nowIso(-60_000) }), 'cancelling'],
  ['(ii) refusal, other operation unknown within the limit', (x) => refused(x, 'unknown', { unknownSince: x.nowIso(-60_000), prev: 'authorized' }), 'cancelling'],
  ['(ii) refusal, other operation refund_failed', (x) => refused(x, 'refund_failed', { prev: 'refund_pending' }), 'failed_needs_attention'],
  ['(ii) refusal, failed void', (x) => refused(x, 'authorized', { voidFailed: 1, prev: 'approved' }), 'failed_needs_attention'],
  ['(ii) refusal, over-age unknown', (x) => refused(x, 'unknown', { unknownSince: x.nowIso(-16 * 60_000), prev: 'authorized' }), 'failed_needs_attention'],
];

for (const [name, setup, want] of cases) {
  const x = await base();
  try {
    setup(x);
    await expect(name, x, want);
  } finally {
    await x.h.close();
  }
}

// (iv): every void completed after a refusal, then a new version is proposed (through the API).
{
  const x = await base();
  try {
    const sb = createClient(x.h.request);
    await sb.signIn('supplier-b', DEMO_PASSWORD);
    const ref = await sb.post(`/api/supplier/orders/${x.ord.B}/refuse`, { reason: 'No lids today' });
    if (ref.status !== 200) { failed++; results.push(`FAIL (iv) refuse answered ${ref.status} ${ref.text.slice(0, 200)}`); }
    const opsNow = x.h.db.prepare('SELECT status FROM payment_operations').all().map((o) => o.status);
    const resNow = x.h.db.prepare('SELECT status FROM reservations').all().map((o) => o.status);
    const stockNow = x.h.db.prepare('SELECT SUM(reserved) AS n FROM inventory').get().n;
    results.push(`     (iv) after the refusal route: operations ${opsNow.join(',')}; reservation ${resNow.join(',')}; total reserved ${stockNow}`);
    if (opsNow.some((s) => s !== 'voided') || resNow[0] !== 'released' || stockNow !== 0) { failed++; results.push('FAIL (iv) the void rule left work behind'); }
    await expect('(iv) after the refusal, re-plan queued', x, 'replanning');
    x.h.clock.advance(61_000);
    const made = await x.c.post(`/api/requests/${x.requestId}/plan`, {});
    if (made.status !== 201 || !made.json.plan) { failed++; results.push(`FAIL (iv) re-plan answered ${made.status} ${made.text.slice(0, 200)}`); }
    await expect('(iv) all voids complete after a refusal, new version proposed', x, 'plan_found');
    const v = await x.c.get(`/api/requests/${x.requestId}`);
    results.push(`     (iv) nextStep ${v.json.rescueStatus.nextStep.code}: "${v.json.rescueStatus.nextStep.text}"; message: ${JSON.stringify(v.json.rescueStatus.message)}`);
  } finally {
    await x.h.close();
  }
}

// Schema: no column storing a rescue status.
{
  const h = await startHarness({ seed: true, record: false });
  try {
    const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    const hits = [];
    for (const t of tables) for (const col of h.db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all()) {
      if (/rescue|aggregate|overall/i.test(col.name) || (t === 'rescue_requests' && /status/i.test(col.name) && col.name !== 'intake_status')) hits.push(`${t}.${col.name}`);
    }
    if (hits.length) failed++;
    results.push(`${hits.length ? 'FAIL' : 'PASS'} schema: ${tables.length} tables, columns that could store a rescue status: ${hits.length ? hits.join(', ') : 'none'}`);
  } finally {
    await h.close();
  }
}

console.log(results.join('\n'));
console.log(failed ? `${failed} FAILED` : 'RS-36 (i)-(iv) hold on the live endpoint');
process.exit(failed ? 1 : 0);
