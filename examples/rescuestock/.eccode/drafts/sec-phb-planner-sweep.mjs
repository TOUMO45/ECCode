// Security probe, phase B: which API-shaped planner inputs reach PLANNER_LIMIT, and how long plan() holds the
// event loop (security-reviewer). Catalog = the seeded RS-FIX-1 shape (5 bundles of 100 or 200 cups+lids, one per
// supplier; no route creates offers). Supplier-controlled: availability (PATCH onHand >= 0), price, prep fee, ready time.
// Customer-controlled: quantities 1-100000, maxPickups 1-5, budget, deadline.
// Exit 1 (reproduction) when a request that one supplier alone can satisfy is refused with PLANNER_LIMIT.
// Usage: node --disable-warning=ExperimentalWarning .eccode/drafts/sec-phb-planner-sweep.mjs
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const { plan } = await import(join(ROOT, 'src/domain/planner.js'));
const { fixtureInput } = await import(join(ROOT, 'test/unit/domain/helpers/fixture.js'));

const run = (input) => {
  const t = process.hrtime.bigint();
  let outcome;
  try { const r = plan(input); outcome = r.feasible ? `feasible (${r.best.supplierCodes.join('+')}, ${r.best.totalCents} cents)` : 'infeasible'; } catch (e) { outcome = e.code || e.name; }
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, outcome };
};

let worst = { ms: 0 };
let firstLimit = null;
for (const avail of [1, 10, 20, 30, 50, 100, 200, 500, 1000, 100000]) {
  let maxMs = 0; let runs = 0; let maxDesc = '';
  const limits = { compatTrue: 0, compatFalse: 0 };
  for (const qty of [100, 1000, 2000, 3000, 5000, 10000, 20000, 50000, 100000]) {
    for (const maxPickups of [1, 3, 5]) {
      for (const budget of [null, 1, 50000, 1000000, 10000000]) {
        for (const allCompatible of [false, true]) {
          for (const deadline of [true, false]) {
            const input = fixtureInput((i) => {
              i.requirement.cups = qty; i.requirement.lids = qty; i.maxPickups = maxPickups; i.budgetCents = budget;
              if (!deadline) i.deadlineAt = null;
              for (const o of i.offers) { o.availability = avail; o.confirmedCompatible = allCompatible; }
            });
            const r = run(input);
            runs += 1;
            if (r.outcome === 'PLANNER_LIMIT') {
              limits[allCompatible ? 'compatTrue' : 'compatFalse'] += 1;
              if (!firstLimit || avail < firstLimit.avail || (avail === firstLimit.avail && qty < firstLimit.qty)) firstLimit = { avail, qty, maxPickups, budget, allCompatible, deadline, ms: Number(r.ms.toFixed(1)) };
            }
            const desc = `qty=${qty} maxPickups=${maxPickups} budget=${budget} compat=${allCompatible} deadline=${deadline} -> ${r.outcome}`;
            if (r.ms > maxMs) { maxMs = r.ms; maxDesc = desc; }
            if (r.ms > worst.ms) worst = { ms: r.ms, avail, desc };
          }
        }
      }
    }
  }
  console.log(`availability ${String(avail).padStart(6)} per supplier: ${runs} runs, PLANNER_LIMIT ${limits.compatTrue + limits.compatFalse} (C compatible: ${limits.compatTrue}; default, C rejected: ${limits.compatFalse}), max ${maxMs.toFixed(1)} ms (${maxDesc})`);
}
console.log(`smallest availability (then quantity) that reached PLANNER_LIMIT: ${firstLimit ? JSON.stringify(firstLimit) : 'none'}`);
console.log(`worst single plan() call: ${worst.ms.toFixed(1)} ms at availability ${worst.avail} (${worst.desc})`);

// The concrete reproduction: default compatibility (C rejected), 100 bundles in stock at each supplier, so A, B or E
// alone covers 10000 cups + 10000 lids; budget USD 100,000 (inside the 1-1,000,000 USD range), no deadline, maxPickups 5.
const mk = (maxPickups) => fixtureInput((i) => {
  i.requirement.cups = 10000; i.requirement.lids = 10000; i.maxPickups = maxPickups; i.budgetCents = 10000000; i.deadlineAt = null;
  for (const o of i.offers) o.availability = 100;
});
const r = run(mk(5));
console.log(`reproduction: 10000 cups + 10000 lids, 100 bundles at each supplier (A alone covers it), budget 10000000 cents, no deadline, maxPickups 5 -> ${r.outcome} after ${r.ms.toFixed(1)} ms`);
const r1 = run(mk(1));
console.log(`control: the same request with maxPickups 1 -> ${r1.outcome} after ${r1.ms.toFixed(1)} ms`);
process.exitCode = r.outcome === 'PLANNER_LIMIT' ? 1 : 0;
