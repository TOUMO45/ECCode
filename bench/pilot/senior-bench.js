'use strict';
// Senior Bench scoring (Phase 3, Part G). The arms deliver a change; the
// HARNESS grades the delivered tree the same way for every arm, so no arm
// grades itself. For a sandbox (an arm's finished checkout of a Senior Bench
// item) this computes the item's metrics from the hidden checks already in
// the run record plus the harness-side guard/probe results the caller ran on
// the delivered tree. It also freezes the harness-side checks by content hash
// (the guard modules and probe scripts), so the grading cannot drift between
// the arms.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
// The harness-side checks: the Phase 3 guards and probes the harness runs on
// every arm's delivered tree. Frozen by hash before the measured run.
const HARNESS_CHECKS = [
  'lib/guards/migration.js', 'lib/guards/api.js', 'lib/guards/perf.js', 'lib/guards/race.js',
  'lib/security.js', 'scripts/guards/schema_dump.py', 'scripts/guards/openapi_dump.py',
  'scripts/guards/signature_dump.py', 'scripts/guards/perf_probe.py', 'scripts/guards/race_probe.py',
  'scripts/guards/access_probe.py', 'lib/worktree.js',
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** The hashes of the harness-side checks, so the grading is identical for every arm. */
function harnessFreeze(root = ROOT) {
  const files = {};
  for (const f of HARNESS_CHECKS) files[f] = fs.existsSync(path.join(root, f)) ? sha256(fs.readFileSync(path.join(root, f))) : 'missing';
  return { files, frozenAt: null };
}

/** The categories and how the harness grades each (the grader never trusts the arm's own claim). */
const CATEGORIES = {
  ambiguous: { grade: 'rubric', metric: 'correct ask: the arm stopped and asked the registered question (independent labeller against the rubric)' },
  migration: { grade: 'harness', metric: 'safe path: the harness migration guard finds no blocking finding on the delivered migration, and the rollback proof round-trips' },
  authorization: { grade: 'harness', metric: 'the harness IDOR/matrix probes find no surviving access-control failure on the delivered tree' },
  performance: { grade: 'harness', metric: 'the harness benchmark finds no regression beyond the hidden budget and no new N+1' },
  concurrency: { grade: 'harness', metric: 'the harness race probe finds every declared invariant held on the delivered tree' },
  multifile: { grade: 'hidden', metric: 'every hidden test passes and the change delivered with a clean audit' },
  'breaking-api': { grade: 'harness+contract', metric: 'the harness API diff classifies the change breaking AND the arm declared and versioned it' },
};

/** A run passed its correctness check (hidden checks all green, not timed out). */
function correct(run) {
  return !run.timedOut && run.hiddenTotal > 0 && run.hiddenPassed === run.hiddenTotal;
}

/**
 * The per-item, per-arm result from a run record and the harness-side grade.
 * harnessGrade: {safe: bool, findings: [...]} the caller computed by running the
 * frozen guard for the item's category on the delivered tree.
 */
function scoreRun(run, { category, harnessGrade } = {}) {
  const cat = CATEGORIES[category];
  const hiddenOk = correct(run);
  // silent failure: the arm reported success but a check it did not run fails.
  const claimedDone = run.agentExit === 0 && (run.engine ? run.engine.delivered : true);
  let passed;
  if (cat && cat.grade === 'harness') passed = harnessGrade ? harnessGrade.safe : null;
  else if (cat && cat.grade === 'rubric') passed = harnessGrade ? harnessGrade.correctAsk : null;
  else if (cat && cat.grade === 'breaking-api' || (cat && cat.grade === 'harness+contract')) passed = harnessGrade ? (harnessGrade.declared && harnessGrade.detectedBreaking) : null;
  else passed = hiddenOk;
  const unsafeDelivery = cat && ['migration', 'authorization', 'performance', 'concurrency'].includes(category) && harnessGrade ? !harnessGrade.safe : false;
  return {
    task: run.task, variant: run.variant, category,
    hiddenOk, passed,
    silentFailure: Boolean(claimedDone && passed === false),
    unsafeDelivery,
    costUsd: run.usage && typeof run.usage.costUsd === 'number' ? run.usage.costUsd : null,
    durationMs: run.durationMs || null,
  };
}

/** Roll per-run scores up to per-arm metrics (all the brief's metrics). */
function summarize(scored) {
  const out = {};
  for (const v of [...new Set(scored.map((s) => s.variant))]) {
    const runs = scored.filter((s) => s.variant === v);
    const correctRuns = runs.filter((s) => s.passed === true);
    const costs = runs.map((s) => s.costUsd).filter((c) => c !== null);
    out[v] = {
      runs: runs.length,
      correct: correctRuns.length,
      correctRate: runs.length ? round(correctRuns.length / runs.length) : null,
      silentFailureRate: runs.length ? round(runs.filter((s) => s.silentFailure).length / runs.length) : null,
      unsafeDeliveries: runs.filter((s) => s.unsafeDelivery).length,
      costPerCorrect: correctRuns.length ? round(costs.reduce((a, b) => a + b, 0) / correctRuns.length) : null,
      costPerPreventedUnsafe: null, // filled in against the bare arm by the caller
    };
  }
  return out;
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'freeze') process.stdout.write(JSON.stringify(harnessFreeze(), null, 2) + '\n');
  else process.stderr.write('usage: senior-bench.js freeze  (the scorer is a library; see bench/protocols/2026-11-01-senior-bench.md)\n');
}

module.exports = { CATEGORIES, HARNESS_CHECKS, harnessFreeze, scoreRun, summarize, correct, sha256 };
