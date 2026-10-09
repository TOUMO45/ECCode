// Budget guard and run logs (spec 8.2). Logs are JSON lines, committed.
import fs from 'node:fs';

export function readLog(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* ignore a torn line; never crash the guard */ }
  }
  return out;
}

export function appendLog(file, rec) {
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

export const MAX_FULL_TUNE_CLI_RUNS = 8;
export const MAX_HOLDOUT_RUNS = 3;

// run.js writes PASS, FAIL or INCOMPLETE; COMPLETE is kept for old fixtures. NOT_RUN made no model calls and is not counted.
const isFullTune = (e) => e.provider === 'cli' && e.holdout === false && e.set === 'all' && ['PASS', 'FAIL', 'INCOMPLETE', 'COMPLETE'].includes(e.status);

/**
 * Decides whether a CLI run may start.
 * @returns {{ok:boolean, reason?:string, loggedUsd:number, fullTuneRuns:number}}
 */
export function checkBudget({ usage, runCapUsd, totalCapUsd, holdout, isFull }) {
  // costUpperBoundUsd (measured spend plus the per-call cap for calls whose cost is unknown) wins over costUsd.
  const cost = (e) => [e.costUpperBoundUsd, e.costUsd].find((v) => Number.isFinite(v)) ?? 0;
  const loggedUsd = usage.reduce((a, e) => a + cost(e), 0);
  const fullTuneRuns = usage.filter(isFullTune).length;
  if (loggedUsd + runCapUsd > totalCapUsd) {
    return { ok: false, loggedUsd, fullTuneRuns, reason: `logged USD ${loggedUsd.toFixed(4)} + run cap USD ${runCapUsd} exceeds total cap USD ${totalCapUsd}` };
  }
  if (!holdout && isFull && fullTuneRuns >= MAX_FULL_TUNE_CLI_RUNS) {
    return { ok: false, loggedUsd, fullTuneRuns, reason: `${fullTuneRuns} full tune CLI runs already logged (max ${MAX_FULL_TUNE_CLI_RUNS})` };
  }
  return { ok: true, loggedUsd, fullTuneRuns };
}

/** Holdout cap per provider (applies to fallback too). */
export function checkHoldoutCap(entries, provider) {
  const n = entries.filter((e) => e.provider === provider).length;
  return n >= MAX_HOLDOUT_RUNS ? { ok: false, count: n, reason: `holdout cap reached for ${provider}: ${n} of ${MAX_HOLDOUT_RUNS} runs logged` } : { ok: true, count: n };
}

/**
 * Run-level spend tracker. A failed call may have cost money the provider could not report,
 * so each failure is charged at the per-call cap in the upper bound (which drives `exhausted`).
 */
export function createTracker(capUsd, perCallCapUsd) {
  const t = { calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const upper = () => t.costUsd + t.failedCalls * perCallCapUsd;
  return {
    totals: t,
    add(u) {
      t.calls += 1;
      t.inputTokens += u?.inputTokens ?? 0;
      t.outputTokens += u?.outputTokens ?? 0;
      t.costUsd += u?.costUsd ?? 0;
    },
    fail() {
      t.calls += 1;
      t.failedCalls += 1;
    },
    upperBound: upper,
    exhausted: () => upper() >= capUsd,
  };
}
