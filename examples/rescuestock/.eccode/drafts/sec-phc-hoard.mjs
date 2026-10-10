// SEC-2 residual probe (security-reviewer, phase C): the live-reservation cap counts reservations, not stock.
// One self-registered customer, ONE reservation, asks for enough cups and lids that the plan needs every compatible
// supplier's seeded bundle (A, B, D, E; C's lids are 95 mm). Then: the canonical RS-FIX-1 customer's plan, and the
// state after the TTL with no expiry pass called (nothing in src/ schedules expireDueReservations before e4's
// reconciler). Expectations encode the reproduction (REPRO).
import { startHarness, DEMO_DATE, DEMO_PASSWORD } from '../../test/helpers/app-harness.js';
import { createClient } from '../../test/helpers/fixtures.js';
import { canonicalFields } from '../../test/helpers/plan-flow.js';

let failures = 0;
const check = (label, cond, info = '') => { if (!cond) failures += 1; console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${info ? ` | ${info}` : ''}`); };
const short = (r) => `${r.status} ${r.json?.error?.code ?? ''}`.trim();

const h = await startHarness({ seed: true, record: false });
try {
  const held = () => h.db.prepare("SELECT s.code, i.on_hand, i.reserved FROM inventory i JOIN products p ON p.id = i.product_id JOIN suppliers s ON s.id = p.supplier_id WHERE p.kind = 'bundle' ORDER BY s.code").all();
  console.log(`seeded bundle stock: ${JSON.stringify(held())}`);
  const hoarder = createClient(h.request);
  await hoarder.register({ username: 'hoarder-1', password: 'long-enough-pw', displayName: 'H' });
  const created = await hoarder.post('/api/requests', { text: 'everything' });
  const id = created.json.request.id;
  let plan = null;
  for (const qty of [300, 400, 500, 600]) {
    await hoarder.post(`/api/requests/${id}/confirm`, { fields: canonicalFields(DEMO_DATE, { cupQuantity: qty, lidQuantity: qty, maxPickups: 5, budgetCents: 100000000, deadline: `${DEMO_DATE}T12:00` }) });
    const made = await hoarder.post(`/api/requests/${id}/plan`, {});
    const p = made.json?.plan;
    console.log(`qty ${qty}: ${p ? `${p.body.suppliers.map((s) => s.supplierCode).join(',')} total ${p.body.totalCents}` : `no plan (${short(made)})`}`);
    if (p && (!plan || p.body.suppliers.length > plan.body.suppliers.length)) plan = p;
  }
  check('REPRO setup: one plan uses A, B, D and E (every bundle compatible with 250 ml / 90 mm)', plan && plan.body.suppliers.length === 4, plan ? plan.body.suppliers.map((s) => s.supplierCode).join(',') : 'none');
  // re-plan at the chosen size so the approved version is the current one
  await hoarder.post(`/api/requests/${id}/confirm`, { fields: canonicalFields(DEMO_DATE, { cupQuantity: plan.body.lines.reduce((n, l) => n + l.cups, 0), lidQuantity: plan.body.lines.reduce((n, l) => n + l.lids, 0), maxPickups: 5, budgetCents: 100000000, deadline: `${DEMO_DATE}T12:00` }) });
  const made = await hoarder.post(`/api/requests/${id}/plan`, {});
  plan = made.json.plan;
  const ap = await hoarder.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
  const rs = await hoarder.post(`/api/plans/${plan.id}/reserve`, {}, { headers: { 'Idempotency-Key': 'hoard-key-000000000001' } });
  const after = held();
  const taken = after.filter((r) => r.reserved === r.on_hand && r.on_hand > 0).map((r) => r.code);
  check('REPRO SEC-2 residual: ONE reservation (within the cap of 1) holds A, B, D and E', ap.status === 200 && rs.status === 201 && ['A', 'B', 'D', 'E'].every((c) => taken.includes(c)), `${short(ap)} ${short(rs)} held ${taken.join(',')}`);

  const victim = createClient(h.request);
  await victim.signIn('cafe1', DEMO_PASSWORD);
  const v = await victim.post('/api/requests', { text: '200 cups' });
  await victim.post(`/api/requests/${v.json.request.id}/confirm`, { fields: canonicalFields(DEMO_DATE) });
  const vp = await victim.post(`/api/requests/${v.json.request.id}/plan`, {});
  check('REPRO the canonical RS-FIX-1 customer (cafe1) now gets no feasible plan', vp.status === 201 && vp.json.plan === null, `${short(vp)} plan=${vp.json?.plan === null ? 'none' : 'found'}`);

  h.clock.advance((h.config.reservationTtlMin + 5) * 60 * 1000);
  const vp2 = await victim.post(`/api/requests/${v.json.request.id}/plan`, {});
  const st = h.db.prepare('SELECT status, expires_at FROM reservations WHERE id = ?').get(rs.json.reservation.id);
  check('REPRO after TTL + 5 min with no expiry pass running, the hold is still active and cafe1 still has no plan', st.status === 'active' && vp2.json.plan === null, `reservation ${st.status} (expires_at ${st.expires_at}), cafe1 plan ${vp2.json?.plan === null ? 'none' : 'found'}`);
} finally {
  await h.close();
}
console.log(failures === 0 ? 'ALL EXPECTATIONS MET' : `${failures} EXPECTATION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
