// technical-reviewer probe (phase B, third review, SEC-B-1 residual).
// Part A: src/domain/planner.js vs the frozen reference planner (test/unit/domain/helpers/reference-planner.js) on
//   fresh-seed medium catalogs (<= 8 offers, availability 0-20, quantities 100-2000, mixed bundle sizes incl. cups-only
//   and lids-only, confirmed rows, withdrawn, tax 0/1600). Compares the full output except trace.enumerated; inputs on
//   which the reference itself hits its node cap are skipped and counted.
// Part B: the residual on what suppliers can actually change. Seeded shape: A, B, E bundles of 100, D of 200 (C has
//   95 mm lids and no route creates a compatibility row, so it stays rejected; a variant with C confirmed is reported
//   separately as NOT reachable by PATCH). Suppliers PATCH price, prep fee, ready time, onHand (here 100,000).
//   Price patterns: identical per-cup price, identical +-1 cent, identical prep fees, random. Customer: cups = lids
//   in {10k, 25k, 50k, 75k, 100k}, maxPickups 1-5, budget none/huge; operator tax 0 or 1600 bp.
//   Reports PLANNER_LIMIT counts and the worst call time per group.
// Usage: node tr-phb3-probe.mjs <seed>.  Exit 0 = Part A agrees on every compared catalog (Part B is reported).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const { plan } = await import(pathToFileURL(join(root, 'src/domain/planner.js')));
const { referencePlan } = await import(pathToFileURL(join(root, 'test/unit/domain/helpers/reference-planner.js')));
let seed = Number(process.argv[2] || 4242);
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const T = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return new Date(Date.UTC(2026, 9, 20, h - 3, m)).toISOString(); };
const strip = (r) => { const c = structuredClone(r); if (c.trace) delete c.trace.enumerated; if (c.trace?.candidates) c.trace.candidates.forEach((x) => { delete x.cheapestCover; }); return c; };

// Part A
let compared = 0, refCap = 0, diffs = 0; const firstDiff = [];
for (let n = 0; n < 1500; n++) {
  const k = 1 + Math.floor(rnd() * 8);
  const offers = [];
  for (let j = 0; j < k; j++) {
    const size = pick([50, 100, 200]); const kind = rnd() < 0.8 ? 'both' : pick(['cups', 'lids']);
    offers.push({ supplierCode: pick(['A', 'B', 'C', 'D', 'E', 'F']), offerId: j + 1, offerVersion: 1,
      units: { cups: kind === 'lids' ? 0 : size, lids: kind === 'cups' ? 0 : size }, capacityMl: 250, cupDiameterMm: 90,
      lidDiameterMm: rnd() < 0.1 ? 95 : 90, confirmedCompatible: rnd() < 0.3, priceCents: pick([3000, 3000, 6000, 1000 + Math.floor(rnd() * 9001)]),
      prepFeeCents: pick([0, 1000, Math.floor(rnd() * 1501)]), readyAt: T(pick(['09:30', '10:00', '10:30', '11:00', '11:20'])),
      availability: Math.floor(rnd() * 21), withdrawn: rnd() < 0.05, demo: true });
  }
  const input = { requirement: { cups: 100 * (1 + Math.floor(rnd() * 20)), lids: pick([0, 100 * (1 + Math.floor(rnd() * 20))]), capacityMl: 250, diameterMm: 90, material: null },
    budgetCents: rnd() < 0.2 ? null : 3000 + Math.floor(rnd() * 200000), deadlineAt: rnd() < 0.2 ? null : T(pick(['10:00', '10:30', '11:00'])),
    maxPickups: 1 + Math.floor(rnd() * 5), taxBp: pick([0, 0, 1600]), offers };
  let ref;
  try { ref = referencePlan(structuredClone(input)); } catch (e) { if (e.code === 'PLANNER_LIMIT') { refCap++; continue; } throw e; }
  let got;
  try { got = plan(structuredClone(input)); } catch (e) { got = { error: e.code || e.message }; }
  compared++;
  const a = JSON.stringify(strip(got)); const b = JSON.stringify(strip(ref));
  if (a !== b) { diffs++; if (firstDiff.length < 3) firstDiff.push(`catalog ${n}: ${a.slice(0, 200)} vs ${b.slice(0, 200)}`); }
}
console.log(`Part A (seed ${process.argv[2] || 4242}): compared ${compared}, reference hit its cap on ${refCap} (skipped), differences ${diffs}`);
for (const d of firstDiff) console.log(`  DIFF ${d}`);

// Part B
const base = [
  { c: 'A', size: 100, lid: 90 }, { c: 'B', size: 100, lid: 90 }, { c: 'C', size: 200, lid: 95 }, { c: 'D', size: 200, lid: 90 }, { c: 'E', size: 100, lid: 90 },
];
const groups = new Map();
const rec = (g, ms, outcome) => { const s = groups.get(g) || { n: 0, limit: 0, worst: 0, worstLimitMs: 0, ms: [] }; s.n++; s.ms.push(ms); if (outcome === 'PLANNER_LIMIT') { s.limit++; s.worstLimitMs = Math.max(s.worstLimitMs, ms); } s.worst = Math.max(s.worst, ms); groups.set(g, s); };
for (const cConfirmed of [false, true]) {
  for (const pattern of ['equal-per-cup', 'equal+-1', 'equal-prep', 'random']) {
    for (const tax of [0, 1600]) {
      for (const qty of [10000, 25000, 50000, 75000, 100000]) {
        for (const maxPickups of [1, 2, 3, 4, 5]) {
          for (const budget of [null, 100000000]) {
            const offers = base.map((o, i) => ({ supplierCode: o.c, offerId: i + 1, offerVersion: 1, units: { cups: o.size, lids: o.size }, capacityMl: 250, cupDiameterMm: 90, lidDiameterMm: o.lid,
              confirmedCompatible: cConfirmed && o.c === 'C',
              priceCents: pattern === 'random' ? 1000 + Math.floor(rnd() * 9001) : (o.size / 100) * 3000 + (pattern === 'equal+-1' ? Math.floor(rnd() * 3) - 1 : 0),
              prepFeeCents: pattern === 'equal-prep' || pattern === 'equal-per-cup' ? 1000 : Math.floor(rnd() * 1501), readyAt: T('10:00'), availability: 100000, withdrawn: false, demo: true }));
            const input = { requirement: { cups: qty, lids: qty, capacityMl: 250, diameterMm: 90, material: null }, budgetCents: budget, deadlineAt: null, maxPickups, taxBp: tax, offers };
            const t = process.hrtime.bigint(); let outcome = 'ok';
            try { plan(input); } catch (e) { outcome = e.code || e.name; }
            rec(`${cConfirmed ? 'C confirmed (NOT reachable by PATCH)' : 'seeded compat (reachable)'} | ${pattern} | tax ${tax}`, Number(process.hrtime.bigint() - t) / 1e6, outcome);
          }
        }
      }
    }
  }
}
let reachableLimit = 0, reachableN = 0, reachableWorst = 0;
for (const [g, s] of groups) {
  s.ms.sort((x, y) => x - y);
  console.log(`Part B ${g}: ${s.n} calls, PLANNER_LIMIT ${s.limit}, worst ${s.worst.toFixed(1)} ms, p95 ${s.ms[Math.floor(s.ms.length * 0.95)].toFixed(1)} ms${s.limit ? `, worst refused call ${s.worstLimitMs.toFixed(1)} ms` : ''}`);
  if (g.startsWith('seeded')) { reachableLimit += s.limit; reachableN += s.n; reachableWorst = Math.max(reachableWorst, s.worst); }
}
console.log(`Part B reachable by PATCH: ${reachableN} calls, PLANNER_LIMIT ${reachableLimit}, worst ${reachableWorst.toFixed(1)} ms`);
process.exit(diffs === 0 ? 0 : 1);
