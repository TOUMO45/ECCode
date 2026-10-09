// Regression for F8: the full-tune cap must count the statuses eval/run.js really writes (PASS/FAIL/INCOMPLETE).
// Pure functions only: no network, no usage.log write, no holdout run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudget, checkHoldoutCap, MAX_FULL_TUNE_CLI_RUNS } from '../../eval/lib/budget.js';

const row = (status, over = {}) => ({ provider: 'cli', set: 'all', holdout: false, status, costUsd: 0.1, ...over });
const check = (usage, o = {}) => checkBudget({ usage, runCapUsd: 3, totalCapUsd: 40, holdout: false, isFull: true, ...o });

test('cap fires for real usage.log statuses PASS and FAIL', () => {
  const usage = Array.from({ length: MAX_FULL_TUNE_CLI_RUNS }, (_, i) => row(i % 2 ? 'FAIL' : 'PASS'));
  const g = check(usage);
  assert.equal(g.fullTuneRuns, MAX_FULL_TUNE_CLI_RUNS);
  assert.equal(g.ok, false);
  assert.match(g.reason, /full tune CLI runs already logged/);
});

test('INCOMPLETE counts; legacy COMPLETE still counts', () => {
  assert.equal(check([row('INCOMPLETE'), row('COMPLETE')]).fullTuneRuns, 2);
});

test('holdout, fallback, partial-set and NOT_RUN entries do not count', () => {
  const usage = [row('PASS', { holdout: true }), row('PASS', { provider: 'fallback' }), row('PASS', { set: 'm1' }), row('NOT_RUN')];
  assert.equal(check(usage).fullTuneRuns, 0);
});

test('below the cap is allowed; holdout and non-full checks are not blocked by the tune cap', () => {
  const full = Array.from({ length: 8 }, () => row('PASS'));
  assert.equal(check(full.slice(0, 7)).ok, true);
  assert.equal(check(full, { holdout: true }).ok, true);
  assert.equal(check(full, { isFull: false }).ok, true);
});

test('holdout cap logic is untouched', () => {
  assert.equal(checkHoldoutCap([{ provider: 'cli' }, { provider: 'cli' }], 'cli').ok, true);
});
