// RS-06..RS-11 and the planner half of RS-12, on the canonical fixture RS-FIX-1 (pinned inventory: 1 bundle per supplier).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../../../src/domain/planner.js';
import { explainPlan } from '../../../src/domain/explain.js';
import { sha256Hex } from '../../../src/domain/canonical.js';
import { formatLocalTime, localTimeOnDate } from '../../../src/domain/time.js';
import { fixtureInput, loadFixture, loadFixtureRaw, offerOf } from './helpers/fixture.js';

const codesOf = (rejections, supplier) => rejections.find((r) => r.supplierCode === supplier)?.codes;
const candidate = (result, supplier) => result.candidateCodes.find((c) => c.supplierCode === supplier);
const relaxation = (result, constraint) => result.relaxations.find((r) => r.constraint === constraint);
const supplierTotals = (body) => Object.fromEntries(body.suppliers.map((s) => [s.supplierCode, s.totalCents]));

const withoutB = (input) => { offerOf(input, 'B').availability = 0; };

test('fixture RS-FIX-1 is byte-stable and matches the brief', () => {
  assert.equal(sha256Hex(loadFixtureRaw()), '5e239dcf5b15c32cbc903f09fe930f68fb11fdb15bcb0e72cdb2322349bd9e14');
  const fx = loadFixture();
  assert.equal(fx.id, 'RS-FIX-1');
  assert.deepEqual(fx.requirement, { cups: 200, lids: 200, capacityMl: 250, diameterMm: 90, material: null });
  assert.equal(fx.budgetCents, 12000);
  assert.equal(fx.maxPickups, 2);
  assert.equal(fx.deadline, '11:00');
  assert.equal(fx.taxBp, 0);
  assert.deepEqual(fx.offers.map((o) => [o.supplierCode, o.priceCents, o.prepFeeCents, o.ready, o.onHand, o.reserved]), [
    ['A', 3000, 1000, '10:00', 1, 0],
    ['B', 3600, 800, '10:30', 1, 0],
    ['C', 4800, 500, '10:00', 1, 0],
    ['D', 6800, 1200, '11:20', 1, 0],
    ['E', 4500, 1000, '10:40', 1, 0],
  ]);
});

test('RS-06: with RS-FIX-1 and its pinned inventory the planner returns A+B, 8400 cents (A 4000 + B 4400), 2 pickups, ready 10:30', () => {
  const r = plan(fixtureInput());
  assert.equal(r.feasible, true);
  assert.deepEqual(r.best.supplierCodes, ['A', 'B']);
  assert.equal(r.best.totalCents, 8400);
  assert.deepEqual(supplierTotals(r.best), { A: 4000, B: 4400 });
  assert.equal(r.best.pickupCount, 2);
  assert.equal(formatLocalTime(r.best.readyAt), '10:30');
  assert.equal(r.best.readyAt, localTimeOnDate('2026-10-20', '10:30'));
  assert.deepEqual(r.best.surplus, { cups: 0, lids: 0 });
  assert.deepEqual(r.best.lines.map((l) => [l.supplierCode, l.bundles, l.cups, l.lids]), [['A', 1, 100, 100], ['B', 1, 100, 100]]);
  assert.deepEqual(r.alternatives.map((a) => [a.suppliers.map((s) => s.supplierCode).join('+'), a.totalCents]), [['A+E', 9500], ['B+E', 9900]]);
  assert.deepEqual(r.trace.comparisons.map((c) => [c.rank, c.decidedBy, c.best, c.alternative]), [[1, 'total', 8400, 9500], [2, 'total', 8400, 9900]]);
});

test('RS-06: multiplicity guard - with A on_hand 2 the same planner returns Ax2 at 7000 cents with 1 pickup', () => {
  const r = plan(fixtureInput((i) => { offerOf(i, 'A').availability = 2; }));
  assert.equal(r.feasible, true);
  assert.deepEqual(r.best.supplierCodes, ['A']);
  assert.deepEqual(r.best.lines.map((l) => [l.supplierCode, l.bundles]), [['A', 2]]);
  assert.equal(r.best.totalCents, 7000); // 2 x 3000 + one prep fee of 1000
  assert.equal(r.best.pickupCount, 1);
  assert.equal(formatLocalTime(r.best.readyAt), '10:00');
});

test('RS-07: supplier C is listed under rejections with INCOMPATIBLE_LID_DIAMETER (cups 90 mm, lids 95 mm, no confirmed row)', () => {
  const r = plan(fixtureInput());
  assert.deepEqual(codesOf(r.rejections, 'C'), ['INCOMPATIBLE_LID_DIAMETER']);
  const c = r.trace.candidates.find((x) => x.supplierCode === 'C');
  assert.equal(c.cupDiameterMm, 90);
  assert.equal(c.lidDiameterMm, 95);
  // a confirmed compatibility row makes C a candidate again; without it the rejection stands
  const confirmed = plan(fixtureInput((i) => { offerOf(i, 'C').confirmedCompatible = true; }));
  assert.equal(codesOf(confirmed.rejections, 'C'), undefined);
});

test('RS-08: supplier D is rejected with READY_AFTER_DEADLINE (ready 11:20 > deadline 11:00)', () => {
  const r = plan(fixtureInput());
  assert.deepEqual(codesOf(r.rejections, 'D'), ['READY_AFTER_DEADLINE']);
  const d = r.trace.candidates.find((x) => x.supplierCode === 'D');
  assert.equal(formatLocalTime(d.readyAt), '11:20');
  assert.equal(formatLocalTime(r.trace.inputs.deadlineAt), '11:00');
  // exactly at the deadline is still in time
  const onTime = plan(fixtureInput((i) => { offerOf(i, 'D').readyAt = i.deadlineAt; }));
  assert.equal(codesOf(onTime.rejections, 'D'), undefined);
});

test('RS-09: with B removed (on_hand 0, or offer withdrawn) the best plan is A+E at 9500 cents, 2 pickups, ready 10:40', () => {
  const stockout = plan(fixtureInput(withoutB));
  assert.equal(stockout.feasible, true);
  assert.deepEqual(stockout.best.supplierCodes, ['A', 'E']);
  assert.equal(stockout.best.totalCents, 9500);
  assert.deepEqual(supplierTotals(stockout.best), { A: 4000, E: 5500 });
  assert.equal(stockout.best.pickupCount, 2);
  assert.equal(formatLocalTime(stockout.best.readyAt), '10:40');
  assert.deepEqual(codesOf(stockout.rejections, 'B'), ['OUT_OF_STOCK']);

  const withdrawn = plan(fixtureInput((i) => { offerOf(i, 'B').withdrawn = true; }));
  assert.deepEqual(withdrawn.best.supplierCodes, ['A', 'E']);
  assert.equal(withdrawn.best.totalCents, 9500);
  assert.deepEqual(codesOf(withdrawn.rejections, 'B'), ['OFFER_WITHDRAWN']);

  const excluded = plan(fixtureInput((i) => { i.excludeSupplierCodes = ['B']; }));
  assert.deepEqual(excluded.best.supplierCodes, ['A', 'E']);
  assert.equal(excluded.rejections.some((x) => x.supplierCode === 'B'), false);
});

test('RS-10: B removed and budget 9000 gives no plan, blocking constraints incl. OVER_BUDGET, A and E coded INSUFFICIENT_QTY + OVER_BUDGET, exactly two relaxations', () => {
  const r = plan(fixtureInput((i) => { withoutB(i); i.budgetCents = 9000; }));
  assert.equal(r.feasible, false);
  assert.ok(r.blocking.includes('OVER_BUDGET'));
  assert.deepEqual(candidate(r, 'A').codes, ['INSUFFICIENT_QTY', 'OVER_BUDGET']);
  assert.deepEqual(candidate(r, 'E').codes, ['INSUFFICIENT_QTY', 'OVER_BUDGET']);
  assert.equal(r.relaxations.length, 2);
  const budget = relaxation(r, 'budget');
  assert.equal(budget.code, 'OVER_BUDGET');
  assert.equal(budget.neededValue, 9500);
  assert.deepEqual(budget.plan.supplierCodes, ['A', 'E']);
  assert.equal(budget.plan.totalCents, 9500);
  const deadline = relaxation(r, 'deadline');
  assert.equal(deadline.code, 'READY_AFTER_DEADLINE');
  assert.equal(formatLocalTime(deadline.neededValue), '11:20');
  assert.deepEqual(deadline.plan.supplierCodes, ['D']);
  assert.equal(deadline.plan.totalCents, 8000);
  assert.equal(deadline.plan.pickupCount, 1);
  assert.equal(relaxation(r, 'maxPickups'), undefined, 'raising max pickups yields no plan, so no suggestion is emitted');
  assert.deepEqual(r.blocking, ['OVER_BUDGET', 'READY_AFTER_DEADLINE']);
  // no plan, no alternatives, no best
  assert.equal('best' in r, false);
});

test('RS-11: with max pickups 1 the scenario is infeasible; A, B and E carry exactly INSUFFICIENT_QTY + TOO_MANY_PICKUPS; C and D keep their RS-07/RS-08 codes', () => {
  const r = plan(fixtureInput((i) => { i.maxPickups = 1; }));
  assert.equal(r.feasible, false);
  for (const s of ['A', 'B', 'E']) assert.deepEqual(candidate(r, s).codes, ['INSUFFICIENT_QTY', 'TOO_MANY_PICKUPS'], s);
  assert.equal(candidate(r, 'C'), undefined);
  assert.equal(candidate(r, 'D'), undefined);
  assert.deepEqual(codesOf(r.rejections, 'C'), ['INCOMPATIBLE_LID_DIAMETER']);
  assert.deepEqual(codesOf(r.rejections, 'D'), ['READY_AFTER_DEADLINE']);
  // each alone supplies 100 of 200
  for (const s of ['A', 'B', 'E']) {
    const c = r.trace.candidates.find((x) => x.supplierCode === s);
    assert.equal(c.suppliesCups, 100);
    assert.equal(c.suppliesLids, 100);
  }
  const pickups = relaxation(r, 'maxPickups');
  assert.equal(pickups.code, 'TOO_MANY_PICKUPS');
  assert.equal(pickups.neededValue, 2);
  assert.deepEqual(pickups.plan.supplierCodes, ['A', 'B']);
  assert.equal(pickups.plan.totalCents, 8400);
  assert.deepEqual(relaxation(r, 'deadline').plan.supplierCodes, ['D']);
  assert.equal(relaxation(r, 'budget'), undefined);
});

test('RS-12: planner half - cups or lids below the requirement are never feasible', () => {
  // every bundle holds 100 cups but only 50 lids: two bundles make 200 cups and 100 lids, so lids fall short
  const fewLids = plan(fixtureInput((i) => {
    for (const o of i.offers) if (o.units.cups === 100) o.units = { cups: 100, lids: 50 };
  }));
  assert.equal(fewLids.feasible, false);
  assert.ok(fewLids.blocking.length > 0);
  // every bundle holds 50 cups and 100 lids: lids are plentiful, cups short
  const fewCups = plan(fixtureInput((i) => {
    for (const o of i.offers) if (o.units.cups === 100) o.units = { cups: 50, lids: 100 };
  }));
  assert.equal(fewCups.feasible, false);
  // when feasible, the plan covers both quantities, with the surplus reported
  const ok = plan(fixtureInput());
  assert.ok(ok.best.lines.reduce((n, l) => n + l.cups, 0) >= 200);
  assert.ok(ok.best.lines.reduce((n, l) => n + l.lids, 0) >= 200);
  // total stock below the requirement: nothing is feasible however the constraints are relaxed
  const short = plan(fixtureInput((i) => { i.requirement.cups = 1000; i.requirement.lids = 1000; }));
  assert.equal(short.feasible, false);
  assert.deepEqual(short.relaxations, []);
  assert.deepEqual(short.blocking, ['INSUFFICIENT_QTY']);
});

test('planner is deterministic: equal inputs give deep-equal outputs, input order does not matter, inputs are not mutated', () => {
  const input = fixtureInput();
  const frozen = structuredClone(input);
  const a = plan(input);
  const b = plan(structuredClone(input));
  assert.deepEqual(a, b);
  assert.deepEqual(input, frozen);
  const shuffled = fixtureInput((i) => { i.offers.reverse(); });
  assert.deepEqual(plan(shuffled), a);
  const infeasible = (i) => { withoutB(i); i.budgetCents = 9000; };
  assert.deepEqual(plan(fixtureInput((i) => { infeasible(i); i.offers.reverse(); })), plan(fixtureInput(infeasible)));
});

test('planner rounds tax half up per supplier order', () => {
  const r = plan(fixtureInput((i) => { i.taxBp = 825; i.budgetCents = null; }));
  assert.equal(r.feasible, true);
  // A: 4000 -> tax 330 (4000 x 0.0825), B: 4400 -> tax 363
  assert.deepEqual(r.best.suppliers.map((s) => [s.supplierCode, s.subtotalCents, s.prepFeeCents, s.taxCents, s.totalCents]), [
    ['A', 3000, 1000, 330, 4330],
    ['B', 3600, 800, 363, 4763],
  ]);
  assert.equal(r.best.totalCents, 9093);
  // half-up: 0.5 cents rounds to 1 (base 50 x 100 bp = 0.5)
  const half = plan(fixtureInput((i) => {
    i.taxBp = 100;
    i.budgetCents = null;
    i.offers = [{ ...offerOf(i, 'A'), units: { cups: 200, lids: 200 }, priceCents: 30, prepFeeCents: 20, availability: 1 }];
  }));
  assert.equal(half.best.suppliers[0].taxCents, 1); // (30 + 20) x 1 % = 0.5 -> 1
});

test('planner explanation renders the RS-06..RS-11 results from codes and trace', () => {
  const base = explainPlan(plan(fixtureInput()));
  assert.match(base.lines[0].text, /^Best plan: A\+B for \$84\.00 in total, 2 pickups, ready by 10:30\.$/);
  assert.ok(base.lines.some((l) => l.code === 'INCOMPATIBLE_LID_DIAMETER' && /Supplier C/.test(l.text) && /90 mm/.test(l.text) && /95 mm/.test(l.text)));
  assert.ok(base.lines.some((l) => l.code === 'READY_AFTER_DEADLINE' && /11:20/.test(l.text) && /11:00/.test(l.text)));
  const rs10 = explainPlan(plan(fixtureInput((i) => { withoutB(i); i.budgetCents = 9000; })));
  assert.ok(rs10.lines.some((l) => /Raise the budget to \$95\.00 to get A\+E/.test(l.text)));
  assert.ok(rs10.lines.some((l) => /Move the deadline to 11:20 to get D for \$80\.00/.test(l.text)));
});

test('planner refuses an absurd search instead of running unbounded (PlannerLimitError) and rejects malformed input', () => {
  const absurd = fixtureInput((i) => {
    i.requirement.cups = 100000;
    i.requirement.lids = 100000;
    i.budgetCents = null;
    i.maxPickups = 5;
    i.offers = Array.from({ length: 12 }, (_, k) => ({
      ...offerOf(i, 'A'), offerId: k + 1, supplierCode: String.fromCharCode(65 + k), units: { cups: 1, lids: 1 },
      priceCents: 100 + k, availability: 100000,
    }));
  });
  const started = Date.now();
  assert.throws(() => plan(absurd), (e) => e instanceof RangeError && e.code === 'PLANNER_LIMIT');
  assert.ok(Date.now() - started < 10000);
  assert.throws(() => plan(null), RangeError);
  assert.throws(() => plan({ ...fixtureInput(), maxPickups: 0 }), RangeError);
  assert.throws(() => plan({ ...fixtureInput(), budgetCents: -5 }), RangeError);
  assert.throws(() => plan({ ...fixtureInput(), deadlineAt: 'soon' }), RangeError);
  assert.throws(() => plan(fixtureInput((i) => { i.offers[1].offerId = i.offers[0].offerId; })), RangeError);
  assert.throws(() => plan(fixtureInput((i) => { i.offers[0].priceCents = 10.5; })), RangeError);
  assert.throws(() => plan(fixtureInput((i) => { i.requirement.cups = 0; i.requirement.lids = 0; })), RangeError);
});
