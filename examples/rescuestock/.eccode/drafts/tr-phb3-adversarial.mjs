// technical-reviewer probe (phase B, third review): adversarial tie-laden inputs restricted to what version one's API
// can produce. Products are fixed by the seed (A, B, E: 100 cups+lids; D: 200; C: 200 with 95 mm lids and no route
// creates a compatibility row). Suppliers can PATCH price, prep fee, ready time, onHand and withdrawn; customers set
// cups/lids 1-100,000, budget, deadline, maxPickups 1-5; the operator sets RS_TAX_BP.
// Prices are drawn from tie-heavy sets (per-cup equal, +-1, multiples of a common unit) to maximise equal-cost splits.
// Also runs the same generator with C confirmed compatible (NOT reachable by PATCH) and with 12 offers (NOT reachable:
// no route creates offers) to locate the residual the engineer describes.
// Usage: node tr-phb3-adversarial.mjs <seed> <calls>.  Prints counts; exits 0 always (this is a measurement).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { plan } = await import(pathToFileURL(join(process.cwd(), 'src/domain/planner.js')));
let seed = Number(process.argv[2] || 99); const N = Number(process.argv[3] || 2000);
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const T = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return new Date(Date.UTC(2026, 9, 20, h - 3, m)).toISOString(); };
const priceFor = (size, mode) => {
  const unit = mode === 'tie' ? 30 : mode === 'tie2' ? pick([25, 30]) : 10 + Math.floor(rnd() * 90);
  return unit * size + (mode === 'tie' ? pick([0, 0, 1, -1]) : 0);
};
function catalog(kind, mode) {
  if (kind === 'seeded' || kind === 'seededC') {
    return [['A', 100, 90], ['B', 100, 90], ['C', 200, 95], ['D', 200, 90], ['E', 100, 90]].map(([c, s, lid], i) => ({
      supplierCode: c, offerId: i + 1, offerVersion: 1, units: { cups: s, lids: s }, capacityMl: 250, cupDiameterMm: 90, lidDiameterMm: lid,
      confirmedCompatible: kind === 'seededC', priceCents: priceFor(s, mode), prepFeeCents: pick([0, 1000, 1000, 500]),
      readyAt: T(pick(['10:00', '10:00', '10:30'])), availability: pick([100000, 1000, 500]), withdrawn: false, demo: true }));
  }
  return Array.from({ length: 12 }, (_, i) => { const s = pick([50, 100, 200]); return { supplierCode: 'ABCDE'[i % 5], offerId: i + 1, offerVersion: 1,
    units: { cups: s, lids: s }, capacityMl: 250, cupDiameterMm: 90, lidDiameterMm: 90, confirmedCompatible: false, priceCents: priceFor(s, mode),
    prepFeeCents: pick([0, 1000]), readyAt: T('10:00'), availability: 100000, withdrawn: false, demo: true }; });
}
for (const kind of ['seeded', 'seededC', 'twelve']) {
  let limit = 0, worst = 0, worstLimit = 0; const ms = [];
  for (let n = 0; n < N; n++) {
    const mode = pick(['tie', 'tie', 'tie2', 'rand']);
    const qty = pick([50000, 60000, 75000, 99900, 100000]);
    const input = { requirement: { cups: qty, lids: pick([qty, qty, Math.floor(qty / 2)]), capacityMl: 250, diameterMm: 90, material: null },
      budgetCents: pick([null, null, 100000000, 5000000]), deadlineAt: pick([null, T('11:00')]), maxPickups: 1 + Math.floor(rnd() * 5),
      taxBp: pick([0, 1600, 1750, 500]), offers: catalog(kind, mode) };
    const t = process.hrtime.bigint(); let out = 'ok';
    try { plan(input); } catch (e) { out = e.code || e.name; }
    const d = Number(process.hrtime.bigint() - t) / 1e6; ms.push(d); worst = Math.max(worst, d);
    if (out === 'PLANNER_LIMIT') { limit++; worstLimit = Math.max(worstLimit, d); }
  }
  ms.sort((a, b) => a - b);
  const label = kind === 'seeded' ? 'seeded products (reachable by PATCH)' : kind === 'seededC' ? 'seeded with C confirmed (NOT reachable)' : '12 offers (NOT reachable in version one)';
  console.log(`${label}: ${N} calls, PLANNER_LIMIT ${limit} (${(100 * limit / N).toFixed(2)} %), worst ${worst.toFixed(1)} ms, p99 ${ms[Math.floor(N * 0.99)].toFixed(1)} ms${limit ? `, worst refused ${worstLimit.toFixed(1)} ms` : ''}`);
}
process.exit(0);
