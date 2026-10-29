'use strict';
// Item-level analysis for H-A (bench/protocols/2026-10-28-phase2.md §7):
// runs on one item are not independent, so the unit is the item.
//   primary:   paired permutation test (sign flips) on per-item differences of
//              success rates between two arms; exact over all 2^k flips for
//              k <= 20, else seeded Monte Carlo
//   check:     mixed-effects logistic regression with an item random intercept
//              (logit p = b0 + b1·arm + u_item, u ~ N(0, s^2)), likelihood-
//              ratio test of b1 with the integral over u on a fixed grid
//   secondary: McNemar on runs (lib/bench.js mcnemar), labelled as such
// Power is found by simulation (`power`), under a stated between-item variance.
//   node bench/pilot/phase2-analysis.js power [--tau 1.0] [--runs 6] [--sims 400]
//   node bench/pilot/phase2-analysis.js analyze <runs.jsonl> --a debug --b without
const fs = require('fs');
const { mulberry32, mcnemar } = require('../../lib/bench');

// ------------------------------------------------------------ primary

/** Per-item success rates of two arms from run records {task, variant, hiddenPassed, hiddenTotal}. */
function itemRates(records, a, b) {
  const items = [...new Set(records.map((r) => r.task))].sort();
  const rate = (task, v) => {
    const rs = records.filter((r) => r.task === task && r.variant === v);
    return rs.length ? rs.filter((r) => r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal).length / rs.length : null;
  };
  return items.map((task) => ({ task, a: rate(task, a), b: rate(task, b) })).filter((x) => x.a !== null && x.b !== null);
}

/** Two-sided sign-flip permutation test on paired differences; statistic = mean difference. */
function pairedPermutation(diffs, { resamples = 20000, seed = 42 } = {}) {
  const k = diffs.length;
  if (!k) return { k, mean: null, p: null, exact: true, resamples: 0 };
  const observed = Math.abs(diffs.reduce((s, d) => s + d, 0));
  let count = 0;
  let total;
  if (k <= 20) {
    total = 1 << k;
    for (let mask = 0; mask < total; mask++) {
      let s = 0;
      for (let i = 0; i < k; i++) s += (mask >> i) & 1 ? -diffs[i] : diffs[i];
      if (Math.abs(s) >= observed - 1e-12) count += 1;
    }
  } else {
    const rnd = mulberry32(seed);
    total = resamples;
    for (let r = 0; r < resamples; r++) {
      let s = 0;
      for (let i = 0; i < k; i++) s += rnd() < 0.5 ? -diffs[i] : diffs[i];
      if (Math.abs(s) >= observed - 1e-12) count += 1;
    }
  }
  return { k, mean: diffs.reduce((s, d) => s + d, 0) / k, p: count / total, exact: k <= 20, resamples: k <= 20 ? total : resamples };
}

// -------------------------------------------------------------- check

const GRID = (() => {
  const pts = [];
  const n = 80;
  const lo = -5;
  const hi = 5;
  const h = (hi - lo) / n;
  for (let i = 0; i < n; i++) {
    const u = lo + (i + 0.5) * h;
    pts.push({ u, w: (h * Math.exp(-0.5 * u * u)) / Math.sqrt(2 * Math.PI) });
  }
  return pts;
})();

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

/** Marginal log-likelihood of {items: [{rows: [{arm, y}]}]} at (b0, b1, logSigma). */
function logLik(items, [b0, b1, logSigma], fixB1 = null) {
  const s = Math.exp(logSigma);
  const beta1 = fixB1 === null ? b1 : fixB1;
  let ll = 0;
  for (const it of items) {
    let integral = 0;
    for (const { u, w } of GRID) {
      let lp = 0;
      for (const r of it.rows) {
        const p = logistic(b0 + beta1 * r.arm + s * u);
        lp += r.y ? Math.log(p + 1e-300) : Math.log(1 - p + 1e-300);
      }
      integral += w * Math.exp(lp);
    }
    ll += Math.log(integral + 1e-300);
  }
  return ll;
}

/** Nelder–Mead minimisation of f from x0. */
function nelderMead(f, x0, { steps = 600, scale = 0.5 } = {}) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += scale;
    simplex.push(x);
  }
  let vals = simplex.map(f);
  for (let it = 0; it < steps; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map((i) => simplex[i]);
    vals = order.map((i) => vals[i]);
    const centroid = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const reflect = centroid.map((c, j) => c + (c - worst[j]));
    const fr = f(reflect);
    if (fr < vals[0]) {
      const expand = centroid.map((c, j) => c + 2 * (c - worst[j]));
      const fe = f(expand);
      if (fe < fr) { simplex[n] = expand; vals[n] = fe; } else { simplex[n] = reflect; vals[n] = fr; }
    } else if (fr < vals[n - 1]) {
      simplex[n] = reflect; vals[n] = fr;
    } else {
      const contract = centroid.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = f(contract);
      if (fc < vals[n]) { simplex[n] = contract; vals[n] = fc; } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((x, j) => simplex[0][j] + 0.5 * (x - simplex[0][j]));
          vals[i] = f(simplex[i]);
        }
      }
    }
    if (Math.abs(vals[n] - vals[0]) < 1e-9) break;
  }
  const best = vals.indexOf(Math.min(...vals));
  return { x: simplex[best], f: vals[best] };
}

function chi2sf1(x) {
  // Survival function of chi-square with 1 df: erfc(sqrt(x/2)).
  const z = Math.sqrt(x / 2);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return r;
}

/** Random-intercept logistic regression: rows {item, arm, y}. Returns {b0, b1, sigma, lrt, p}. */
function mixedLogit(rows) {
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.item)) byItem.set(r.item, { rows: [] });
    byItem.get(r.item).rows.push({ arm: r.arm ? 1 : 0, y: r.y ? 1 : 0 });
  }
  const items = [...byItem.values()];
  const full = nelderMead((x) => -logLik(items, x), [0, 0, 0]);
  const null0 = nelderMead((x) => -logLik(items, [x[0], 0, x[1]], 0), [0, 0]);
  const lrt = Math.max(0, 2 * (null0.f - full.f));
  return { b0: full.x[0], b1: full.x[1], sigma: Math.exp(full.x[2]), lrt, p: chi2sf1(lrt), items: items.length, runs: rows.length };
}

// -------------------------------------------------------------- power

function normal(rnd) {
  const u = Math.max(rnd(), 1e-12);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Power of the item-level permutation test (and of McNemar on runs, for
 * comparison) by simulation. Each item draws a logit intercept u ~ N(mu, tau^2)
 * with mu = logit(meanBare); the treated arm adds deltaLogit; each arm gets
 * `runs` Bernoulli runs per item.
 */
function powerSimulation({ items, runs = 6, meanBare = 0.5, deltaLogit = Math.log(2), tau = 1.0, sims = 400, seed = 7, alpha = 0.05 } = {}) {
  const rnd = mulberry32(seed);
  const mu = Math.log(meanBare / (1 - meanBare));
  let hits = 0;
  let mcHits = 0;
  let discordance = 0;
  for (let s = 0; s < sims; s++) {
    const diffs = [];
    const pairs = [];
    for (let i = 0; i < items; i++) {
      const u = mu + tau * normal(rnd);
      const pb = logistic(u);
      const pt = logistic(u + deltaLogit);
      let sb = 0;
      let st = 0;
      for (let r = 0; r < runs; r++) {
        const yb = rnd() < pb ? 1 : 0;
        const yt = rnd() < pt ? 1 : 0;
        sb += yb;
        st += yt;
        pairs.push([yt, yb]);
      }
      diffs.push(st / runs - sb / runs);
    }
    const t = pairedPermutation(diffs, { resamples: 2000, seed: s + 1 });
    if (t.p < alpha) hits += 1;
    const m = mcnemar(pairs);
    if (m.p < alpha) mcHits += 1;
    discordance += m.n / pairs.length;
  }
  return { items, runs, tau, meanBare, deltaLogit, sims, power: hits / sims, mcnemarPower: mcHits / sims, discordance: discordance / sims };
}

/** The smallest item count whose simulated power reaches `target`. */
function minimumItems({ target = 0.8, from = 5, to = 60, step = 1, ...opts } = {}) {
  const rows = [];
  let found = null;
  for (let k = from; k <= to; k += step) {
    const r = powerSimulation({ ...opts, items: k });
    rows.push(r);
    if (found === null && r.power >= target) found = k;
    if (found !== null && k >= found + 2 * step) break;
  }
  return { minimum: found, rows };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
  if (argv[0] === 'power') {
    const runs = Number(flag('runs', 6));
    const sims = Number(flag('sims', 400));
    const meanBare = Number(flag('bare', 0.5));
    const deltaLogit = Math.log(Number(flag('odds', 2)));
    for (const tau of String(flag('tau', '0.5,1.0,1.5')).split(',').map(Number)) {
      const m = minimumItems({ runs, sims, tau, meanBare, deltaLogit, step: 1 });
      process.stdout.write(`tau ${tau}: minimum ${m.minimum === null ? 'not reached by 60' : m.minimum} items at ${runs} runs/arm/item (bare ${meanBare}, odds ratio ${Math.exp(deltaLogit).toFixed(2)}, ${sims} sims)\n`);
      for (const r of m.rows) process.stdout.write(`  items ${String(r.items).padStart(2)}: permutation power ${r.power.toFixed(3)}  McNemar-on-runs power ${r.mcnemarPower.toFixed(3)}  discordance ${r.discordance.toFixed(2)}\n`);
    }
  } else if (argv[0] === 'analyze') {
    const records = fs.readFileSync(argv[1], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.task && r.variant && typeof r.hiddenTotal === 'number');
    const a = flag('a', 'debug');
    const b = flag('b', 'without');
    const rates = itemRates(records, a, b);
    const perm = pairedPermutation(rates.map((x) => x.a - x.b));
    const rows = records.filter((r) => [a, b].includes(r.variant)).map((r) => ({ item: r.task, arm: r.variant === a ? 1 : 0, y: r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal ? 1 : 0 }));
    const glmm = mixedLogit(rows);
    const byItem = new Map();
    for (const r of records) {
      if (![a, b].includes(r.variant)) continue;
      const k = r.task;
      if (!byItem.has(k)) byItem.set(k, { a: [], b: [] });
      byItem.get(k)[r.variant === a ? 'a' : 'b'].push(r.hiddenTotal > 0 && r.hiddenPassed === r.hiddenTotal ? 1 : 0);
    }
    const pairs = [...byItem.values()].flatMap((x) => x.a.map((y, i) => [y, x.b[i] === undefined ? 0 : x.b[i]]).filter((_, i) => x.b[i] !== undefined));
    const mc = mcnemar(pairs);
    process.stdout.write(`${a} vs ${b}: ${rates.length} items\n`);
    for (const x of rates) process.stdout.write(`  ${x.task}: ${a} ${x.a.toFixed(2)}  ${b} ${x.b.toFixed(2)}  diff ${(x.a - x.b).toFixed(2)}\n`);
    process.stdout.write(`PRIMARY paired permutation (item level): mean difference ${perm.mean.toFixed(3)}, two-sided p ${perm.p.toFixed(4)} (${perm.exact ? 'exact' : `${perm.resamples} resamples`})\n`);
    process.stdout.write(`CHECK mixed-effects logit (item random intercept): b1 ${glmm.b1.toFixed(3)} (odds ratio ${Math.exp(glmm.b1).toFixed(2)}), sigma ${glmm.sigma.toFixed(2)}, LRT ${glmm.lrt.toFixed(2)}, p ${glmm.p.toFixed(4)}\n`);
    process.stdout.write(`SECONDARY McNemar on runs (not the decision): b ${mc.b}, c ${mc.c}, p ${mc.p.toFixed(4)}\n`);
  } else {
    process.stderr.write('usage: phase2-analysis.js power [--tau 0.5,1.0,1.5] [--runs 6] [--sims 400] [--bare 0.5] [--odds 2] | analyze <runs.jsonl> --a <arm> --b <arm>\n');
    process.exit(2);
  }
}

module.exports = { itemRates, pairedPermutation, mixedLogit, powerSimulation, minimumItems, logLik, nelderMead };
