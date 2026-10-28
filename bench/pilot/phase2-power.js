'use strict';
// Sample size for McNemar's test (H-A, bench/protocols/2026-10-28-phase2.md):
// Connor's (1987) formula for paired binary outcomes. p10 is the probability
// that the Phase 2 arm passes and the bare arm fails on a pair, p01 the
// reverse; psi = p10 + p01 is the discordance, delta = p10 - p01 the effect.
//   n = (z_{a/2} sqrt(psi) + z_b sqrt(psi - delta^2))^2 / delta^2
// Usage: node bench/pilot/phase2-power.js [p10 p01 [runsPerItem]]
function z(p) {
  // Inverse normal CDF (Acklam's rational approximation; |error| < 1.2e-9).
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q;
  let r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function pairsNeeded({ p10, p01, alpha = 0.05, power = 0.8 }) {
  const psi = p10 + p01;
  const delta = p10 - p01;
  if (delta <= 0) throw new Error('p10 must exceed p01');
  const n = Math.pow(z(1 - alpha / 2) * Math.sqrt(psi) + z(power) * Math.sqrt(psi - delta * delta), 2) / (delta * delta);
  return { psi, delta, pairs: Math.ceil(n) };
}

function table(runsPerItem = 6) {
  const rows = [
    { label: 'multi-file run as observed (engine 12/18, bare 9/18; p10 0.30, p01 0.13)', p10: 0.30, p01: 0.13 },
    { label: 'moderate effect (p10 0.35, p01 0.10)', p10: 0.35, p01: 0.10 },
    { label: 'large effect (p10 0.40, p01 0.05)', p10: 0.40, p01: 0.05 },
    { label: 'small effect (p10 0.25, p01 0.15)', p10: 0.25, p01: 0.15 },
  ];
  return rows.map((r) => {
    const n = pairsNeeded(r);
    return { ...r, ...n, items: Math.ceil(n.pairs / runsPerItem) };
  });
}

if (require.main === module) {
  const [p10, p01, runs] = process.argv.slice(2).map(Number);
  const rows = p10 ? [{ label: `p10 ${p10}, p01 ${p01}`, p10, p01, ...pairsNeeded({ p10, p01 }), items: Math.ceil(pairsNeeded({ p10, p01 }).pairs / (runs || 6)) }] : table(runs || 6);
  for (const r of rows) process.stdout.write(`${r.label}: discordance ${r.psi.toFixed(2)}, effect ${r.delta.toFixed(2)} -> ${r.pairs} pairs = ${r.items} hard items at ${runs || 6} runs per arm per item (alpha 0.05, power 0.8)\n`);
}

module.exports = { z, pairsNeeded, table };
