// technical-reviewer probe (phase C, SEC-C-1 bound): one customer's single reservation holds every compatible
// bundle (A, B, D, E); cafe1 then has no feasible plan. After the TTL, ONE call of the expiry pass (what e4 must run
// every tick) releases the hold with `expire` ledger rows, and cafe1 gets the canonical A+B plan again.
// Also measures whether the hold survives the TTL when nothing calls the pass (the phase-C runtime).
// Usage: node tr-phc-hoard-expiry.mjs   Exit 0 = the hold forms, survives without a pass, and is released by one pass.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const imp = (p) => import(pathToFileURL(join(root, p)));
const { DEMO_PASSWORD, DEMO_DATE, startHarness } = await imp('test/helpers/app-harness.js');
const { createClient } = await imp('test/helpers/fixtures.js');
const { canonicalFields } = await imp('test/helpers/plan-flow.js');
const { expireDueReservations } = await imp('src/services/reservations.js');

let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };
const h = await startHarness({ seed: true, record: false });
try {
  const hoarder = createClient(h.request);
  await hoarder.register({ username: 'tr-hoarder-1', password: 'long-enough-pw', displayName: 'H' });
  const req = (await hoarder.post('/api/requests', { text: 'everything' })).json.request.id;
  await hoarder.post(`/api/requests/${req}/confirm`, { fields: canonicalFields(DEMO_DATE, { cupQuantity: 500, lidQuantity: 500, maxPickups: 5, budgetCents: 10000000, deadline: `${DEMO_DATE}T12:00` }) });
  const plan = (await hoarder.post(`/api/requests/${req}/plan`, {})).json.plan;
  await hoarder.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash });
  const res = await hoarder.post(`/api/plans/${plan.id}/reserve`, {}, { headers: { 'Idempotency-Key': 'tr-hoard-key-0000000001' } });
  const suppliers = plan.body.suppliers.map((s) => s.supplierCode).join(',');
  check(res.status === 201, `one reservation of ${suppliers} -> ${res.status}`);

  const cafe1 = createClient(h.request);
  await cafe1.signIn('cafe1', DEMO_PASSWORD);
  const r1 = (await cafe1.post('/api/requests', { text: 'canonical' })).json.request.id;
  await cafe1.post(`/api/requests/${r1}/confirm`, { fields: canonicalFields(DEMO_DATE) });
  const before = await cafe1.post(`/api/requests/${r1}/plan`, {});
  check(before.status === 201 && before.json.plan === null, `while held, cafe1 has no feasible plan (plan ${before.json.plan ? 'found' : 'none'})`);

  h.clock.advance(35 * 60_000);
  const stillActive = h.db.prepare("SELECT status FROM reservations WHERE plan_version_id = ?").get(plan.id).status;
  check(stillActive === 'active', `35 min later with no pass called: reservation ${stillActive} (the phase-C runtime calls nothing)`);

  const out = expireDueReservations({ ...h.app.deps, requestId: null });
  const after = h.db.prepare("SELECT status FROM reservations WHERE plan_version_id = ?").get(plan.id).status;
  const reserved = h.db.prepare('SELECT SUM(reserved) AS n FROM inventory').get().n;
  const expireRows = h.db.prepare("SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'expire'").get().n;
  check(out.expired.length === 1 && after === 'expired' && reserved === 0 && expireRows > 0, `one expiry pass: expired ${out.expired.length}, status ${after}, total reserved ${reserved}, expire rows ${expireRows}`);

  await cafe1.signIn('cafe1', DEMO_PASSWORD);
  h.clock.advance(61_000);
  const later = await cafe1.post(`/api/requests/${r1}/plan`, {});
  const codes = later.json.plan ? later.json.plan.body.suppliers.map((s) => s.supplierCode).join('+') : 'none';
  check(later.status === 201 && codes === 'A+B', `after the pass, cafe1's plan is ${codes} (${later.json.plan?.body.totalCents ?? '-'} cents)`);
} finally {
  await h.close();
}
console.log(failed ? `${failed} FAILED` : 'SEC-C-1 reproduced, and bounded by one expiry pass');
process.exit(failed ? 1 : 0);
