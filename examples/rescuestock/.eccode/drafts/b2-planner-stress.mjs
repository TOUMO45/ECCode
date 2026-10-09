// backend-engineer: SEC-B-1 stress. Random API-envelope planner inputs (availability up to 100000, quantities up to
// 100000, maxPickups 1-5, 5 or 12 offers, equal-price plateaus, cups/lids of different counts, several offers per
// supplier, tax) - reports the slowest plan() call and any PLANNER_LIMIT. Exit 1 on any limit or call over the bound.
// Usage: node .eccode/drafts/b2-planner-stress.mjs [count] [seed]
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const { plan } = await import(join(ROOT, 'src/domain/planner.js'));
const { makeRng } = await import(join(ROOT, 'test/unit/domain/helpers/catalog-gen.js'));
const { localTimeOnDate } = await import(join(ROOT, 'src/domain/time.js'));

const COUNT = Number(process.argv[2] || 3000);
const rng = makeRng(Number(process.argv[3] || 7));
const LETTERS = 'ABCDEFGHIJKL';
let worst = { ms: 0 }; let limits = 0; let slow = 0; const byShape = {};
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
for (let c = 0; c < COUNT; c += 1) {
  const shape = process.env.SHAPE || rng.pick(['api5', 'api5', 'wide12', 'plateau', 'multi', 'mixed']);
  const count = shape === 'api5' || shape === 'plateau5' ? 5 : shape === 'multi' ? rng.int(6, 12) : shape === 'plateau' ? rng.int(5, 12) : 12;
  const stock = rng.pick([1, 5, 30, 100, 200, 1000, 100000, 100000]);
  const equal = shape === 'plateau' || shape === 'plateau5';
  const offers = [];
  for (let i = 0; i < count; i += 1) {
    const size = rng.pick([50, 100, 200]);
    const diff = shape === 'mixed' && rng.chance(0.4);
    offers.push({
      offerId: i + 1, offerVersion: 1,
      supplierCode: shape === 'multi' ? LETTERS[rng.int(0, 4)] : LETTERS[i],
      productId: i + 1, productName: 'b', units: { cups: size, lids: diff ? rng.pick([50, 100, 200]) : size },
      capacityMl: 250, cupDiameterMm: 90, lidDiameterMm: rng.chance(0.1) ? 95 : 90, confirmedCompatible: false,
      priceCents: equal ? 3000 : rng.int(100, 10000), prepFeeCents: equal ? rng.pick([0, 1000]) : rng.int(0, 1500),
      readyAt: localTimeOnDate('2026-10-20', hhmm(570 + 10 * rng.int(0, 45))),
      availability: rng.chance(0.2) ? rng.int(0, 3) : stock, withdrawn: false, demo: true,
    });
  }
  const qty = rng.pick([100, 1000, 5000, 10000, 20000, 50000, 100000]);
  const input = {
    requirement: { cups: qty, lids: shape === 'mixed' && rng.chance(0.5) ? rng.pick([100, 1000, 20000]) : qty, capacityMl: 250, diameterMm: 90, material: null },
    budgetCents: rng.chance(0.3) ? null : rng.pick([1, 50000, 1000000, 100000000, 1000000000]),
    deadlineAt: rng.chance(0.5) ? null : localTimeOnDate('2026-10-20', '11:30'),
    maxPickups: rng.int(1, 5), taxBp: process.env.TAX ? Number(process.env.TAX) : rng.pick([0, 0, 1600]), offers, excludeSupplierCodes: [],
  };
  const t = process.hrtime.bigint();
  let outcome;
  try { outcome = plan(input).feasible ? 'feasible' : 'infeasible'; } catch (e) { outcome = e.code || e.name; if (e.code === 'PLANNER_LIMIT') limits += 1; }
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (ms > 50) {
    slow += 1; byShape[shape] = (byShape[shape] || 0) + 1;
    if (process.env.DUMP_SLOW && (shape === process.env.DUMP_SLOW || process.env.DUMP_SLOW === 'any') && ms >= Number(process.env.DUMP_MIN || 0)) {
      console.log(`SLOW ${ms.toFixed(0)} ms ${outcome}: ${JSON.stringify({ ...input, offers: input.offers.map((o) => [o.supplierCode, o.units.cups, o.units.lids, o.priceCents, o.prepFeeCents, o.availability, o.lidDiameterMm]) })}`);
    }
  }
  if (ms > worst.ms) worst = { ms, shape, count, stock, qty, maxPickups: input.maxPickups, outcome, seed: c };
}
console.log(`${COUNT} inputs: PLANNER_LIMIT ${limits}, calls over 50 ms ${slow}, worst ${worst.ms.toFixed(1)} ms ${JSON.stringify(worst)}`);
console.log(`slow calls by shape: ${JSON.stringify(byShape)}`);
process.exitCode = limits > 0 || slow > 0 ? 1 : 0;
