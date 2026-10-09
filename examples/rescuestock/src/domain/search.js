// Exact search for the planner (SEC-B-1 rewrite). Pure; used by planner.js only.
//
// Problem. Survivors are offers with a multiplicity bound; a plan is a vector m (bundles per offer). The objective is
// lexicographic: total, pickups, plan-ready time, supplier-code string, then the vector in canonical offer order.
//
// Method: enumerate the OFFER SUBSET U (the offers with m > 0) and solve each subset exactly.
//   * Pickups, plan-ready time and the supplier-code string depend on U alone, so inside one subset only the total and
//     the vector matter, and a subset is a small covering problem: every member holds at least one bundle.
//   * Subsets are limited to maxPickups distinct suppliers (at most 2^12 subsets for 12 offers, C(12,<=5) for one offer
//     per supplier), visited cheapest-lower-bound first so that good incumbents come early.
//   * Inside a subset a depth-first search chooses the multiplicity of each member in canonical order, ASCENDING, so
//     leaves appear in ascending lexicographic vector order. A subtree is cut when its lower bound exceeds the budget or
//     the K-th best plan, and also when it can only tie the K-th best of the SAME subset (every later leaf has a larger
//     vector and loses the final tie-break). This removes the plateaus of equal-cost splits.
//   * Only irredundant plans are enumerated (no bundle can be dropped and still cover). The optimum is always
//     irredundant: dropping a bundle never raises total, pickups or ready time and gives a smaller vector. The forced
//     offer of a "cheapest cover containing k" query is exempt, because dropping it would leave the query.
//   * Lower bound at a node: mandatory later bundles (one per later member, with the prep fee of every supplier not yet
//     used) plus the fractional-knapsack cost of the demand still uncovered, per dimension, scaled by the tax rate.
//
// Cost. The search is polynomial in the stock levels: multiplicities are only ever looped over inside the window
// [kLo, kHi] that the remaining demand allows, and the bound removes almost all of it (see the SEC-B-1 timing test and
// the stress script). MAX_SEARCH_NODES is a defensive cap that no input the API accepts (<= 12 offers, availability and
// quantities <= 100,000, maxPickups <= 5) reaches; it only stops runaway callers.

import { taxCents } from './money.js';

export const MAX_SEARCH_NODES = 2_000_000;

export class PlannerLimitError extends RangeError {
  constructor() {
    super('planner search limit exceeded');
    this.name = 'PlannerLimitError';
    this.code = 'PLANNER_LIMIT';
  }
}

const NO_LIMIT = Number.POSITIVE_INFINITY;

export function fastTax(base, taxBp) {
  if (taxBp === 0) return 0;
  const product = base * taxBp;
  if (product <= Number.MAX_SAFE_INTEGER) return Math.floor((product + 5000) / 10000);
  return taxCents(base, taxBp);
}

export function compareArrays(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Lexicographic objective: total, pickups, plan-ready time, supplier-code string, multiplicity vector.
export function comparePlans(a, b) {
  if (a.total !== b.total) return a.total - b.total;
  if (a.pickups !== b.pickups) return a.pickups - b.pickups;
  if (a.readyMs !== b.readyMs) return a.readyMs - b.readyMs;
  if (a.codes !== b.codes) return a.codes < b.codes ? -1 : 1;
  return compareArrays(a.m, b.m);
}

function compareKey(a, b) {
  if (a.pickups !== b.pickups) return a.pickups - b.pickups;
  if (a.readyMs !== b.readyMs) return a.readyMs - b.readyMs;
  if (a.codes !== b.codes) return a.codes < b.codes ? -1 : 1;
  return 0;
}

function insertSorted(list, rec, max) {
  let i = list.length;
  while (i > 0 && comparePlans(rec, list[i - 1]) < 0) i -= 1;
  list.splice(i, 0, rec);
  if (list.length > max) list.pop();
}

/**
 * search(survivors, requirement, taxBp, cons, opts)
 *   survivors: canonical order (supplierCode, offerId), each { supplierCode, unitCups, unitLids, priceCents,
 *              prepFeeCents, readyMs, bound }.
 *   cons: { budget: number|Infinity, maxPickups: number|Infinity }.
 *   opts: { keep: number (how many best plans to keep, default 1), force: canonical index that must be used }.
 * Returns { best, top, nodes }; each plan record is { m (by canonical index), total, pickups, readyMs, codes, uid }.
 */
export function search(survivors, requirement, taxBp, cons, opts = {}) {
  const n = survivors.length;
  const needC = requirement.cups;
  const needL = requirement.lids;
  const budget = cons.budget;
  const maxPickups = cons.maxPickups;
  const K = opts.keep ?? 1;
  const force = opts.force ?? -1;
  const top = [];
  if (opts.seed) top.push(opts.seed); // a valid plan known in advance: the search only has to beat it
  let nodes = 0;
  const tick = () => {
    nodes += 1;
    if (nodes > MAX_SEARCH_NODES) throw new PlannerLimitError();
  };

  const usable = [];
  for (let i = 0; i < n; i += 1) if (survivors[i].bound > 0) usable.push(i);
  if (force >= 0 && !usable.includes(force)) return { best: null, top, nodes };

  const supplierIndex = new Map();
  const sOf = survivors.map((o) => {
    if (!supplierIndex.has(o.supplierCode)) supplierIndex.set(o.supplierCode, supplierIndex.size);
    return supplierIndex.get(o.supplierCode);
  });
  const supplierCount = supplierIndex.size;

  // Comparator: cheaper per unit first (integer cross-multiplication), ties by canonical index.
  function byRatio(units) {
    return (a, b) => {
      const lhs = survivors[a].priceCents * units(survivors[b]);
      const rhs = survivors[b].priceCents * units(survivors[a]);
      return lhs !== rhs ? lhs - rhs : a - b;
    };
  }

  // Price-only fractional-knapsack cost of covering `need` units of one dimension with the given offers (cheapest per
  // unit first, each at most `bound` bundles, the last bundle fractional and floored). Infinity when they cannot.
  function fractionalCover(indices, units, need) {
    if (need <= 0) return 0;
    const order = indices.filter((i) => units(survivors[i]) > 0).sort((a, b) => {
      const lhs = survivors[a].priceCents * units(survivors[b]);
      const rhs = survivors[b].priceCents * units(survivors[a]);
      return lhs !== rhs ? lhs - rhs : a - b;
    });
    let cost = 0;
    let rest = need;
    for (const i of order) {
      if (rest <= 0) break;
      const o = survivors[i];
      const u = units(o);
      const capacity = o.bound * u;
      if (capacity <= rest) {
        cost += o.bound * o.priceCents;
        rest -= capacity;
      } else {
        const product = rest * o.priceCents;
        if (product <= Number.MAX_SAFE_INTEGER) cost += (product - (product % u)) / u;
        rest = 0;
      }
    }
    return rest > 0 ? NO_LIMIT : cost;
  }

  // ---- per-subset data
  function prepare(members) {
    const q = members.length;
    const t = {
      members, q, uid: members.join('.'),
      uc: members.map((i) => survivors[i].unitCups),
      ul: members.map((i) => survivors[i].unitLids),
      bound: members.map((i) => survivors[i].bound),
      price: members.map((i) => survivors[i].priceCents),
      prep: members.map((i) => survivors[i].prepFeeCents),
      local: [],
      forcePos: force >= 0 ? members.indexOf(force) : -1,
    };
    const localIndex = new Map();
    const firstPos = [];
    const maxPrep = [];
    let readyMs = 0;
    for (let p = 0; p < q; p += 1) {
      const o = survivors[members[p]];
      if (!localIndex.has(sOf[members[p]])) {
        localIndex.set(sOf[members[p]], localIndex.size);
        firstPos.push(p);
        maxPrep.push(0);
      }
      const l = localIndex.get(sOf[members[p]]);
      t.local.push(l);
      if (t.prep[p] > maxPrep[l]) maxPrep[l] = t.prep[p];
      if (o.readyMs > readyMs) readyMs = o.readyMs;
    }
    t.suppliers = localIndex.size;
    t.pickups = localIndex.size;
    t.readyMs = readyMs;
    const codes = [];
    for (let p = 0; p < q; p += 1) {
      const code = survivors[members[p]].supplierCode;
      if (codes[codes.length - 1] !== code) codes.push(code);
    }
    t.codes = codes.join(',');
    // suffix sums over positions >= j
    const z = () => new Array(q + 1).fill(0);
    t.minC = z(); t.minL = z(); t.capC = z(); t.capL = z(); t.priceSum = z(); t.newPrep = z(); t.touched = z();
    for (let j = q - 1; j >= 0; j -= 1) {
      t.minC[j] = t.minC[j + 1] + t.uc[j];
      t.minL[j] = t.minL[j + 1] + t.ul[j];
      t.capC[j] = t.capC[j + 1] + t.bound[j] * t.uc[j];
      t.capL[j] = t.capL[j + 1] + t.bound[j] * t.ul[j];
      t.priceSum[j] = t.priceSum[j + 1] + t.price[j];
    }
    for (let j = 0; j <= q; j += 1) {
      const seen = new Set();
      let fresh = 0;
      for (let p = j; p < q; p += 1) {
        const l = t.local[p];
        if (!seen.has(l)) {
          seen.add(l);
          if (firstPos[l] >= j) fresh += maxPrep[l];
        }
      }
      t.newPrep[j] = fresh;
      t.touched[j] = seen.size;
    }
    const ratio = (units) => Array.from({ length: q }, (_, p) => p).filter((p) => units[p] > 0).sort((a, b) => {
      const lhs = t.price[a] * units[b];
      const rhs = t.price[b] * units[a];
      return lhs !== rhs ? lhs - rhs : a - b;
    });
    t.orderC = ratio(t.uc);
    t.orderL = ratio(t.ul);
    return t;
  }

  // Cost of covering `rest` more units of one dimension with the EXTRA bundles (bound - 1 beyond the mandatory one) of
  // the members at positions >= j, cheapest per unit first; the last bundle may be fractional (floored). Infinity when
  // the extra capacity cannot cover.
  function extraCost(order, units, t, j, rest) {
    let cost = 0;
    let need = rest;
    for (let x = 0; x < order.length && need > 0; x += 1) {
      const p = order[x];
      if (p < j) continue;
      const u = units[p];
      const capacity = (t.bound[p] - 1) * u;
      if (capacity <= 0) continue;
      if (capacity <= need) {
        cost += (t.bound[p] - 1) * t.price[p];
        need -= capacity;
      } else {
        const product = need * t.price[p];
        if (product <= Number.MAX_SAFE_INTEGER) cost += (product - (product % u)) / u;
        need = 0;
      }
    }
    return need > 0 ? NO_LIMIT : cost;
  }

  // Lower bound on the cost still to be added by positions >= j given the cups/lids already covered.
  function lowerAdd(t, j, cups, lids) {
    const restC = needC - cups - t.minC[j];
    const restL = needL - lids - t.minL[j];
    let extra = 0;
    if (restC > 0) extra = extraCost(t.orderC, t.uc, t, j, restC);
    if (restL > 0 && extra !== NO_LIMIT) {
      const e = extraCost(t.orderL, t.ul, t, j, restL);
      extra = e > extra ? e : extra;
    }
    if (extra === NO_LIMIT) return NO_LIMIT;
    const price = t.priceSum[j] + t.newPrep[j] + extra;
    if (taxBp === 0) return price;
    // Tax: every later cent costs (1 + bp/10000), less one cent of rounding per touched supplier order.
    const scaled = price * (10000 + taxBp);
    if (scaled > Number.MAX_SAFE_INTEGER) return price;
    return Math.max(price, Math.floor(scaled / 10000) - t.touched[j]);
  }

  function cannotImprove(t, lbTotal) {
    if (lbTotal > budget) return true;
    if (top.length < K) return false;
    const L = top[K - 1];
    if (lbTotal > L.total) return true;
    if (lbTotal === L.total) {
      const c = compareKey(t, L);
      if (c > 0) return true;
      if (c === 0 && L.uid === t.uid) return true; // later leaves of this subset have larger vectors
    }
    return false;
  }

  const m = new Array(n).fill(0);

  function solve(t) {
    const q = t.q;
    const subTotal = new Array(t.suppliers).fill(0);
    const prepOf = new Array(t.suppliers).fill(0);
    const totOf = new Array(t.suppliers).fill(0);

    function hasRemovable(j, cups, lids) {
      for (let p = 0; p < j; p += 1) {
        if (p === t.forcePos) continue;
        if (cups - t.uc[p] >= needC && lids - t.ul[p] >= needL) return true;
      }
      return false;
    }

    // Dominance. When no supplier has two members, the future of a node depends only on (j, cups, lids): the same
    // members remain and the same coverage is missing. The K cheapest prefixes reaching a state are all that can matter
    // (a later prefix of equal total has the larger vector and loses), so a node is cut when K earlier prefixes reached
    // the same state at no greater total. This collapses the plateaus of equal-cost distributions.
    const memo = t.suppliers === q ? Array.from({ length: q + 1 }, () => new Map()) : null;

    function dfs(j, cups, lids, total) {
      tick();
      if (hasRemovable(j, cups, lids)) return;
      if (memo !== null && lids < 8388608) {
        const key = cups * 8388608 + lids;
        const seen = memo[j].get(key);
        if (seen === undefined) {
          memo[j].set(key, [total]);
        } else {
          if (seen.length >= K && total >= seen[K - 1]) return;
          let x = seen.length;
          while (x > 0 && total < seen[x - 1]) x -= 1;
          seen.splice(x, 0, total);
          if (seen.length > K) seen.pop();
        }
      }
      if (j === q) {
        if (cups >= needC && lids >= needL && !cannotImprove(t, total)) {
          insertSorted(top, { m: m.slice(), total, pickups: t.pickups, readyMs: t.readyMs, codes: t.codes, cups, lids, uid: t.uid }, K);
        }
        return;
      }
      const add = lowerAdd(t, j, cups, lids);
      if (add === NO_LIMIT || cannotImprove(t, total + add)) return;
      const uc = t.uc[j];
      const ul = t.ul[j];
      const l = t.local[j];
      // largest useful multiplicity: the last bundle must still be needed in cups or in lids
      let kHi = 0;
      if (uc > 0) {
        const r = needC - cups - t.minC[j + 1];
        if (r > 0) kHi = Math.ceil(r / uc);
      }
      if (ul > 0) {
        const r = needL - lids - t.minL[j + 1];
        if (r > 0) kHi = Math.max(kHi, Math.ceil(r / ul));
      }
      if (j === t.forcePos && kHi < 1) kHi = 1;
      if (kHi > t.bound[j]) kHi = t.bound[j];
      // smallest multiplicity after which the later members can still cover
      let kLo = 1;
      const shortC = needC - cups - t.capC[j + 1];
      if (shortC > 0) {
        if (uc <= 0) return;
        kLo = Math.max(kLo, Math.ceil(shortC / uc));
      }
      const shortL = needL - lids - t.capL[j + 1];
      if (shortL > 0) {
        if (ul <= 0) return;
        kLo = Math.max(kLo, Math.ceil(shortL / ul));
      }
      const sub0 = subTotal[l];
      const prep0 = prepOf[l];
      const tot0 = totOf[l];
      const prep1 = prep0 > t.prep[j] ? prep0 : t.prep[j];
      const member = t.members[j];
      for (let k = kLo; k <= kHi; k += 1) {
        tick(); // counts every multiplicity tried, so no loop can run unbounded
        const sub1 = sub0 + k * t.price[j];
        const base = sub1 + prep1;
        const tot1 = base + fastTax(base, taxBp);
        const total1 = total - tot0 + tot1;
        if (total1 > budget) break;
        if (top.length >= K && total1 > top[K - 1].total) break;
        const nextCups = cups + k * uc;
        const nextLids = lids + k * ul;
        if (memo !== null && nextLids < 8388608) {
          const seen = memo[j + 1].get(nextCups * 8388608 + nextLids);
          if (seen !== undefined && seen.length >= K && total1 >= seen[K - 1]) continue; // dominated, see above
        }
        subTotal[l] = sub1;
        prepOf[l] = prep1;
        totOf[l] = tot1;
        m[member] = k;
        dfs(j + 1, nextCups, nextLids, total1);
      }
      subTotal[l] = sub0;
      prepOf[l] = prep0;
      totOf[l] = tot0;
      m[member] = 0;
    }

    dfs(0, 0, 0, 0);
  }

  // ---- enumerate subsets by size, smallest first, so that cheap incumbents exist before the big subsets are met.
  // A subset must hold at most maxPickups distinct suppliers (and the forced offer, if any). While growing a subset the
  // mandatory cost (one bundle per member plus the largest prep fee of each supplier) only rises, so a branch whose
  // mandatory cost already exceeds the budget or the K-th best total is cut together with all its supersets.
  const pool = usable.filter((i) => i !== force);
  const supplierCountIn = new Array(supplierCount).fill(0);
  const supplierPrep = new Array(supplierCount).fill(0);
  let priceSum = 0; // one bundle per member
  let prepSum = 0; // the largest prep fee of each supplier in the subset
  let suppliersIn = 0;
  // Cheapest conceivable price of covering the demand with ANY usable offers (fractional knapsack, prices only):
  // every subset pays at least this much for bundles, plus its prep fees.
  const coverFloor = Math.max(
    fractionalCover(usable, (o) => o.unitCups, needC),
    fractionalCover(usable, (o) => o.unitLids, needL),
  );
  let capCups = 0;
  let capLids = 0;
  let minCups = 0; // one bundle per member
  let minLids = 0;
  const inSet = new Array(n).fill(false);
  const members = force >= 0 ? [force] : [];

  function addOffer(i) {
    const o = survivors[i];
    const s = sOf[i];
    const undo = { s, prep: supplierPrep[s], fresh: supplierCountIn[s] === 0 };
    if (undo.fresh) suppliersIn += 1;
    supplierCountIn[s] += 1;
    priceSum += o.priceCents;
    if (o.prepFeeCents > supplierPrep[s]) {
      prepSum += o.prepFeeCents - supplierPrep[s];
      supplierPrep[s] = o.prepFeeCents;
    }
    capCups += o.bound * o.unitCups;
    capLids += o.bound * o.unitLids;
    minCups += o.unitCups;
    minLids += o.unitLids;
    inSet[i] = true;
    return undo;
  }

  function removeOffer(i, undo) {
    const o = survivors[i];
    capCups -= o.bound * o.unitCups;
    capLids -= o.bound * o.unitLids;
    minCups -= o.unitCups;
    minLids -= o.unitLids;
    inSet[i] = false;
    priceSum -= o.priceCents;
    if (o.prepFeeCents > undo.prep) prepSum -= o.prepFeeCents - undo.prep;
    supplierPrep[undo.s] = undo.prep;
    supplierCountIn[undo.s] -= 1;
    if (undo.fresh) suppliersIn -= 1;
  }

  function mandatoryTooDear() {
    if (coverFloor === NO_LIMIT) return true;
    const mandatory = (priceSum > coverFloor ? priceSum : coverFloor) + prepSum;
    let lb = mandatory;
    if (taxBp > 0) {
      const scaled = mandatory * (10000 + taxBp);
      if (scaled <= Number.MAX_SAFE_INTEGER) lb = Math.max(mandatory, Math.floor(scaled / 10000) - suppliersIn);
    }
    if (lb > budget) return true;
    return top.length >= K && lb > top[K - 1].total;
  }

  // Root lower bound of the current member set without building the per-subset tables (cheap pre-filter).
  const orderCg = usable.filter((i) => survivors[i].unitCups > 0).sort(byRatio((o) => o.unitCups));
  const orderLg = usable.filter((i) => survivors[i].unitLids > 0).sort(byRatio((o) => o.unitLids));
  function extraRoot(order, units, rest) {
    let cost = 0;
    let need = rest;
    for (let x = 0; x < order.length && need > 0; x += 1) {
      const i = order[x];
      if (!inSet[i]) continue;
      const o = survivors[i];
      const u = units(o);
      const capacity = (o.bound - 1) * u;
      if (capacity <= 0) continue;
      if (capacity <= need) {
        cost += (o.bound - 1) * o.priceCents;
        need -= capacity;
      } else {
        const product = need * o.priceCents;
        if (product <= Number.MAX_SAFE_INTEGER) cost += (product - (product % u)) / u;
        need = 0;
      }
    }
    return need > 0 ? NO_LIMIT : cost;
  }
  function rootLowerBound() {
    let extra = 0;
    if (needC - minCups > 0) extra = extraRoot(orderCg, (o) => o.unitCups, needC - minCups);
    if (needL - minLids > 0 && extra !== NO_LIMIT) {
      const e = extraRoot(orderLg, (o) => o.unitLids, needL - minLids);
      extra = e > extra ? e : extra;
    }
    if (extra === NO_LIMIT) return NO_LIMIT;
    const price = priceSum + prepSum + extra;
    if (taxBp === 0) return price;
    const scaled = price * (10000 + taxBp);
    if (scaled > Number.MAX_SAFE_INTEGER) return price;
    return Math.max(price, Math.floor(scaled / 10000) - suppliersIn);
  }

  function consider() {
    if (capCups < needC || capLids < needL) return;
    const rough = rootLowerBound();
    if (rough === NO_LIMIT || rough > budget || (top.length >= K && rough > top[K - 1].total)) return;
    const t = prepare(members.slice().sort((a, b) => a - b));
    const lb = lowerAdd(t, 0, 0, 0);
    if (lb === NO_LIMIT || cannotImprove(t, lb)) return;
    solve(t);
  }

  function extend(start, remaining) {
    if (remaining === 0) {
      consider();
      return;
    }
    for (let x = start; x <= pool.length - remaining; x += 1) {
      const i = pool[x];
      if (supplierCountIn[sOf[i]] === 0 && suppliersIn + 1 > maxPickups) continue;
      const undo = addOffer(i);
      members.push(i);
      if (!mandatoryTooDear()) extend(x + 1, remaining - 1);
      members.pop();
      removeOffer(i, undo);
    }
  }

  if (force >= 0) addOffer(force);
  for (let extra = force >= 0 ? 0 : 1; extra <= pool.length; extra += 1) {
    if (!mandatoryTooDear()) extend(0, extra);
  }
  return { best: top.length > 0 ? top[0] : null, top, nodes };
}
