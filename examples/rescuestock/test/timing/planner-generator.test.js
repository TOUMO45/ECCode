// NFR5 (planner part): the planner solves RS-FIX-1 and each of the 200 seeded generator catalogs (seeds 1-200;
// 12 offers; bundle sizes {50,100,200}; required quantity 100-400 in steps of 100; on_hand 0-2; price 1000-10000
// cents; prep fee 0-1500 cents; ready 09:30-12:00; 15 % incompatible; max pickups 1-3) in under one second each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { plan } from '../../src/domain/planner.js';
import { nfr5Catalog } from '../unit/domain/helpers/catalog-gen.js';
import { fixtureInput, offerOf } from '../unit/domain/helpers/fixture.js';

const LIMIT_MS = 1000;

function timed(input) {
  const start = performance.now();
  const result = plan(input);
  return { result, ms: performance.now() - start };
}

test('NFR5: the planner solves RS-FIX-1 (base and each pinned variant) in under 1 s', () => {
  const variants = {
    base: fixtureInput(),
    'A on_hand 2': fixtureInput((i) => { offerOf(i, 'A').availability = 2; }),
    'without B': fixtureInput((i) => { offerOf(i, 'B').availability = 0; }),
    'without B, budget 9000 (infeasible, relaxations)': fixtureInput((i) => { offerOf(i, 'B').availability = 0; i.budgetCents = 9000; }),
    'max pickups 1 (infeasible, relaxations)': fixtureInput((i) => { i.maxPickups = 1; }),
  };
  for (const [name, input] of Object.entries(variants)) {
    const { ms } = timed(input);
    assert.ok(ms < LIMIT_MS, `${name} took ${ms.toFixed(1)} ms`);
  }
});

test('NFR5: generator seeds 1-200 (12 offers each) are solved in under 1 s each', () => {
  let feasible = 0;
  let slowest = { seed: 0, ms: 0 };
  for (let seed = 1; seed <= 200; seed += 1) {
    const input = nfr5Catalog(seed);
    assert.equal(input.offers.length, 12);
    assert.ok(input.maxPickups >= 1 && input.maxPickups <= 3);
    assert.ok(input.offers.every((o) => o.availability >= 0 && o.availability <= 2));
    const { result, ms } = timed(input);
    if (result.feasible) feasible += 1;
    if (ms > slowest.ms) slowest = { seed, ms };
    assert.ok(ms < LIMIT_MS, `seed ${seed} took ${ms.toFixed(1)} ms`);
  }
  assert.ok(feasible > 20 && feasible < 200, `generator should produce feasible and infeasible catalogs, got ${feasible} feasible`);
  console.log(`# NFR5 planner timing: slowest seed ${slowest.seed} took ${slowest.ms.toFixed(2)} ms; ${feasible}/200 feasible`);
});

test('NFR5: generator catalogs are deterministic per seed', () => {
  assert.deepEqual(nfr5Catalog(17), nfr5Catalog(17));
  assert.notDeepEqual(nfr5Catalog(17), nfr5Catalog(18));
  assert.deepEqual(plan(nfr5Catalog(17)), plan(nfr5Catalog(17)));
});
