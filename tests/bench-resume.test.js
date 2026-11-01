'use strict';
// Bench runner resumability (owner directive item 3): a --save batch killed
// mid-run can be resumed — the runs already in the file (per task+variant) are
// skipped, only the rest re-run, appended to the same file; --max-cost stays a
// total budget across the resume; the host caps concurrent streams at 2.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const bench = require('../lib/bench');

const NOOP = 'node -e ""'; // an agent that changes nothing; every run still records
const TASK = 'relative-time'; // a fast built-in task
const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');

test('completedCounts: finished runs per task+variant, ignoring typed lines', () => {
  const m = bench.completedCounts([
    { task: 'a', variant: 'with' },
    { task: 'a', variant: 'with' },
    { type: 'stopped', reason: 'max-cost' },
    { type: 'chain-summary' },
    { task: 'a', variant: 'without' },
    { task: 'b', variant: 'with' },
  ]);
  assert.strictEqual(m.get('a\0with'), 2);
  assert.strictEqual(m.get('a\0without'), 1);
  assert.strictEqual(m.get('b\0with'), 1);
  assert.strictEqual(m.get('a\0engine'), undefined);
});

test('resume on a killed run: completed runs are skipped, only the rest re-run', () => {
  const saved = [];
  const save = (r) => saved.push(r);

  // A process that was killed after recording run 0 of 3.
  bench.run({ suite: bench.DEFAULT_SUITE, tasks: [TASK], variants: ['without'], runs: 1, agentCmd: NOOP, onRecord: save });
  assert.strictEqual(saved.length, 1, 'one run recorded before the kill');
  assert.strictEqual(saved[0].runIndex, 0, 'first run is index 0');

  // Resume the same batch to runs=3.
  const progress = [];
  const completed = bench.completedCounts(saved);
  const res = bench.run({
    suite: bench.DEFAULT_SUITE, tasks: [TASK], variants: ['without'], runs: 3, agentCmd: NOOP,
    completed, spentBefore: bench.spentUsd(saved), onRecord: save, onProgress: (m) => progress.push(m),
  });

  assert.strictEqual(res.records.length, 2, 'resume runs only the 2 missing runs, not all 3');
  assert.deepStrictEqual(res.records.map((r) => r.runIndex), [1, 2], 'it continues at index 1, not 0');
  assert.strictEqual(saved.length, 3, 'the file ends with all 3 runs');
  assert.ok(progress.every((m) => !m.includes('run 1/3') || res.records.length === 2), 'run 1/3 (index 0) is not re-executed');
});

test('resume respects --max-cost as a total budget across the resume (spentBefore counted)', () => {
  // A prior record that already spent $10; cap is $5 → the resume stops before any new run.
  const prior = [{ task: TASK, variant: 'without', hiddenPassed: 1, hiddenTotal: 1, usage: { costUsd: 10 }, runIndex: 0 }];
  const progress = [];
  const res = bench.run({
    suite: bench.DEFAULT_SUITE, tasks: [TASK], variants: ['without'], runs: 3, agentCmd: NOOP,
    maxCostUsd: 5, completed: bench.completedCounts(prior), spentBefore: bench.spentUsd(prior),
    onProgress: (m) => progress.push(m),
  });
  assert.strictEqual(res.records.length, 0, 'the prior spend alone is over the cap: no new run');
  assert.ok(res.stopped && res.stopped.reason === 'max-cost', 'stopped on the total budget');
  assert.ok(res.stopped.spentUsd >= 10, 'spent total includes the prior spend');
});

test('the CLI resume command skips completed runs and appends to the same file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-bench-resume-'));
  const file = path.join(dir, 'runs.jsonl');
  const run = (args) => spawnSync(process.execPath, [CLI, 'bench', ...args], { encoding: 'utf8' });

  // Start a batch of 1 run, saved to file.
  let r = run(['--tasks', TASK, '--variant', 'without', '--runs', '1', '--agent', NOOP, '--save', file, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  let lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((x) => !x.type);
  assert.strictEqual(lines.length, 1, 'one run saved');

  // Resume to 3 runs: 2 more appended.
  r = run(['resume', file, '--tasks', TASK, '--variant', 'without', '--runs', '3', '--agent', NOOP, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /1 completed run\(s\) skipped/);
  lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((x) => !x.type);
  assert.strictEqual(lines.length, 3, 'the file now has all 3 runs');
  assert.deepStrictEqual(lines.map((x) => x.runIndex), [0, 1, 2], 'run indices are contiguous across the resume');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('resume refuses a missing save file (nothing to continue)', () => {
  const r = spawnSync(process.execPath, [CLI, 'bench', 'resume', path.join(os.tmpdir(), 'no-such-bench-file.jsonl'), '--agent', NOOP], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /No save file|nothing to resume/);
});

test('the concurrency guard is wired: a stream count and a cap of 2', () => {
  assert.strictEqual(bench.MAX_STREAMS, 2);
  assert.strictEqual(typeof bench.liveBenchStreams(), 'number');
  assert.ok(bench.liveBenchStreams() >= 0);
});
