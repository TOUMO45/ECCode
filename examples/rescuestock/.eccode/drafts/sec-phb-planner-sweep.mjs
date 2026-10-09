// Security probe, phase B: which API-shaped planner inputs reach PLANNER_LIMIT, and how long plan() holds the
// event loop (security-reviewer). Catalog = the seeded RS-FIX-1 shape (5 bundles of 100 or 200 cups+lids, one per
// supplier; no route creates offers). Supplier-controlled: availability (PATCH onHand >= 0), price, prep fee, ready time.
// Customer-controlled: quantities 1-100000, maxPickups 1-5, budget, deadline.
// Usage: node --disable-warning=ExperimentalWarning .eccode/drafts/sec-phb-planner-sweep.mjs
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[1], '../../..');
const { plan } = await import(join(ROOT, 'src/domain/planner.js'));
const { fixtureInput } = await import(join(ROOT, 'test/unit/domain/helpers/fixture.js'));

const run = (input) => {
  const t = process.hrtime.bigint();
  let outcome;
  try { const r = plan(input); outcome = r.feasible ? 'feasible' : 'infeasible'; } catch (e) { outcome = e.code || e.name; }
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, outcome };
};

let worst = { ms: 0 };
let firstLimit = null;
for (const avail of [1, 10, 50, 100, 200, 500, 1000, 100000]) {
  let maxMs = 0; let limits = 0; let runs = 0; let maxDesc = '';
  for (const qty of [100, 1000, 5000, 10000, 20000, 50000, 100000]) {
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
            if (r.outcome === 'PLANNER_LIMIT') { limits += 1; if (!firstLimit || avail < firstLimit.avail) firstLimit = { avail, qty, maxPickups, budget, allCompatible, deadline, ms: r.ms }; }
            if (r.ms > maxMs) { maxMs = r.ms; maxDesc = `qty=${qty} maxPickups=${maxPickups} budget=${budget} compat=${allCompatible} deadline=${deadline} -> ${r.outcome}`; }
            if (r.ms > worst.ms) worst = { ms: r.ms, avail, desc: maxDesc };
          }
        }
      }
    }
  }
  console.log(`availability ${String(avail).padStart(6)} per supplier: ${runs} runs, PLANNER_LIMIT ${limits}, max ${maxMs.toFixed(1)} ms (${maxDesc})`);
}
console.log(`smallest availability that reached PLANNER_LIMIT: ${firstLimit ? JSON.stringify(firstLimit) : 'none'}`);
console.log(`worst single plan() call: ${worst.ms.toFixed(1)} ms at availability ${worst.avail} (${worst.desc})`);
