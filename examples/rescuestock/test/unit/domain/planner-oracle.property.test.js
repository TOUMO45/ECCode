// Property test: the exact planner (branch-and-bound) against the brute-force oracle on 500 seeded random catalogs
// of at most 6 offers with on_hand 0-3, so multiplicities above 1 are exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../../../src/domain/planner.js';
import { oracle } from '../../../src/domain/oracle.js';
import { mediumCatalog, smallCatalog } from './helpers/catalog-gen.js';
import { referencePlan } from './helpers/reference-planner.js';
import { fixtureInput, offerOf } from './helpers/fixture.js';

const CATALOGS = 500;

function bundlesOf(best) {
  const out = {};
  for (const l of best.lines) out[l.offerId] = (out[l.offerId] ?? 0) + l.bundles;
  return out;
}

function compare(seed, input) {
  const p = plan(input);
  const o = oracle(input);
  const at = `seed ${seed}`;
  assert.equal(p.feasible, o.feasible, `${at}: feasibility`);
  assert.deepEqual(p.rejections, o.rejections, `${at}: rejections`);
  if (p.feasible) {
    assert.equal(p.best.totalCents, o.best.totalCents, `${at}: total`);
    assert.equal(p.best.pickupCount, o.best.pickupCount, `${at}: pickups`);
    assert.equal(p.best.readyAt, o.best.readyAt, `${at}: readyAt`);
    assert.deepEqual(p.best.supplierCodes, o.best.supplierCodes, `${at}: supplier codes`);
    assert.deepEqual(bundlesOf(p.best), o.best.bundles, `${at}: bundles`);
    // ranked alternatives (irredundant plans, next best first)
    assert.deepEqual(
      p.alternatives.map((a) => [a.totalCents, a.pickupCount, a.readyAt, a.suppliers.map((s) => s.supplierCode)]),
      o.alternatives.map((a) => [a.totalCents, a.pickupCount, a.readyAt, a.supplierCodes]),
      `${at}: alternatives`,
    );
    // RS-12 (planner half): a feasible plan always covers both quantities, within stock and constraints
    const cups = p.best.lines.reduce((n, l) => n + l.cups, 0);
    const lids = p.best.lines.reduce((n, l) => n + l.lids, 0);
    assert.ok(cups >= input.requirement.cups && lids >= input.requirement.lids, `${at}: coverage`);
    assert.ok(p.best.pickupCount <= input.maxPickups, `${at}: pickups bound`);
    if (input.budgetCents !== null) assert.ok(p.best.totalCents <= input.budgetCents, `${at}: budget`);
    if (input.deadlineAt !== null) assert.ok(p.best.readyAt <= input.deadlineAt, `${at}: deadline`);
    for (const l of p.best.lines) assert.ok(l.bundles <= input.offers.find((x) => x.offerId === l.offerId).availability, `${at}: stock`);
  } else {
    assert.deepEqual(p.candidateCodes, o.candidateCodes, `${at}: per-candidate codes`);
    assert.deepEqual(p.relaxations, o.relaxations, `${at}: relaxations`);
    assert.deepEqual(p.blocking, o.blocking, `${at}: blocking`);
  }
  return p.feasible;
}

test('RS-06: planner equals the brute-force oracle on 500 seeded random catalogs (<= 6 offers, on_hand 0-3): feasibility, total, pickups, readyAt, per-candidate codes', () => {
  let feasible = 0;
  let multiples = 0;
  for (let seed = 1; seed <= CATALOGS; seed += 1) {
    const input = smallCatalog(seed);
    assert.ok(input.offers.length <= 6);
    assert.ok(input.offers.every((o) => o.availability >= 0 && o.availability <= 3));
    if (compare(seed, input)) {
      feasible += 1;
      if (plan(input).best.lines.some((l) => l.bundles > 1)) multiples += 1;
    }
  }
  // the generator must exercise both outcomes and bundle multiplicities above 1
  assert.ok(feasible >= 100, `feasible catalogs: ${feasible}`);
  assert.ok(CATALOGS - feasible >= 100, `infeasible catalogs: ${CATALOGS - feasible}`);
  assert.ok(multiples >= 10, `plans with a multiplicity above 1: ${multiples}`);
});

test('RS-06: oracle agrees with the pinned outcomes of RS-FIX-1 (base, multiplicity guard, without B, budget 9000, max pickups 1)', () => {
  const base = oracle(fixtureInput());
  assert.deepEqual([base.best.supplierCodes, base.best.totalCents, base.best.pickupCount], [['A', 'B'], 8400, 2]);
  const a2 = oracle(fixtureInput((i) => { offerOf(i, 'A').availability = 2; }));
  assert.deepEqual([a2.best.supplierCodes, a2.best.bundles, a2.best.totalCents], [['A'], { 1: 2 }, 7000]);
  const noB = oracle(fixtureInput((i) => { offerOf(i, 'B').availability = 0; }));
  assert.deepEqual([noB.best.supplierCodes, noB.best.totalCents], [['A', 'E'], 9500]);
  const tight = oracle(fixtureInput((i) => { offerOf(i, 'B').availability = 0; i.budgetCents = 9000; }));
  assert.equal(tight.feasible, false);
  assert.deepEqual(tight.relaxations.map((r) => [r.constraint, r.plan.supplierCodes.join('+'), r.plan.totalCents]), [['budget', 'A+E', 9500], ['deadline', 'D', 8000]]);
  assert.equal(oracle(fixtureInput((i) => { i.maxPickups = 1; })).feasible, false);
});

test('RS-06: the oracle itself is independent of the planner (spot check against hand-computed totals)', () => {
  // two offers of one supplier form one supplier order: one pickup, one prep fee (the larger), one tax rounding
  const input = fixtureInput((i) => {
    i.taxBp = 1600;
    i.budgetCents = null;
    i.offers = [
      { ...offerOf(i, 'A'), offerId: 1, units: { cups: 100, lids: 100 }, priceCents: 3000, prepFeeCents: 1000, availability: 1 },
      { ...offerOf(i, 'A'), offerId: 2, units: { cups: 100, lids: 100 }, priceCents: 3100, prepFeeCents: 500, availability: 1 },
    ];
  });
  const o = oracle(input);
  assert.equal(o.best.pickupCount, 1);
  assert.equal(o.best.totalCents, 3000 + 3100 + 1000 + Math.floor((7100 * 1600 + 5000) / 10000)); // 7100 + 1136
  assert.equal(plan(input).best.totalCents, o.best.totalCents);
});

// ---------------------------------------------------------------- SEC-B-1: larger stock, quantities and ties

test('SEC-B-1: planner equals the brute-force oracle on larger stock (availability up to 7, <= 4 offers, quantities up to 1600)', () => {
  let feasible = 0;
  for (let seed = 1; seed <= 100; seed += 1) {
    if (compare(`medium ${seed}`, mediumCatalog(seed, { maxOffers: 4, maxAvail: 7, maxQuantitySteps: 16 }))) feasible += 1;
  }
  assert.ok(feasible >= 20 && feasible <= 90, `feasible catalogs: ${feasible}`);
});

test('SEC-B-1: planner equals the brute-force oracle on tie-heavy catalogs (equal prices, prep fees and ready times; availability up to 5)', () => {
  let feasible = 0;
  for (let seed = 1; seed <= 120; seed += 1) {
    if (compare(`ties ${seed}`, mediumCatalog(seed, { maxOffers: 5, maxAvail: 5, maxQuantitySteps: 8, ties: true }))) feasible += 1;
  }
  assert.ok(feasible >= 20 && feasible <= 110, `feasible catalogs: ${feasible}`);
});

test('SEC-B-1: planner equals the slow exact reference planner on 250 medium catalogs (availability up to 12, <= 6 offers, quantities up to 3000), full output', () => {
  const strip = (r) => {
    const copy = structuredClone(r);
    delete copy.trace.enumerated;
    return copy;
  };
  let compared = 0;
  let skipped = 0;
  for (let seed = 1; seed <= 250; seed += 1) {
    const input = mediumCatalog(seed, { maxOffers: 6, maxAvail: 12, maxQuantitySteps: 30, ties: seed % 3 === 0 });
    let reference;
    try {
      reference = referencePlan(input);
    } catch (e) {
      if (e.code !== 'PLANNER_LIMIT') throw e;
      skipped += 1; // the slow reference gave up (its search is exponential in stock); nothing to compare
      continue;
    }
    assert.deepEqual(strip(plan(input)), strip(reference), `medium catalog ${seed}`);
    compared += 1;
  }
  assert.ok(compared >= 200, `compared ${compared}, reference gave up on ${skipped}`);
});
