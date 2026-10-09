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
//   * Search: exhaustive depth-first enumeration with branch-and-bound on total cost. Total cost never decreases
//     when a bundle is added, so a partial total above the budget or above the K-th best total cannot recover.
//     Pruning is strictly "greater than", so ties are still reached and broken by the full objective.

import { CURRENCY, assertBasisPoints, assertCents, isCents, supplierOrderTotals, taxCents } from './money.js';
import { normalizeTs, parseTs } from './time.js';
import { areCompatible, matchesRequirement } from './compat.js';

export const REJECTION_CODES = Object.freeze(['INCOMPATIBLE_LID_DIAMETER', 'READY_AFTER_DEADLINE', 'OUT_OF_STOCK', 'OFFER_WITHDRAWN']);
export const CANDIDATE_CODES = Object.freeze(['INSUFFICIENT_QTY', 'TOO_MANY_PICKUPS', 'OVER_BUDGET']);
export const MAX_ALTERNATIVES = 3;

// Anomaly guard, not a tuning knob: the catalogs of the brief (<= 12 offers) need a few thousand nodes. A search that
// exceeds this many nodes (absurd quantities or hundreds of offers) is refused instead of running unbounded.
export const MAX_SEARCH_NODES = 2_000_000;

export class PlannerLimitError extends RangeError {
  constructor() {
    super('planner search limit exceeded');
    this.name = 'PlannerLimitError';
    this.code = 'PLANNER_LIMIT';
  }
}
export { CURRENCY };

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

// ---------------------------------------------------------------- the search

function fastTax(base, taxBp) {
  if (taxBp === 0) return 0;
  const product = base * taxBp;
  if (product <= Number.MAX_SAFE_INTEGER) return Math.floor((product + 5000) / 10000);
  return taxCents(base, taxBp);
}

function compareArrays(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Lexicographic objective: total, pickups, plan-ready time, supplier-code string, multiplicity vector.
function comparePlans(a, b) {
  if (a.total !== b.total) return a.total - b.total;
  if (a.pickups !== b.pickups) return a.pickups - b.pickups;
  if (a.readyMs !== b.readyMs) return a.readyMs - b.readyMs;
  if (a.codes !== b.codes) return a.codes < b.codes ? -1 : 1;
  return compareArrays(a.m, b.m);
}

function insertSorted(list, rec, max) {
  let i = list.length;
  while (i > 0 && comparePlans(rec, list[i - 1]) < 0) i -= 1;
  list.splice(i, 0, rec);
  if (list.length > max) list.pop();
}

/**
 * Exhaustive branch-and-bound over the multiplicity vectors of `survivors` (canonical order).
 * cons: { budget: number|Infinity, maxPickups: number|Infinity }.
 * opts: { alternatives: bool (also collect the 4 best irredundant plans), force: canonical index that must be used }.
 * Returns { best, irredundant, nodes }; each plan record has m (by canonical index), total, pickups, readyMs, codes.
 */
function search(survivors, requirement, taxBp, cons, opts = {}) {
  const n = survivors.length;
  const needC = requirement.cups;
  const needL = requirement.lids;
  const budget = cons.budget;
  const maxPickups = cons.maxPickups;
  const wantAlternatives = opts.alternatives === true;
  const force = opts.force ?? -1;

  // Search order: cheapest per useful unit first (a heuristic for pruning only; the result does not depend on it).
  const unit = (o) => (needC > 0 && o.unitCups > 0 ? o.unitCups : o.unitLids || 1);
  const order = survivors.map((_, i) => i).sort((a, b) => {
    const oa = survivors[a];
    const ob = survivors[b];
    const lhs = oa.priceCents * unit(ob);
    const rhs = ob.priceCents * unit(oa);
    return lhs !== rhs ? lhs - rhs : a - b;
  });

  const supplierIndex = new Map();
  const sOf = survivors.map((o) => {
    if (!supplierIndex.has(o.supplierCode)) supplierIndex.set(o.supplierCode, supplierIndex.size);
    return supplierIndex.get(o.supplierCode);
  });
  const suppliers = supplierIndex.size;
  const sub = new Array(suppliers).fill(0);
  const prep = new Array(suppliers).fill(0);
  const tot = new Array(suppliers).fill(0);
  const used = new Array(suppliers).fill(0);

  const sufC = new Array(n + 1).fill(0);
  const sufL = new Array(n + 1).fill(0);
  for (let p = n - 1; p >= 0; p -= 1) {
    const o = survivors[order[p]];
    sufC[p] = sufC[p + 1] + o.bound * o.unitCups;
    sufL[p] = sufL[p + 1] + o.bound * o.unitLids;
  }

  const m = new Array(n).fill(0);
  let best = null;
  const irredundant = [];
  let nodes = 0;

  const limit = () => {
    if (wantAlternatives) return irredundant.length >= MAX_ALTERNATIVES + 1 ? irredundant[MAX_ALTERNATIVES].total : NO_LIMIT;
    return best === null ? NO_LIMIT : best.total;
  };

  function leaf(cups, lids, total, pickups) {
    let readyMs = 0;
    let codes = '';
    let last = '';
    for (let i = 0; i < n; i += 1) {
      if (m[i] === 0) continue;
      const o = survivors[i];
      if (o.readyMs > readyMs) readyMs = o.readyMs;
      if (o.supplierCode !== last) {
        codes = codes === '' ? o.supplierCode : `${codes},${o.supplierCode}`;
        last = o.supplierCode;
      }
    }
    const rec = { m: m.slice(), total, pickups, readyMs, codes, cups, lids };
    if (best === null || comparePlans(rec, best) < 0) best = rec;
    if (wantAlternatives) {
      let redundant = false;
      for (let i = 0; i < n && !redundant; i += 1) {
        if (m[i] === 0) continue;
        const o = survivors[i];
        if (cups - o.unitCups >= needC && lids - o.unitLids >= needL) redundant = true;
      }
      if (!redundant) insertSorted(irredundant, rec, MAX_ALTERNATIVES + 1);
    }
  }

  function dfs(pos, cups, lids, total, pickups) {
    nodes += 1;
    if (nodes > MAX_SEARCH_NODES) throw new PlannerLimitError();
    if (pos === n) {
      if (cups >= needC && lids >= needL) leaf(cups, lids, total, pickups);
      return;
    }
    if (cups + sufC[pos] < needC || lids + sufL[pos] < needL) return;
    const ci = order[pos];
    const o = survivors[ci];
    const s = sOf[ci];
    const sub0 = sub[s];
    const prep0 = prep[s];
    const tot0 = tot[s];
    const used0 = used[s];
    const joinsNewSupplier = used0 === 0;
    const nextPickups = joinsNewSupplier ? pickups + 1 : pickups;
    const prep1 = prep0 > o.prepFeeCents ? prep0 : o.prepFeeCents;
    const totalAt = (k) => {
      const base = sub0 + k * o.priceCents + prep1;
      return total - tot0 + base + fastTax(base, taxBp);
    };
    // Largest multiplicity worth trying: the pickup bound and (monotone) cost bounds cut it before iterating.
    let kHi = nextPickups > maxPickups ? 0 : o.bound;
    if (kHi > 0) {
      const cap = Math.min(budget, limit());
      if (cap !== NO_LIMIT) {
        let lo = 0;
        let hi = kHi;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (totalAt(mid) <= cap) lo = mid; else hi = mid - 1;
        }
        kHi = lo;
      }
    }
    for (let k = kHi; k >= 0; k -= 1) {
      if (k === 0) {
        if (force === ci) break;
        m[ci] = 0;
        dfs(pos + 1, cups, lids, total, pickups);
        continue;
      }
      nodes += 1;
      if (nodes > MAX_SEARCH_NODES) throw new PlannerLimitError();
      const sub1 = sub0 + k * o.priceCents;
      const total1 = totalAt(k);
      const base = sub1 + prep1;
      const tot1 = base + fastTax(base, taxBp);
      if (total1 > budget || total1 > limit()) continue;
      sub[s] = sub1;
      prep[s] = prep1;
      tot[s] = tot1;
      used[s] = used0 + k;
      m[ci] = k;
      dfs(pos + 1, cups + k * o.unitCups, lids + k * o.unitLids, total1, nextPickups);
      sub[s] = sub0;
      prep[s] = prep0;
      tot[s] = tot0;
      used[s] = used0;
      m[ci] = 0;
    }
  }

  dfs(0, 0, 0, 0, 0);
  return { best, irredundant, nodes };
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
  const main = search(survivors, ctx.requirement, ctx.taxBp, { budget, maxPickups: ctx.maxPickups }, { alternatives: true });

  if (main.best !== null) {
    const best = main.best;
    const alternativesRecs = main.irredundant.filter((r) => !sameVector(r.m, best.m)).slice(0, MAX_ALTERNATIVES);
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
  for (const o of survivors) {
    const codes = [];
    const aloneCovers = o.bound * o.unitCups >= ctx.requirement.cups && o.bound * o.unitLids >= ctx.requirement.lids;
    if (!aloneCovers) codes.push('INSUFFICIENT_QTY');
    const cover = search(survivors, ctx.requirement, ctx.taxBp, { budget: NO_LIMIT, maxPickups: NO_LIMIT }, { force: o.ci });
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
