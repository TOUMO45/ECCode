// Exact lexicographic planner (brief > Planner rules). Pure: no clock, no I/O, no randomness; equal input gives
// deep-equal output.
//
// Model
//   * Each surviving offer k may be used m_k times, 0 <= m_k <= min(availability_k, ceil(need / units_k)).
//     Bundles are indivisible. Several offers of one supplier form ONE supplier order: one pickup, one prep fee
//     (the largest prep fee among the supplier's chosen offers), one rounded tax.
//   * Feasible: cups >= required cups, lids >= required lids, suppliers used <= maxPickups, every chosen offer
//     ready by the deadline (filtered up front), total <= budget.
//   * Total = sum over supplier orders of (subtotal + prep fee + tax), tax = round-half-up(bp) per order.
//   * Objective, lexicographic: total cents, pickup count, plan-ready time (latest supplier ready time), the
//     sorted supplier-code string, then (only for identical supplier sets) the multiplicity vector.
//   * Search (search.js): exact. It enumerates the offer subsets within the pickup cap and solves each subset's
//     covering problem by bounded depth-first search with a fractional-knapsack lower bound, so the work does not grow
//     with the stock levels (SEC-B-1). See search.js for the argument.

import { CURRENCY, assertBasisPoints, assertCents, isCents, supplierOrderTotals } from './money.js';
import { normalizeTs, parseTs } from './time.js';
import { areCompatible, matchesRequirement } from './compat.js';
import { MAX_SEARCH_NODES, PlannerLimitError, compareArrays, search } from './search.js';

export const REJECTION_CODES = Object.freeze(['INCOMPATIBLE_LID_DIAMETER', 'READY_AFTER_DEADLINE', 'OUT_OF_STOCK', 'OFFER_WITHDRAWN']);
export const CANDIDATE_CODES = Object.freeze(['INSUFFICIENT_QTY', 'TOO_MANY_PICKUPS', 'OVER_BUDGET']);
export const MAX_ALTERNATIVES = 3;
// PLANNER_LIMIT is a defensive guard only. No input the API accepts (<= 12 offers, availability and quantities
// <= 100,000, maxPickups <= 5) reaches it: the SEC-B-1 timing test and sweep assert that.
export { CURRENCY, MAX_SEARCH_NODES, PlannerLimitError };

const NO_LIMIT = Number.POSITIVE_INFINITY;

// ---------------------------------------------------------------- input validation and normalisation

function fail(message) {
  throw new RangeError(`planner input: ${message}`);
}

function intAtLeast(value, min, name) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${name} must be an integer >= ${min}`);
  return value;
}

function normalizeInput(input) {
  if (input === null || typeof input !== 'object') fail('input must be an object');
  const r = input.requirement;
  if (r === null || typeof r !== 'object') fail('requirement is required');
  const requirement = {
    cups: intAtLeast(r.cups, 0, 'requirement.cups'),
    lids: intAtLeast(r.lids, 0, 'requirement.lids'),
    capacityMl: intAtLeast(r.capacityMl, 1, 'requirement.capacityMl'),
    diameterMm: intAtLeast(r.diameterMm, 1, 'requirement.diameterMm'),
    material: r.material ?? null,
  };
  if (requirement.cups + requirement.lids === 0) fail('requirement needs at least one cup or lid');
  const budgetCents = input.budgetCents ?? null;
  if (budgetCents !== null) assertCents(budgetCents, 'budgetCents');
  const deadlineAt = input.deadlineAt ?? null;
  const deadlineMs = deadlineAt === null ? null : parseTs(deadlineAt);
  const maxPickups = intAtLeast(input.maxPickups, 1, 'maxPickups');
  const taxBp = assertBasisPoints(input.taxBp ?? 0);
  const exclude = input.excludeSupplierCodes ?? [];
  if (!Array.isArray(exclude) || exclude.some((c) => typeof c !== 'string')) fail('excludeSupplierCodes must be an array of strings');
  if (!Array.isArray(input.offers)) fail('offers must be an array');

  const seenIds = new Set();
  const offers = [];
  for (const o of input.offers) {
    if (o === null || typeof o !== 'object') fail('every offer must be an object');
    if (typeof o.supplierCode !== 'string' || o.supplierCode.length === 0) fail('offer.supplierCode must be a non-empty string');
    intAtLeast(o.offerId, 1, 'offer.offerId');
    if (seenIds.has(o.offerId)) fail('offer ids must be unique');
    seenIds.add(o.offerId);
    const units = o.units ?? {};
    const cups = intAtLeast(units.cups, 0, 'offer.units.cups');
    const lids = intAtLeast(units.lids, 0, 'offer.units.lids');
    if (cups + lids === 0) fail('offer.units must contain at least one cup or lid');
    if (!isCents(o.priceCents)) fail('offer.priceCents must be integer cents');
    if (!isCents(o.prepFeeCents)) fail('offer.prepFeeCents must be integer cents');
    const readyAt = normalizeTs(o.readyAt);
    offers.push({
      supplierCode: o.supplierCode,
      supplierName: typeof o.supplierName === 'string' && o.supplierName ? o.supplierName : `Supplier ${o.supplierCode}`,
      offerId: o.offerId,
      offerVersion: intAtLeast(o.offerVersion ?? 1, 1, 'offer.offerVersion'),
      productId: o.productId ?? null,
      productName: typeof o.productName === 'string' ? o.productName : '',
      unitCups: cups,
      unitLids: lids,
      capacityMl: intAtLeast(o.capacityMl, 1, 'offer.capacityMl'),
      cupDiameterMm: intAtLeast(o.cupDiameterMm, 1, 'offer.cupDiameterMm'),
      lidDiameterMm: intAtLeast(o.lidDiameterMm, 1, 'offer.lidDiameterMm'),
      confirmedCompatible: o.confirmedCompatible === true,
      priceCents: o.priceCents,
      prepFeeCents: o.prepFeeCents,
      readyAt,
      readyMs: parseTs(readyAt),
      availability: intAtLeast(o.availability, 0, 'offer.availability'),
      withdrawn: o.withdrawn === true,
      demo: o.demo === true,
    });
  }
  offers.sort((a, b) => (a.supplierCode < b.supplierCode ? -1 : a.supplierCode > b.supplierCode ? 1 : a.offerId - b.offerId));
  return { requirement, budgetCents, deadlineAt: deadlineMs === null ? null : normalizeTs(deadlineAt), deadlineMs, maxPickups, taxBp, excluded: [...new Set(exclude)].sort(), offers };
}

// ---------------------------------------------------------------- candidate filter

function neededBundles(requirement, o) {
  let need = 0;
  if (requirement.cups > 0 && o.unitCups > 0) need = Math.max(need, Math.ceil(requirement.cups / o.unitCups));
  if (requirement.lids > 0 && o.unitLids > 0) need = Math.max(need, Math.ceil(requirement.lids / o.unitLids));
  return need;
}

function classify(ctx, deadlineMs) {
  const survivors = [];
  const rejections = [];
  const candidates = [];
  for (const o of ctx.offers) {
    if (ctx.excluded.includes(o.supplierCode)) continue;
    const base = {
      supplierCode: o.supplierCode,
      offerId: o.offerId,
      offerVersion: o.offerVersion,
      availability: o.availability,
      priceCents: o.priceCents,
      prepFeeCents: o.prepFeeCents,
      readyAt: o.readyAt,
      cupDiameterMm: o.cupDiameterMm,
      lidDiameterMm: o.lidDiameterMm,
    };
    if (!matchesRequirement(o, ctx.requirement)) {
      candidates.push({ ...base, codes: [], skipped: 'SPEC_MISMATCH' });
      continue;
    }
    const codes = [];
    if (o.withdrawn) {
      codes.push('OFFER_WITHDRAWN');
    } else {
      if (!areCompatible(o)) codes.push('INCOMPATIBLE_LID_DIAMETER');
      if (deadlineMs !== null && o.readyMs > deadlineMs) codes.push('READY_AFTER_DEADLINE');
      if (o.availability === 0) codes.push('OUT_OF_STOCK');
    }
    if (codes.length > 0) {
      rejections.push({ supplierCode: o.supplierCode, offerId: o.offerId, codes });
      candidates.push({ ...base, codes });
      continue;
    }
    const bound = Math.min(o.availability, neededBundles(ctx.requirement, o));
    survivors.push({ ...o, bound, ci: survivors.length });
    candidates.push({ ...base, codes: [], maxBundles: bound, suppliesCups: bound * o.unitCups, suppliesLids: bound * o.unitLids });
  }
  return { survivors, rejections, candidates };
}

// ---------------------------------------------------------------- output construction

function sameVector(a, b) {
  return compareArrays(a, b) === 0;
}

function buildBody(rec, survivors, ctx) {
  const lines = [];
  const bySupplier = new Map();
  let cups = 0;
  let lids = 0;
  let readyMs = 0;
  let readyAt = null;
  for (let i = 0; i < survivors.length; i += 1) {
    const bundles = rec.m[i];
    if (bundles === 0) continue;
    const o = survivors[i];
    lines.push({
      supplierCode: o.supplierCode,
      offerId: o.offerId,
      offerVersion: o.offerVersion,
      productName: o.productName,
      bundles,
      cups: bundles * o.unitCups,
      lids: bundles * o.unitLids,
      unitPriceCents: o.priceCents,
      demo: o.demo,
    });
    cups += bundles * o.unitCups;
    lids += bundles * o.unitLids;
    if (o.readyMs > readyMs || readyAt === null) {
      readyMs = o.readyMs;
      readyAt = o.readyAt;
    }
    let s = bySupplier.get(o.supplierCode);
    if (!s) {
      s = { supplierCode: o.supplierCode, supplierName: o.supplierName, subtotalCents: 0, prepFeeCents: 0, catalogReadyMs: 0, catalogReadyAt: o.readyAt, demo: false };
      bySupplier.set(o.supplierCode, s);
    }
    s.subtotalCents += bundles * o.priceCents;
    if (o.prepFeeCents > s.prepFeeCents) s.prepFeeCents = o.prepFeeCents;
    if (o.readyMs >= s.catalogReadyMs) {
      s.catalogReadyMs = o.readyMs;
      s.catalogReadyAt = o.readyAt;
    }
    if (o.demo) s.demo = true;
  }
  const suppliers = [...bySupplier.values()].map((s) => {
    const t = supplierOrderTotals({ subtotalCents: s.subtotalCents, prepFeeCents: s.prepFeeCents, taxBp: ctx.taxBp });
    return {
      supplierCode: s.supplierCode,
      supplierName: s.supplierName,
      subtotalCents: t.subtotalCents,
      prepFeeCents: t.prepFeeCents,
      taxCents: t.taxCents,
      totalCents: t.totalCents,
      catalogReadyAt: s.catalogReadyAt,
      demo: s.demo,
    };
  });
  const totalCents = suppliers.reduce((sum, s) => sum + s.totalCents, 0);
  if (totalCents !== rec.total) throw new Error('planner invariant violated: search total differs from rebuilt total');
  return {
    lines,
    suppliers,
    totalCents,
    pickupCount: suppliers.length,
    readyAt,
    surplus: { cups: cups - ctx.requirement.cups, lids: lids - ctx.requirement.lids },
  };
}

// A plan record (as the search produces) for an explicit multiplicity vector, evaluated from scratch.
function evaluateVector(m, survivors, taxBp) {
  const bySupplier = new Map();
  let cups = 0;
  let lids = 0;
  let readyMs = 0;
  for (let i = 0; i < survivors.length; i += 1) {
    if (m[i] === 0) continue;
    const o = survivors[i];
    cups += m[i] * o.unitCups;
    lids += m[i] * o.unitLids;
    if (o.readyMs > readyMs) readyMs = o.readyMs;
    const s = bySupplier.get(o.supplierCode) ?? { subtotalCents: 0, prepFeeCents: 0 };
    s.subtotalCents += m[i] * o.priceCents;
    if (o.prepFeeCents > s.prepFeeCents) s.prepFeeCents = o.prepFeeCents;
    bySupplier.set(o.supplierCode, s);
  }
  let total = 0;
  for (const s of bySupplier.values()) total += supplierOrderTotals({ ...s, taxBp }).totalCents;
  const codes = [...bySupplier.keys()].sort().join(',');
  return { m: m.slice(), total, pickups: bySupplier.size, readyMs, codes, cups, lids, uid: 'seed' };
}

function vectorSignature(rec, survivors) {
  const parts = [];
  for (let i = 0; i < survivors.length; i += 1) {
    if (rec.m[i] > 0) parts.push(`${survivors[i].supplierCode}:${rec.m[i]}`);
  }
  return parts.join(',');
}

// First objective component in which `alt` is worse than `best`.
function compareReason(best, alt, survivors) {
  if (best.total !== alt.total) return { decidedBy: 'total', best: best.total, alternative: alt.total };
  if (best.pickups !== alt.pickups) return { decidedBy: 'pickups', best: best.pickups, alternative: alt.pickups };
  if (best.readyMs !== alt.readyMs) {
    return { decidedBy: 'readyAt', best: new Date(best.readyMs).toISOString(), alternative: new Date(alt.readyMs).toISOString() };
  }
  if (best.codes !== alt.codes) return { decidedBy: 'supplierCodes', best: best.codes, alternative: alt.codes };
  return { decidedBy: 'supplierCodes', best: vectorSignature(best, survivors), alternative: vectorSignature(alt, survivors) };
}

function publicSummary(rec) {
  return {
    supplierCodes: rec.codes === '' ? [] : rec.codes.split(','),
    totalCents: rec.total,
    pickupCount: rec.pickups,
    readyAt: new Date(rec.readyMs).toISOString(),
  };
}

function traceInputs(ctx) {
  return {
    requirement: ctx.requirement,
    budgetCents: ctx.budgetCents,
    deadlineAt: ctx.deadlineAt,
    maxPickups: ctx.maxPickups,
    taxBp: ctx.taxBp,
    excludeSupplierCodes: ctx.excluded,
  };
}

// ---------------------------------------------------------------- public API

/**
 * plan(input) -> { feasible: true, best, alternatives, rejections, trace }
 *              | { feasible: false, rejections, candidateCodes, relaxations, blocking, trace }
 * See the header comment for the model, and the design spec "Internal module contracts" for the shapes.
 */
export function plan(input) {
  const ctx = normalizeInput(input);
  const { survivors, rejections, candidates } = classify(ctx, ctx.deadlineMs);
  const budget = ctx.budgetCents === null ? NO_LIMIT : ctx.budgetCents;
  const main = search(survivors, ctx.requirement, ctx.taxBp, { budget, maxPickups: ctx.maxPickups }, { keep: MAX_ALTERNATIVES + 1 });

  if (main.best !== null) {
    const best = main.best;
    const alternativesRecs = main.top.filter((r) => !sameVector(r.m, best.m)).slice(0, MAX_ALTERNATIVES);
    const bestBody = buildBody(best, survivors, ctx);
    const comparisons = alternativesRecs.map((alt, i) => ({ rank: i + 1, ...compareReason(best, alt, survivors) }));
    return {
      feasible: true,
      best: { ...bestBody, supplierCodes: bestBody.suppliers.map((s) => s.supplierCode) },
      alternatives: alternativesRecs.map((r) => buildBody(r, survivors, ctx)),
      rejections,
      trace: { inputs: traceInputs(ctx), candidates, comparisons, enumerated: main.nodes },
    };
  }

  // Infeasible: per-candidate codes, computed relaxations, blocking constraints.
  let enumerated = main.nodes;
  const candidateCodes = [];
  const candidateDetails = new Map();
  // The cheapest cover ignoring pickups and budget answers every offer it uses; any other offer k is searched with that
  // cover plus one bundle of k as its starting incumbent (a valid cover that contains k), which prunes hard.
  const unconstrained = search(survivors, ctx.requirement, ctx.taxBp, { budget: NO_LIMIT, maxPickups: NO_LIMIT });
  enumerated += unconstrained.nodes;
  for (const o of survivors) {
    const codes = [];
    const aloneCovers = o.bound * o.unitCups >= ctx.requirement.cups && o.bound * o.unitLids >= ctx.requirement.lids;
    if (!aloneCovers) codes.push('INSUFFICIENT_QTY');
    let cover;
    if (unconstrained.best === null) {
      cover = { best: null, nodes: 0 };
    } else if (unconstrained.best.m[o.ci] > 0) {
      cover = { best: unconstrained.best, nodes: 0 };
    } else if (o.bound < 1) {
      cover = { best: null, nodes: 0 };
    } else {
      const m = unconstrained.best.m.slice();
      m[o.ci] = 1;
      const seed = evaluateVector(m, survivors, ctx.taxBp);
      cover = search(survivors, ctx.requirement, ctx.taxBp, { budget: NO_LIMIT, maxPickups: NO_LIMIT }, { force: o.ci, seed });
    }
    enumerated += cover.nodes;
    if (cover.best !== null) {
      if (cover.best.pickups > ctx.maxPickups) codes.push('TOO_MANY_PICKUPS');
      if (ctx.budgetCents !== null && cover.best.total > ctx.budgetCents) codes.push('OVER_BUDGET');
      candidateDetails.set(o.offerId, publicSummary(cover.best));
    } else {
      candidateDetails.set(o.offerId, null);
    }
    candidateCodes.push({ supplierCode: o.supplierCode, offerId: o.offerId, codes });
  }

  const relaxations = [];
  const relax = (constraint, code, survivorsFor, cons, neededOf) => {
    const res = search(survivorsFor, ctx.requirement, ctx.taxBp, cons);
    enumerated += res.nodes;
    if (res.best === null) return;
    const summary = publicSummary(res.best);
    relaxations.push({ constraint, code, neededValue: neededOf(summary), plan: summary });
  };
  if (ctx.budgetCents !== null) {
    relax('budget', 'OVER_BUDGET', survivors, { budget: NO_LIMIT, maxPickups: ctx.maxPickups }, (p) => p.totalCents);
  }
  if (ctx.deadlineMs !== null) {
    const relaxed = classify(ctx, null);
    relax('deadline', 'READY_AFTER_DEADLINE', relaxed.survivors, { budget, maxPickups: ctx.maxPickups }, (p) => p.readyAt);
  }
  relax('maxPickups', 'TOO_MANY_PICKUPS', survivors, { budget, maxPickups: NO_LIMIT }, (p) => p.pickupCount);

  const blocking = relaxations.length > 0 ? relaxations.map((r) => r.code) : ['INSUFFICIENT_QTY'];
  const detailedCandidates = candidates.map((c) => (candidateDetails.has(c.offerId) ? { ...c, cheapestCover: candidateDetails.get(c.offerId) } : c));
  return {
    feasible: false,
    rejections,
    candidateCodes,
    relaxations,
    blocking,
    trace: { inputs: traceInputs(ctx), candidates: detailedCandidates, comparisons: [], enumerated },
  };
}
