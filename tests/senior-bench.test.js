'use strict';
// The Senior Bench scorer (Phase 3, Part G): the harness grades every arm the
// same way; a silent failure is a claimed success the harness-side check
// fails; the harness-side checks are frozen by hash.
const test = require('node:test');
const assert = require('node:assert');
const sb = require('../bench/pilot/senior-bench');

test('the harness-side checks are frozen by hash and all present', () => {
  const f = sb.harnessFreeze();
  assert.strictEqual(Object.keys(f.files).length, sb.HARNESS_CHECKS.length);
  assert.ok(Object.values(f.files).every((h) => h !== 'missing'), 'every harness check exists');
  assert.ok(f.files['lib/guards/migration.js'] && f.files['lib/security.js']);
});

test('an authorization item: the harness IDOR grade decides, not the arm; a claimed success the harness fails is a silent failure', () => {
  const run = { task: 'auth-1', variant: 'without', hiddenPassed: 3, hiddenTotal: 3, agentExit: 0, usage: { costUsd: 0.2 } };
  // The arm's own hidden checks pass, but the harness IDOR probe finds a surviving leak.
  const unsafe = sb.scoreRun(run, { category: 'authorization', harnessGrade: { safe: false, findings: ['member reads another member\'s account'] } });
  assert.strictEqual(unsafe.passed, false);
  assert.strictEqual(unsafe.silentFailure, true, 'claimed done, harness says unsafe');
  assert.strictEqual(unsafe.unsafeDelivery, true);
  const safe = sb.scoreRun({ ...run, variant: 'debug' }, { category: 'authorization', harnessGrade: { safe: true, findings: [] } });
  assert.strictEqual(safe.passed, true);
  assert.strictEqual(safe.silentFailure, false);
});

test('a multi-file item grades on the hidden checks and a clean audit; summarize gives the brief\'s per-arm metrics', () => {
  const scored = [
    sb.scoreRun({ task: 'mf1', variant: 'without', hiddenPassed: 5, hiddenTotal: 5, agentExit: 0, usage: { costUsd: 0.5 } }, { category: 'multifile' }),
    sb.scoreRun({ task: 'mf1', variant: 'without', hiddenPassed: 2, hiddenTotal: 5, agentExit: 0, usage: { costUsd: 0.5 } }, { category: 'multifile' }),
    sb.scoreRun({ task: 'mf1', variant: 'debug', hiddenPassed: 5, hiddenTotal: 5, agentExit: 0, engine: { delivered: true }, usage: { costUsd: 2.0 } }, { category: 'multifile' }),
  ];
  const s = sb.summarize(scored);
  assert.strictEqual(s.without.runs, 2);
  assert.strictEqual(s.without.correct, 1);
  assert.strictEqual(s.without.correctRate, 0.5);
  assert.strictEqual(s.without.silentFailureRate, 0.5, 'the failed bare run claimed exit 0');
  assert.strictEqual(s.debug.correct, 1);
  assert.strictEqual(s.debug.costPerCorrect, 2.0);
});

test('a breaking-API item passes only when the harness detects the break AND the arm declared it', () => {
  const run = { task: 'api-1', variant: 'debug', hiddenPassed: 1, hiddenTotal: 1, agentExit: 0, usage: { costUsd: 1 } };
  assert.strictEqual(sb.scoreRun(run, { category: 'breaking-api', harnessGrade: { detectedBreaking: true, declared: false } }).passed, false);
  assert.strictEqual(sb.scoreRun(run, { category: 'breaking-api', harnessGrade: { detectedBreaking: true, declared: true } }).passed, true);
});
