'use strict';
// The H-B2 report (protocol amendment 4, step 7): per class and overall detections, misses and false positives
// with exact Clopper-Pearson intervals, the H-B rule, the intended-seed false positives apart, the miss list with
// its capability/configuration labels, and the paired comparison of the two pipelines. Aggregates only: the
// per-seed records stay in the archive outside the repository.
//   node bench/pilot/hb2/report.js --v2 <results.jsonl> [--v1 <results.jsonl>] [--labels <labels.json>] [--attribution <attribution.json>] [--out <aggregate.json>]
// labels.json:      { "<seed id>": { "label": "capability" | "configuration", "reason": "<why>" } }, assigned by hand after the results are recorded
// attribution.json: { "<seed id>": true | false }, whether a detection is on the operation the seed's author named
const fs = require('fs');

const LN = (() => {
  const t = [0];
  return (n) => { while (t.length <= n) t.push(t[t.length - 1] + Math.log(t.length)); return t[n]; };
})();

function pmf(i, n, p) {
  if (p <= 0) return i === 0 ? 1 : 0;
  if (p >= 1) return i === n ? 1 : 0;
  return Math.exp(LN(n) - LN(i) - LN(n - i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
}

/** P(X >= k) for X ~ Binomial(n, p): the one-sided exact test against a true rate of p. */
function binomialTailGE(k, n, p) {
  let s = 0;
  for (let i = k; i <= n; i++) s += pmf(i, n, p);
  return Math.min(1, s);
}

/** Smallest n for which n of n successes rejects a true rate of p0 at alpha (one-sided). */
function seedsToReject(p0 = 0.9, alpha = 0.05) {
  let n = 1;
  while (binomialTailGE(n, n, p0) >= alpha) n++;
  return n;
}

/** Exact two-sided Clopper-Pearson interval for k of n; [null, null] when n is 0. */
function clopperPearson(k, n, alpha = 0.05) {
  if (!n) return [null, null];
  const solve = (f) => { let lo = 0; let hi = 1; for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(mid)) hi = mid; else lo = mid; } return (lo + hi) / 2; };
  const lower = k === 0 ? 0 : solve((p) => binomialTailGE(k, n, p) >= alpha / 2);
  const upper = k === n ? 1 : solve((p) => 1 - binomialTailGE(k + 1, n, p) <= alpha / 2);
  return [lower, upper];
}

/** Exact two-sided sign test on discordant pairs (b against c). */
function signTest(b, c) {
  const n = b + c;
  if (!n) return 1;
  const m = Math.min(b, c);
  let s = 0;
  for (let i = 0; i <= m; i++) s += pmf(i, n, 0.5);
  return Math.min(1, 2 * s);
}

const round = (x, d = 4) => (x === null || x === undefined ? x : Math.round(x * 10 ** d) / 10 ** d);

function summarize(records, { labels = {}, attribution = null } = {}) {
  const unintended = records.filter((r) => !r.intended);
  const intended = records.filter((r) => r.intended);
  const flagged = unintended.filter((r) => r.flagged === true);
  const n = unintended.length;
  const rate = n ? flagged.length / n : null;
  const tail = binomialTailGE(flagged.length, n, 0.9);
  const allTail = n ? binomialTailGE(n, n, 0.9) : null;
  const canReject = n > 0 && allTail < 0.05;
  const statement = canReject
    ? `With ${n} unintended seeds, a result of ${n} of ${n} would reject a true rate of 0.90 at alpha 0.05 (p = ${round(allTail)}).`
    : `With ${n} unintended seeds the exact binomial cannot reject a true rate of 0.90 even if every seed is flagged (p = ${round(allTail)} at ${n} of ${n}); ${seedsToReject()} seeds would be needed.`;
  const kinds = [...new Set(records.map((r) => r.kind))].sort();
  const byClass = kinds.map((kind) => {
    const u = unintended.filter((r) => r.kind === kind);
    const i = intended.filter((r) => r.kind === kind);
    const uf = u.filter((r) => r.flagged === true).length;
    const ia = i.filter((r) => r.flagged === true).length;
    return { kind, unintended: { n: u.length, flagged: uf, ci: clopperPearson(uf, u.length) }, intended: { n: i.length, accepted: ia, ci: clopperPearson(ia, i.length) } };
  });
  const accepted = intended.filter((r) => r.flagged === true);
  const falsePositives = intended.filter((r) => r.flagged !== true && !r.error && r.unexplained > 0);
  const notVerifiable = intended.filter((r) => r.flagged !== true && !falsePositives.includes(r));
  const misses = unintended.filter((r) => r.flagged !== true).map((r) => ({
    id: r.id, kind: r.kind, reason: r.miss || r.error || 'unknown', route: r.route || null, probes: r.probes ?? null, executed: r.executed ?? null, coverage: r.coverage ?? null,
    label: (labels[r.id] && labels[r.id].label) || 'unlabelled', labelReason: (labels[r.id] && labels[r.id].reason) || null,
  }));
  const labelCounts = {};
  for (const m of misses) labelCounts[m.label] = (labelCounts[m.label] || 0) + 1;
  const out = {
    unintended: { n, flagged: flagged.length, missed: n - flagged.length, rate, ci: clopperPearson(flagged.length, n), threshold: 0.9, met: n > 0 && rate >= 0.9, binomialP: n ? tail : null, canReject, statement },
    intended: { n: intended.length, accepted: accepted.length, falsePositives: falsePositives.length, notVerifiable: notVerifiable.length, falsePositiveRate: intended.length ? falsePositives.length / intended.length : null, falsePositiveCi: clopperPearson(falsePositives.length, intended.length), acceptedCi: clopperPearson(accepted.length, intended.length) },
    byClass,
    misses,
    labelCounts,
  };
  if (attribution) {
    const attributed = flagged.filter((r) => attribution[r.id] === true).length;
    const elsewhere = flagged.filter((r) => attribution[r.id] === false).length;
    out.attribution = { attributed, flaggedElsewhere: elsewhere, unchecked: flagged.length - attributed - elsewhere };
  }
  return out;
}

/** The same seeds under two pipelines, paired: who flags what. */
function compare(a, b) {
  const ids = (x) => x.map((r) => r.id).sort().join(',');
  if (ids(a) !== ids(b)) throw new Error('compare needs the same seeds in both result files');
  const byId = new Map(b.map((r) => [r.id, r]));
  let both = 0; let onlyA = 0; let onlyB = 0; let neither = 0;
  for (const r of a) {
    const o = byId.get(r.id);
    const x = r.flagged === true; const y = o.flagged === true;
    if (x && y) both++; else if (x) onlyA++; else if (y) onlyB++; else neither++;
  }
  return { both, onlyV2: onlyA, onlyV1: onlyB, neither, signP: signTest(onlyA, onlyB) };
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function pct(x) { return x === null || x === undefined ? 'n/a' : `${round(x * 100, 1)}%`; }
function ci(c) { return c && c[0] !== null ? `[${pct(c[0])}, ${pct(c[1])}]` : 'n/a'; }

function text(name, s) {
  const u = s.unintended; const i = s.intended;
  const lines = [`== ${name}`];
  lines.push(`Unintended seeds: ${u.flagged} of ${u.n} flagged (${pct(u.rate)}, exact 95% ${ci(u.ci)}); missed ${u.missed}. H-B rule (>= 90%): ${u.met ? 'MET' : 'NOT MET'}; one-sided exact binomial against 0.90: p = ${round(u.binomialP)}.`);
  lines.push(`  ${u.statement}`);
  if (s.attribution) lines.push(`  Attribution of the ${u.flagged} detections: ${s.attribution.attributed} on the operation the author named, ${s.attribution.flaggedElsewhere} flagged elsewhere, ${s.attribution.unchecked} unchecked.`);
  lines.push(`INTENDED-SEED FALSE POSITIVES: ${i.falsePositives} of ${i.n} (${pct(i.falsePositiveRate)}, exact 95% ${ci(i.falsePositiveCi)}); accepted ${i.accepted}; not verifiable (coverage or error) ${i.notVerifiable}.`);
  lines.push('Per class (unintended flagged / n, exact 95%; intended accepted / n):');
  for (const c of s.byClass) lines.push(`  ${c.kind.padEnd(15)} ${c.unintended.flagged}/${c.unintended.n} ${ci(c.unintended.ci)}   intended ${c.intended.accepted}/${c.intended.n}`);
  lines.push(`Misses: ${s.misses.length} (${Object.entries(s.labelCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
  for (const m of s.misses) lines.push(`  ${m.id} [${m.kind}] ${m.label}: ${m.labelReason || m.reason} (route ${m.route}, probes ${m.probes}, executed ${m.executed}, coverage ${m.coverage})`);
  return lines.join('\n');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (!arg('--v2')) { process.stderr.write('usage: report.js --v2 <results.jsonl> [--v1 <results.jsonl>] [--labels <json>] [--attribution <json>] [--out <aggregate.json>]\n'); process.exit(2); }
  const read = (f) => (f ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined);
  const opts = { labels: read(arg('--labels')) || {}, attribution: read(arg('--attribution')) || null };
  const v2 = readJsonl(arg('--v2'));
  const result = { v2: summarize(v2, opts) };
  process.stdout.write(`${text('v2 (the H-B2 primary)', result.v2)}\n`);
  if (arg('--v1')) {
    const v1 = readJsonl(arg('--v1'));
    result.v1 = summarize(v1, opts);
    result.comparison = compare(v2.filter((r) => !r.intended), v1.filter((r) => !r.intended));
    process.stdout.write(`\n${text('v1 as registered (the comparison)', result.v1)}\n\nPaired, unintended seeds: both ${result.comparison.both}, only v2 ${result.comparison.onlyV2}, only v1 ${result.comparison.onlyV1}, neither ${result.comparison.neither}; exact sign test p = ${round(result.comparison.signP)}.\n`);
  }
  if (arg('--out')) {
    const aggregate = JSON.parse(JSON.stringify(result, (k, v) => (k === 'misses' ? undefined : v)));
    fs.writeFileSync(arg('--out'), JSON.stringify(aggregate, null, 2) + '\n');
  }
}

module.exports = { clopperPearson, binomialTailGE, seedsToReject, signTest, summarize, compare };
