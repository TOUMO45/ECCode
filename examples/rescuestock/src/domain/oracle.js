// Brute-force reference planner (tests only import it). It shares NO search code with planner.js: it enumerates
// EVERY multiplicity vector 0..availability for every candidate with plain nested counters, no pruning, no
// multiplicity bound other than the stock itself, and judges each vector against the brief's feasibility rules
// from scratch. The only shared pieces are the leaf arithmetic helpers: money.js (tax rounding), time.js (parsing)
// and compat.js (the compatibility predicate).
//
// oracle(input) takes the same input as planner.plan and returns a plain comparison record:
//   { feasible, best, alternatives, rejections, candidateCodes, relaxations, blocking }
// where best/alternatives are { supplierCodes, bundles: {offerId: n}, totalCents, pickupCount, readyAt, ... }.

import { supplierOrderTotals } from './money.js';
import { normalizeTs, parseTs } from './time.js';
import { areCompatible, matchesRequirement } from './compat.js';

function candidatesOf(input, deadlineMs) {
  const rejections = [];
  const live = [];
  const excluded = new Set(input.excludeSupplierCodes ?? []);
  const sorted = [...input.offers].sort((a, b) => (a.supplierCode === b.supplierCode ? a.offerId - b.offerId : a.supplierCode < b.supplierCode ? -1 : 1));
  for (const o of sorted) {
    if (excluded.has(o.supplierCode)) continue;
    if (!matchesRequirement(o, input.requirement)) continue;
    const codes = [];
    if (o.withdrawn === true) {
      codes.push('OFFER_WITHDRAWN');
    } else {
      if (!areCompatible(o)) codes.push('INCOMPATIBLE_LID_DIAMETER');
      if (deadlineMs !== null && parseTs(o.readyAt) > deadlineMs) codes.push('READY_AFTER_DEADLINE');
      if (o.availability === 0) codes.push('OUT_OF_STOCK');
    }
    if (codes.length > 0) rejections.push({ supplierCode: o.supplierCode, offerId: o.offerId, codes });
    else live.push({ ...o, readyMs: parseTs(o.readyAt) });
  }
  return { live, rejections };
}

// Cost of a vector, built independently of the planner's incremental bookkeeping.
function evaluate(live, counts, input) {
  const perSupplier = new Map();
  let cups = 0;
  let lids = 0;
  let readyMs = 0;
  for (let i = 0; i < live.length; i += 1) {
    const n = counts[i];
    if (n === 0) continue;
    const o = live[i];
    cups += n * o.units.cups;
    lids += n * o.units.lids;
    readyMs = Math.max(readyMs, o.readyMs);
    const cur = perSupplier.get(o.supplierCode) ?? { subtotalCents: 0, prepFeeCents: 0 };
    cur.subtotalCents += n * o.priceCents;
    cur.prepFeeCents = Math.max(cur.prepFeeCents, o.prepFeeCents);
    perSupplier.set(o.supplierCode, cur);
  }
  let totalCents = 0;
  for (const s of perSupplier.values()) totalCents += supplierOrderTotals({ ...s, taxBp: input.taxBp ?? 0 }).totalCents;
  const supplierCodes = [...perSupplier.keys()].sort();
  return { cups, lids, readyMs, totalCents, supplierCodes, pickupCount: supplierCodes.length, counts: counts.slice() };
}

function cmpVec(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function better(a, b) {
  if (a.totalCents !== b.totalCents) return a.totalCents - b.totalCents;
  if (a.pickupCount !== b.pickupCount) return a.pickupCount - b.pickupCount;
  if (a.readyMs !== b.readyMs) return a.readyMs - b.readyMs;
  const sa = a.supplierCodes.join(',');
  const sb = b.supplierCodes.join(',');
  if (sa !== sb) return sa < sb ? -1 : 1;
  return cmpVec(a.counts, b.counts);
}

// Every vector, odometer style. Calls visit(counts) for each.
function forEachVector(live, visit) {
  const counts = live.map(() => 0);
  for (;;) {
    visit(counts);
    let i = 0;
    while (i < live.length) {
      if (counts[i] < live[i].availability) {
        counts[i] += 1;
        break;
      }
      counts[i] = 0;
      i += 1;
    }
    if (i === live.length) return;
  }
}

function solve(input, { budget, maxPickups, deadlineMs, forceIndex = -1, wantAll = false }) {
  const { live, rejections } = candidatesOf(input, deadlineMs);
  const feasible = [];
  forEachVector(live, (counts) => {
    if (forceIndex >= 0 && counts[forceIndex] === 0) return;
    const e = evaluate(live, counts, input);
    if (e.cups < input.requirement.cups || e.lids < input.requirement.lids) return;
    if (e.pickupCount > maxPickups) return;
    if (budget !== null && e.totalCents > budget) return;
    feasible.push(e);
  });
  feasible.sort(better);
  return { live, rejections, feasible: wantAll ? feasible : feasible.slice(0, 1) };
}

function irredundant(e, live, input) {
  for (let i = 0; i < live.length; i += 1) {
    if (e.counts[i] === 0) continue;
    if (e.cups - live[i].units.cups >= input.requirement.cups && e.lids - live[i].units.lids >= input.requirement.lids) return false;
  }
  return true;
}

function describe(e, live) {
  const bundles = {};
  for (let i = 0; i < live.length; i += 1) if (e.counts[i] > 0) bundles[live[i].offerId] = e.counts[i];
  return {
    supplierCodes: e.supplierCodes,
    bundles,
    totalCents: e.totalCents,
    pickupCount: e.pickupCount,
    readyAt: new Date(e.readyMs).toISOString(),
  };
}

export function oracle(input) {
  const deadlineMs = input.deadlineAt == null ? null : parseTs(normalizeTs(input.deadlineAt));
  const budget = input.budgetCents ?? null;
  const maxPickups = input.maxPickups;
  const main = solve(input, { budget, maxPickups, deadlineMs, wantAll: true });
  if (main.feasible.length > 0) {
    const best = main.feasible[0];
    const alts = main.feasible.filter((e) => e !== best && irredundant(e, main.live, input)).slice(0, 3);
    return {
      feasible: true,
      best: describe(best, main.live),
      alternatives: alts.map((e) => describe(e, main.live)),
      rejections: main.rejections,
      candidateCodes: [],
      relaxations: [],
      blocking: [],
    };
  }

  const candidateCodes = main.live.map((o, index) => {
    const codes = [];
    const maxCups = o.availability * o.units.cups;
    const maxLids = o.availability * o.units.lids;
    if (maxCups < input.requirement.cups || maxLids < input.requirement.lids) codes.push('INSUFFICIENT_QTY');
    const cover = solve(input, { budget: null, maxPickups: Infinity, deadlineMs, forceIndex: index }).feasible[0];
    if (cover) {
      if (cover.pickupCount > maxPickups) codes.push('TOO_MANY_PICKUPS');
      if (budget !== null && cover.totalCents > budget) codes.push('OVER_BUDGET');
    }
    return { supplierCode: o.supplierCode, offerId: o.offerId, codes };
  });

  const relaxations = [];
  const addRelaxation = (constraint, code, run, needed) => {
    const hit = run.feasible[0];
    if (!hit) return;
    const body = describe(hit, run.live);
    relaxations.push({ constraint, code, neededValue: needed(body), plan: { supplierCodes: body.supplierCodes, totalCents: body.totalCents, pickupCount: body.pickupCount, readyAt: body.readyAt } });
  };
  if (budget !== null) addRelaxation('budget', 'OVER_BUDGET', solve(input, { budget: null, maxPickups, deadlineMs }), (b) => b.totalCents);
  if (deadlineMs !== null) addRelaxation('deadline', 'READY_AFTER_DEADLINE', solve(input, { budget, maxPickups, deadlineMs: null }), (b) => b.readyAt);
  addRelaxation('maxPickups', 'TOO_MANY_PICKUPS', solve(input, { budget, maxPickups: Infinity, deadlineMs }), (b) => b.pickupCount);

  return {
    feasible: false,
    best: null,
    alternatives: [],
    rejections: main.rejections,
    candidateCodes,
    relaxations,
    blocking: relaxations.length > 0 ? relaxations.map((r) => r.code) : ['INSUFFICIENT_QTY'],
  };
}
