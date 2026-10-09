// SEC-B-1: plan() must stay exact AND fast when suppliers hold large stock and customers ask for large quantities.
// Before the fix the search enumerated every multiplicity vector (exponential in stock) and gave up with
// PLANNER_LIMIT after about 170 ms on, for example, 100 bundles per supplier and 10,000 cups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { plan } from '../../src/domain/planner.js';
import { localTimeOnDate } from '../../src/domain/time.js';
import { DAY, makeRng } from '../unit/domain/helpers/catalog-gen.js';
import { fixtureInput } from '../unit/domain/helpers/fixture.js';

function timed(input) {
  const start = performance.now();
  let result;
  let error = null;
  try {
    result = plan(input);
  } catch (e) {
    error = e;
  }
  return { result, error, ms: performance.now() - start };
}

// the JIT is cold on the first calls; warm it with the fixture so the thresholds below measure steady state
for (let i = 0; i < 20; i += 1) plan(fixtureInput());

const seeded = (stock, qty, maxPickups, budget, compat, deadline) => fixtureInput((i) => {
  i.requirement.cups = qty;
  i.requirement.lids = qty;
  i.maxPickups = maxPickups;
  i.budgetCents = budget;
  if (!deadline) i.deadlineAt = null;
  for (const o of i.offers) {
    o.availability = stock;
    o.confirmedCompatible = compat;
  }
});

test('SEC-B-1: stock 100, 10,000 cups → A, under 50 ms', () => {
  // each of the five suppliers holds 100 bundles; A, B or E alone covers 10,000 cups + 10,000 lids; budget USD 100,000
  const input = seeded(100, 10000, 5, 10000000, false, false);
  const { result, error, ms } = timed(input);
  assert.equal(error, null);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.best.supplierCodes, ['A']);
  assert.deepEqual(result.best.lines.map((l) => [l.supplierCode, l.bundles, l.cups]), [['A', 100, 10000]]);
  assert.equal(result.best.totalCents, 100 * 3000 + 1000);
  assert.equal(result.best.pickupCount, 1);
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
  // the same request with maxPickups 1 gives the same plan
  const one = plan(seeded(100, 10000, 1, 10000000, false, false));
  assert.deepEqual(one.best, result.best);
  // ranked alternatives exist and are real plans
  assert.ok(result.alternatives.length >= 1);
  for (const alt of result.alternatives) assert.ok(alt.totalCents >= result.best.totalCents);
});

test('SEC-B-1: the seeded catalog shape never reaches PLANNER_LIMIT and stays fast for stock 1 to 100,000 and quantity 100 to 100,000', () => {
  let calls = 0;
  const times = [];
  for (const stock of [1, 10, 30, 100, 200, 1000, 100000]) {
    for (const qty of [100, 1000, 5000, 10000, 50000, 100000]) {
      for (const maxPickups of [1, 3, 5]) {
        for (const budget of [null, 1, 1000000, 100000000]) {
          for (const compat of [false, true]) {
            const { error, ms } = timed(seeded(stock, qty, maxPickups, budget, compat, calls % 2 === 0));
            calls += 1;
            assert.equal(error, null, `stock ${stock}, qty ${qty}, maxPickups ${maxPickups}, budget ${budget}, compat ${compat}: ${error?.message}`);
            times.push(ms);
            assert.ok(ms < 100, `stock ${stock}, qty ${qty}, maxPickups ${maxPickups}, budget ${budget}, compat ${compat} took ${ms.toFixed(1)} ms`);
          }
        }
      }
    }
  }
  times.sort((a, b) => a - b);
  assert.equal(calls, 7 * 6 * 3 * 4 * 2);
  assert.ok(times[Math.floor(times.length * 0.95)] < 20, `p95 ${times[Math.floor(times.length * 0.95)].toFixed(1)} ms`);
});

test('SEC-B-1: 12 random-priced offers with stock up to 100,000 and quantities up to 100,000 never reach PLANNER_LIMIT and take under 250 ms each', () => {
  const rng = makeRng(20261009);
  let feasible = 0;
  let worst = 0;
  for (let c = 0; c < 150; c += 1) {
    const offers = Array.from({ length: 12 }, (_, i) => {
      const size = rng.pick([50, 100, 200]);
      return {
        offerId: i + 1, offerVersion: 1, supplierCode: 'ABCDEFGHIJKL'[i], productId: i + 1, productName: 'bundle', units: { cups: size, lids: size },
        capacityMl: 250, cupDiameterMm: 90, lidDiameterMm: 90, confirmedCompatible: false,
        priceCents: rng.int(100, 10000), prepFeeCents: rng.int(0, 1500), readyAt: localTimeOnDate(DAY, '10:30'),
        availability: rng.pick([0, 1, 30, 200, 100000]), withdrawn: false, demo: true,
      };
    });
    const qty = rng.pick([100, 5000, 20000, 50000, 100000]);
    const input = {
      requirement: { cups: qty, lids: qty, capacityMl: 250, diameterMm: 90, material: null },
      budgetCents: rng.pick([null, 1, 500000, 100000000]),
      deadlineAt: null,
      maxPickups: rng.int(1, 5),
      taxBp: rng.pick([0, 1600]),
      offers,
      excludeSupplierCodes: [],
    };
    const { result, error, ms } = timed(input);
    assert.equal(error, null, `catalog ${c}: ${error?.message}`);
    if (result.feasible) feasible += 1;
    worst = Math.max(worst, ms);
    assert.ok(ms < 250, `catalog ${c} took ${ms.toFixed(1)} ms`);
  }
  assert.ok(feasible > 20 && feasible < 150, `${feasible} feasible`);
  console.log(`# SEC-B-1 12-offer catalogs: worst ${worst.toFixed(1)} ms, ${feasible}/150 feasible`);
});
