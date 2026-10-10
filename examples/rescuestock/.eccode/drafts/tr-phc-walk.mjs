// technical-reviewer probe (phase C): seeded random walk through the live HTTP API (in-process harness, RS-FIX-1 seed,
// fake adapters, record:false so nothing is written under test/.out). Actors: customers (cafe1, cafe2, 3 registered),
// the five supplier users and admin. Actions: create+confirm a request, re-confirm changed or identical requirements,
// plan, approve (correct, or tampered hash/total), reserve (new key, replay, key reused on another plan), supplier
// confirm/refuse/ready, supplier PATCH (price, prep fee, ready time, withdraw, reactivate, onHand up/down), clock
// advance + expiry pass, admin faults stock_depletion / supplier_refusal, admin reset (rare).
// After EVERY step it checks, in SQL and through the API:
//   I1 inventory.reserved == sum of reservation_items.qty of `active` reservations, per product
//   I2 sum(ledger.delta_reserved) == reserved and sum(ledger.delta_on_hand) == on_hand, per product
//   I3 0 <= reserved <= on_hand
//   I4 no `active` reservation whose plan version is not `approved`
//   I5 no supplier order awaiting_supplier/confirmed under a superseded or non_executable version
//   I6 no payment operation still `created` under a superseded or non_executable version
//   I7 every reservation has one `reserve` ledger row per item; released/expired ones one release/expire row per item
//   I8 no response 500; no log line http.error or derive.fallback
//   I9 GET /api/requests/:id of every visible request answers 200 and rescueStatus.rule != "14"
//   I10 idempotent replay returns the same reservation id; key reused on another plan -> 422 and no row written
// Usage: node tr-phc-walk.mjs <seed> <steps> [maxLive]   Exit 0 = every invariant held on every step.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const imp = (p) => import(pathToFileURL(join(root, p)));
const { DEMO_PASSWORD, DEMO_DATE, startHarness } = await imp('test/helpers/app-harness.js');
const { createClient } = await imp('test/helpers/fixtures.js');
const { ensureAdmin } = await imp('src/services/users.js');
const { expireDueReservations } = await imp('src/services/reservations.js');

let seed = Number(process.argv[2] || 7);
const STEPS = Number(process.argv[3] || 300);
const MAX_LIVE = process.argv[4] || '1';
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ADMIN_PASSWORD = 'admin-password-for-review-0001';

const h = await startHarness({
  seed: true,
  record: false,
  env: { RS_ADMIN_PASSWORD: ADMIN_PASSWORD, RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '100000', RS_MAX_LIVE_RESERVATIONS_PER_CUSTOMER: MAX_LIVE },
});
await ensureAdmin({ db: h.db, config: h.config, clock: h.clock });
const db = h.db;
const failures = [];
const stats = {};
const note = (action, status) => { const k = `${action} ${status}`; stats[k] = (stats[k] || 0) + 1; };
const fail = (step, what) => { if (failures.length < 30) failures.push(`step ${step}: ${what}`); };

const creds = new Map();
async function signIn(username, password = DEMO_PASSWORD) { const c = createClient(h.request); await c.signIn(username, password); creds.set(c, [username, password]); return c; }
let lastLogin = h.clock.now();
async function refreshSessions() { for (const [c, [u, p]] of creds) await c.signIn(u, p); lastLogin = h.clock.now(); }
const customers = [await signIn('cafe1'), await signIn('cafe2')];
for (let i = 0; i < 3; i++) { const c = createClient(h.request); const u = `rev-walk-${i}-${process.pid}`; await c.register({ username: u, password: 'review-walk-password', displayName: 'Walk' }); creds.set(c, [u, 'review-walk-password']); customers.push(c); }
const suppliers = {};
for (const code of ['A', 'B', 'C', 'D', 'E']) suppliers[code] = await signIn(`supplier-${code.toLowerCase()}`);
const admin = await signIn('admin', ADMIN_PASSWORD);

const keysUsed = []; // { client, planId, key, reservationId }
let keyN = 0;
const newKey = () => `rev-walk-key-${String(++keyN).padStart(8, '0')}-${seed % 1000}`;

function fields() {
  const q = pick([200, 200, 200, 100, 300]);
  return {
    productType: 'cups_and_lids', cupQuantity: q, lidQuantity: pick([q, q, 100]), capacityMl: 250, diameterMm: 90, material: null,
    deadline: `${DEMO_DATE}T${pick(['11:00', '12:00', '23:00'])}`, budgetCents: pick([12000, 20000, 50000, 20000, 9000]), maxPickups: pick([2, 2, 3, 1]),
  };
}
const ownRequests = (c) => db.prepare('SELECT id FROM rescue_requests WHERE customer_id = ? AND archived_at IS NULL').all(c.user.id).map((r) => r.id);
const plansOf = (c, status) => db.prepare('SELECT pv.* FROM plan_versions pv JOIN rescue_requests rr ON rr.id = pv.request_id WHERE rr.customer_id = ? AND rr.archived_at IS NULL AND pv.status = ?').all(c.user.id, status);

async function act(step) {
  const c = pick(customers);
  const r = rnd();
  if (r < 0.12) {
    const created = await c.post('/api/requests', { text: 'need cups and lids' });
    note('create', created.status);
    if (created.status !== 201) return created;
    const res = await c.post(`/api/requests/${created.json.request.id}/confirm`, { fields: fields() });
    note('confirm', res.status);
    return res;
  }
  if (r < 0.17) {
    const ids = ownRequests(c); if (!ids.length) return null;
    const id = pick(ids);
    const prev = db.prepare('SELECT * FROM requirements WHERE request_id = ? ORDER BY version DESC LIMIT 1').get(id);
    let body = fields();
    if (prev && rnd() < 0.4) body = JSON.parse(JSON.stringify((await c.get(`/api/requests/${id}`)).json?.requirements?.fields ? Object.fromEntries(Object.entries((await c.get(`/api/requests/${id}`)).json.requirements.fields).map(([k, v]) => [k, v.value])) : body));
    const res = await c.post(`/api/requests/${id}/confirm`, { fields: body });
    note('reconfirm', res.status);
    return res;
  }
  if (r < 0.32) {
    const ids = ownRequests(c); if (!ids.length) return null;
    h.clock.advance(61_000);
    const res = await c.post(`/api/requests/${pick(ids)}/plan`, {});
    note('plan', res.status);
    return res;
  }
  if (r < 0.45) {
    const ps = plansOf(c, 'proposed'); if (!ps.length) return null;
    const p = pick(ps);
    const tamper = rnd() < 0.15;
    const res = await c.post(`/api/plans/${p.id}/approve`, { expectedTotalCents: tamper ? p.total_cents + 1 : p.total_cents, planHash: p.plan_hash });
    note(tamper ? 'approve-tampered' : 'approve', res.status);
    if (tamper && res.status !== 409) fail(step, `tampered approve answered ${res.status}`);
    if (!tamper && res.status === 200 && rnd() < 0.7) {
      const key = newKey();
      const rr = await c.post(`/api/plans/${p.id}/reserve`, {}, { headers: { 'Idempotency-Key': key } });
      note('reserve-after-approve', `${rr.status}${rr.json?.error ? ` ${rr.json.error.code}` : ''}`);
      keysUsed.push({ client: c, planId: p.id, key, reservationId: rr.status === 201 ? rr.json.reservation.id : null });
      return rr;
    }
    return res;
  }
  if (r < 0.60) {
    const ps = plansOf(c, 'approved');
    const roll = rnd();
    if (roll < 0.2 && keysUsed.length) {
      // replay or reuse on another plan
      const k = pick(keysUsed.filter((x) => x.client === c).concat([]));
      if (!k) return null;
      const other = ps.find((p) => p.id !== k.planId);
      const target = other && rnd() < 0.5 ? other.id : k.planId;
      const before = db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n;
      const res = await c.post(`/api/plans/${target}/reserve`, {}, { headers: { 'Idempotency-Key': k.key } });
      note(target === k.planId ? 'reserve-replay' : 'reserve-key-other-plan', res.status);
      const after = db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n;
      if (target !== k.planId) {
        if (res.status !== 422 || res.json?.error?.code !== 'IDEMPOTENCY_KEY_REUSED') fail(step, `key reused on another plan answered ${res.status} ${res.json?.error?.code}`);
        if (after !== before) fail(step, 'key reused on another plan wrote a reservation');
      } else if (k.reservationId && res.status < 300 && res.json?.reservation?.id !== k.reservationId) {
        fail(step, `replay returned reservation ${res.json?.reservation?.id}, expected ${k.reservationId}`);
      }
      if (after !== before) fail(step, 'a replay wrote a reservation row');
      return res;
    }
    if (!ps.length) return null;
    const p = pick(ps);
    const key = newKey();
    const res = await c.post(`/api/plans/${p.id}/reserve`, {}, { headers: { 'Idempotency-Key': key } });
    note('reserve', `${res.status}${res.json?.error ? ` ${res.json.error.code}` : ''}`);
    keysUsed.push({ client: c, planId: p.id, key, reservationId: res.status === 201 ? res.json.reservation.id : null });
    return res;
  }
  if (r < 0.72) {
    const code = pick(['A', 'B', 'C', 'D', 'E']);
    const s = suppliers[code];
    const list = await s.get('/api/supplier/orders');
    const open = (list.json?.orders || []).filter((o) => o.fulfilmentStatus === 'awaiting_supplier' || o.fulfilmentStatus === 'confirmed');
    if (!open.length) return list;
    const o = pick(open);
    const roll = rnd();
    let res;
    if (roll < 0.6) {
      res = await s.post(`/api/supplier/orders/${o.id}/confirm`, { lines: o.lines.map((l) => ({ offerId: l.offerId, committedBundles: l.bundles })), committedReadyAt: o.catalogReadyAt });
      note('supplier-confirm', `${res.status}${res.json?.error ? ` ${res.json.error.code}` : ''}`);
    } else if (roll < 0.85) {
      res = await s.post(`/api/supplier/orders/${o.id}/refuse`, { reason: 'Out of lids today' });
      note('supplier-refuse', res.status);
    } else {
      res = await s.post(`/api/supplier/orders/${o.id}/ready`, {});
      note('supplier-ready', `${res.status}${res.json?.error ? ` ${res.json.error.code}` : ''}`);
      if (res.status === 200) fail(step, 'ready accepted before execution');
    }
    return res;
  }
  if (r < 0.84) {
    const code = pick(['A', 'B', 'C', 'D', 'E']);
    const s = suppliers[code];
    const inv = await s.get('/api/supplier/inventory');
    const items = (inv.json?.items || []).filter((i) => i.offer);
    if (!items.length) return inv;
    const it = pick(items);
    const kind = pick(['price', 'prep', 'ready', 'withdraw', 'reactivate', 'onUp', 'onDown', 'onDown']);
    const patch = { productId: it.productId };
    if (kind === 'price') patch.priceCents = it.offer.priceCents + pick([-100, 100, 500]);
    if (kind === 'prep') patch.prepFeeCents = it.offer.prepFeeCents + pick([0, 100]);
    if (kind === 'ready') patch.readyAt = pick(['2026-10-20T07:00:00.000Z', '2026-10-20T07:30:00.000Z', '2026-10-20T09:00:00.000Z']);
    if (kind === 'withdraw') patch.withdrawn = true;
    if (kind === 'reactivate') patch.withdrawn = false;
    if (kind === 'onUp') patch.onHand = it.onHand + pick([1, 2, 5]);
    if (kind === 'onDown') patch.onHand = Math.max(0, it.onHand - pick([1, 2]));
    if (patch.priceCents !== undefined && patch.priceCents < 0) patch.priceCents = 0;
    const res = await s.send({ method: 'PATCH', path: '/api/supplier/inventory', jsonBody: { items: [patch] } });
    note(`patch-${kind}`, `${res.status}${res.json?.error ? ` ${res.json.error.code}` : ''}`);
    return res;
  }
  if (r < 0.93) {
    h.clock.advance(pick([60_000, 5 * 60_000, 20 * 60_000, 31 * 60_000]));
    const out = expireDueReservations({ ...h.app.deps, requestId: null, log: h.app.deps.log });
    note('expire-pass', out.expired.length);
    const again = expireDueReservations({ ...h.app.deps, requestId: null, log: h.app.deps.log });
    if (again.expired.length !== 0) fail(step, 'second expiry pass expired something');
    return null;
  }
  if (r < 0.985) {
    const body = rnd() < 0.5 ? { kind: 'stock_depletion', supplierCode: pick(['A', 'B', 'E']) } : { kind: 'supplier_refusal', supplierCode: pick(['A', 'B', 'E']), reason: 'Admin fault' };
    const res = await admin.post('/api/admin/faults', body);
    note(`fault-${body.kind}`, res.status);
    return res;
  }
  const res = await admin.post('/api/admin/reset', {});
  note('reset', res.status);
  return res;
}

function checkInvariants(step) {
  for (const p of db.prepare('SELECT product_id, on_hand, reserved FROM inventory').all()) {
    const held = db.prepare("SELECT COALESCE(SUM(ri.qty),0) AS n FROM reservation_items ri JOIN reservations r ON r.id = ri.reservation_id WHERE r.status = 'active' AND ri.product_id = ?").get(p.product_id).n;
    if (held !== p.reserved) fail(step, `I1 product ${p.product_id}: reserved ${p.reserved} but active items hold ${held}`);
    const l = db.prepare('SELECT COALESCE(SUM(delta_reserved),0) AS r, COALESCE(SUM(delta_on_hand),0) AS o FROM inventory_ledger WHERE product_id = ?').get(p.product_id);
    if (l.r !== p.reserved || l.o !== p.on_hand) fail(step, `I2 product ${p.product_id}: ledger ${l.o}/${l.r} vs ${p.on_hand}/${p.reserved}`);
    if (p.reserved < 0 || p.reserved > p.on_hand) fail(step, `I3 product ${p.product_id}: reserved ${p.reserved} on_hand ${p.on_hand}`);
  }
  const i4 = db.prepare("SELECT r.id, pv.status FROM reservations r JOIN plan_versions pv ON pv.id = r.plan_version_id WHERE r.status = 'active' AND pv.status <> 'approved'").all();
  if (i4.length) fail(step, `I4 active reservation under ${JSON.stringify(i4)}`);
  const i5 = db.prepare("SELECT so.id, so.fulfilment_status, pv.status FROM supplier_orders so JOIN plan_versions pv ON pv.id = so.plan_version_id WHERE so.fulfilment_status IN ('awaiting_supplier','confirmed') AND pv.status IN ('superseded','non_executable')").all();
  if (i5.length) fail(step, `I5 open order under closed plan ${JSON.stringify(i5)}`);
  const i6 = db.prepare("SELECT po.id, pv.status FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id JOIN plan_versions pv ON pv.id = so.plan_version_id WHERE po.status = 'created' AND pv.status IN ('superseded','non_executable')").all();
  if (i6.length) fail(step, `I6 created operation under closed plan ${JSON.stringify(i6)}`);
  for (const res of db.prepare('SELECT id, status FROM reservations').all()) {
    const items = db.prepare('SELECT COUNT(*) AS n FROM reservation_items WHERE reservation_id = ?').get(res.id).n;
    const reserveRows = db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE ref_type = 'reservation' AND ref_id = ? AND reason = 'reserve'").get(res.id).n;
    const closeRows = db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE ref_type = 'reservation' AND ref_id = ? AND reason IN ('release','expire')").get(res.id).n;
    if (reserveRows !== items) fail(step, `I7 reservation ${res.id}: ${items} items, ${reserveRows} reserve rows`);
    const closed = res.status === 'released' || res.status === 'expired';
    if (closed && closeRows !== items) fail(step, `I7 reservation ${res.id} ${res.status}: ${items} items, ${closeRows} release/expire rows`);
    if (!closed && closeRows !== 0) fail(step, `I7 reservation ${res.id} ${res.status} has ${closeRows} release rows`);
  }
}

async function checkViews(step) {
  for (const c of customers) {
    for (const id of ownRequests(c)) {
      const v = await c.get(`/api/requests/${id}`);
      if (v.status !== 200) fail(step, `I9 view ${id} answered ${v.status}`);
      else if (v.json.rescueStatus?.rule === '14') fail(step, `I9 request ${id} derived row 14 (${JSON.stringify(v.json.rescueStatus.underlying)})`);
      else note('view-rule', v.json.rescueStatus.rule);
    }
  }
}

for (let step = 1; step <= STEPS; step++) {
  if (h.clock.now() - lastLogin > 45 * 60_000) await refreshSessions();
  let res;
  try {
    res = await act(step);
  } catch (err) {
    fail(step, `action threw ${err.message}`);
  }
  if (res && res.status >= 500) fail(step, `I8 response ${res.status} ${res.text.slice(0, 200)}`);
  checkInvariants(step);
  if (step % 5 === 0 || step === STEPS) { if (h.clock.now() - lastLogin > 45 * 60_000) await refreshSessions(); await checkViews(step); }
}
const bad = h.logEntries().filter((e) => e.msg === 'http.error' || e.msg === 'derive.fallback' || e.event === 'http.error' || e.event === 'derive.fallback' || /http\.error|derive\.fallback/.test(JSON.stringify(e)));
if (bad.length) fail(STEPS, `I8 log lines: ${JSON.stringify(bad.slice(0, 3))}`);
await h.close();
console.log(`seed ${process.argv[2] || 7}, steps ${STEPS}, maxLive ${MAX_LIVE}`);
console.log(Object.entries(stats).sort().map(([k, v]) => `  ${k}: ${v}`).join('\n'));
console.log(failures.length ? `FAILURES (${failures.length}):\n  ${failures.join('\n  ')}` : 'all invariants held on every step');
process.exit(failures.length ? 1 : 0);
