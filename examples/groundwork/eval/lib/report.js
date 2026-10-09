// Report rendering (spec 8.4). One report per provider; fallback and CLI results are never merged.
export const ARCH11_LINE = 'Thresholds are unattended defaults, Q3; changes need a recorded user decision.';

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const iv = (w) => (w && w.rate !== null ? `${pct(w.rate)} [${pct(w.lo)}, ${pct(w.hi)}] (${w.k}/${w.n})` : 'n/a');

function metricLine(name, m) {
  if (!m) return `${name}: not applicable`;
  const parts = [`${name}: ${m.verdict}`];
  if (m.display) parts.push(m.display);
  return parts.join('  ');
}

export function renderText(r) {
  const L = [];
  L.push(`GROUNDWORK EVAL REPORT  provider=${r.provider}  set=${r.set}  ${r.holdout ? 'HOLDOUT' : 'tune'}`);
  L.push(ARCH11_LINE);
  if (r.provider === 'cli') L.push('Live numbers below come from the Claude Code CLI (`claude -p`) only; fallback results are reported separately.');
  if (r.provider === 'fallback') L.push('Fallback extractor results: no model involved; they say nothing about model quality.');
  L.push(`cliVersion=${r.cliVersion ?? 'n/a'} model=${r.models.join(',') || 'n/a'} promptVersion=${r.promptVersion} gitCommit=${r.gitCommit} manifestHash=${r.manifestHash ?? 'n/a'}`);
  L.push(`repetitions=${r.reps}${r.officialReps ? '' : ' (NON-STANDARD, not an official run)'} at=${r.at}`);
  L.push(`VERDICT: ${r.verdict}${r.note ? `  (${r.note})` : ''}`);
  L.push('');
  for (const k of ['m1', 'm1b', 'm1c', 'm2', 'm3', 'm4', 'm5']) L.push(metricLine(k.toUpperCase(), r.metrics[k]));
  if (r.perRep?.length) {
    L.push('');
    L.push('Per repetition (M1 / M2 / M3):');
    r.perRep.forEach((p, i) => L.push(`  rep ${i + 1}: ${pct(p.m1)} / ${pct(p.m2)} / ${pct(p.m3)}`));
  }
  if (r.usage) {
    const u = r.usage;
    L.push('');
    L.push(`Usage: calls=${u.calls} failed=${u.failedCalls} inputTokens=${u.inputTokens} outputTokens=${u.outputTokens} costUsd=${u.costUsd.toFixed(4)} costUpperBoundUsd=${u.costUpperBoundUsd.toFixed(4)} cap=${u.capUsd}`);
    if (u.latencyMs) L.push(`Latency ms: mean=${Math.round(u.latencyMs.mean)} p95=${Math.round(u.latencyMs.p95)}`);
    if (r.budget) L.push(`Budget: logged before run USD ${r.budget.loggedUsd.toFixed(4)} of total cap ${r.budget.totalCapUsd}`);
  }
  if (r.failures?.length) {
    L.push('');
    L.push(`Provider failures (scored as no output): ${r.failures.map((f) => `${f.code}x${f.count}`).join(', ')}`);
  }
  if (r.miss) {
    L.push('');
    L.push('M1 miss explained:');
    L.push(`  top reason codes: ${r.miss.codes.map((c) => `${c.key}=${c.count}`).join(', ') || 'none'}`);
    L.push(`  top tokens: ${r.miss.tokens.map((c) => `${c.key}=${c.count}`).join(', ') || 'none'}`);
    L.push(`  lowest-scoring incidents: ${r.miss.lowest.map((c) => `${c.id}=${pct(c.m1)}`).join(', ')}`);
  }
  if (r.m1bMissed?.length) L.push(`M1b missed fabrications: ${r.m1bMissed.map((m) => m.id).join(', ')}`);
  if (r.m1cFalseFlags?.length) L.push(`M1c false flags: ${r.m1cFalseFlags.slice(0, 10).map((m) => `${m.id}[${m.reasons}]`).join('; ')}`);
  if (r.notes?.length) { L.push(''); for (const n of r.notes) L.push(`Note: ${n}`); }
  return `${L.join('\n')}\n`;
}
