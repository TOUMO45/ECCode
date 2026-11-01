'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cost = require('../bench/pilot/phase3-cost');

test('cost per correct change, per track: ratio to bare and the phase targets', () => {
  const rows = [
    { variant: 'without', task: 't1', hiddenPassed: 2, hiddenTotal: 2, usage: { costUsd: 0.10 } },
    { variant: 'without', task: 't1', hiddenPassed: 1, hiddenTotal: 2, usage: { costUsd: 0.10 } }, // a failed bare run still costs
    { variant: 'engine', task: 't1', hiddenPassed: 2, hiddenTotal: 2, usage: { costUsd: 0.12 } },
    { variant: 'debug', task: 't1', hiddenPassed: 2, hiddenTotal: 2, usage: { costUsd: 0.50 } },
    { variant: 'debug', task: 't1', hiddenPassed: 2, hiddenTotal: 2, usage: { costUsd: 0.50 } },
  ];
  const r = cost.report(rows);
  // bare: two runs, one correct, total $0.20 over 1 correct = $0.20.
  assert.strictEqual(r.bareCostPerCorrect, 0.2);
  // engine (quick): $0.12 / 1 correct = 0.12; 0.6x bare, within 1.5x.
  assert.ok(r.perVariant.engine.costPerCorrect === 0.12);
  // debug (fix): $1.00 / 2 correct = 0.50; 2.5x bare, within 4x.
  assert.strictEqual(r.perVariant.debug.costPerCorrect, 0.5);
  assert.match(r.text, /quick:.*within target/);
  assert.match(r.text, /fix \(Debugging Lab\):.*2\.5x bare.*within target/);
});

test('it reads real benchmark records and reports a ratio for each variant present', () => {
  const f = path.join(__dirname, '..', 'bench', 'realbugs-results', '2026-10-24-realbugs-sonnet.runs.jsonl');
  if (!fs.existsSync(f)) return;
  const r = cost.report(cost.load([f]));
  assert.ok(r.perVariant.without && r.perVariant.without.runs > 0);
  assert.ok(r.perVariant.debug, 'the realbugs batch has the debug track');
  assert.match(r.text, /Cost per correct change/);
});
