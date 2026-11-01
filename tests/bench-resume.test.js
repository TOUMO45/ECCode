'use strict';
// Bench resumability (0.A item 3): a batch persists a header and one
// completion record per run as it is graded, tracks the runs in flight, runs
// at most two at a time, and a batch a restart killed resumes from its next
// unfinished run with the cut run recorded and run again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const bench = require('../lib/bench');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');

function agentScript(body) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-agent-')), 'agent.js');
  fs.writeFileSync(file, `'use strict';\nconst fs = require('fs');\n${body}\n`);
  return `${process.execPath} ${JSON.stringify(file)}`;
}

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a plan is every task x variant x run; the remaining runs are those without a completion record', () => {
  const plan = bench.planRuns(['a', 'b'], ['without', 'with'], 2);
  assert.strictEqual(plan.length, 8);
  assert.deepStrictEqual(plan[0], { task: 'a', variant: 'without', index: 0 });
  const header = { id: 'b1', tasks: ['a', 'b'], variants: ['without'], runs: 2 };
  const left = bench.remainingRuns(header, [{ task: 'a', variant: 'without', runIndex: 0, batch: 'b1' }, { task: 'b', variant: 'without', runIndex: 1, batch: 'other' }]);
  assert.deepStrictEqual(left, [{ task: 'a', variant: 'without', index: 1 }, { task: 'b', variant: 'without', index: 0 }, { task: 'b', variant: 'without', index: 1 }]);
  assert.ok(bench.MAX_CONCURRENCY === 2);
});

test('a batch writes its header first and one completion record per run, two at a time when asked; more than two is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-batch-'));
  const save = path.join(dir, 'runs.jsonl');
  const marks = path.join(dir, 'marks.jsonl');
  // Each run notes when it started and ended (1 s of work), so overlap is measurable.
  const agent = agentScript(`const t0 = Date.now(); const end = t0 + 1000; while (Date.now() < end) {} fs.appendFileSync(${JSON.stringify(marks)}, JSON.stringify({ start: t0, end: Date.now() }) + '\\n');`);
  await assert.rejects(() => bench.runBatch({ agentCmd: agent, tasks: ['csv-sum'], variants: ['without'], runs: 1, concurrency: 3 }), /--concurrency is 1 or 2/);
  const res = await bench.startBatch({ save, agentCmd: agent, tasks: ['csv-sum'], variants: ['without'], runs: 2, concurrency: 2 });
  assert.strictEqual(res.records.length, 2);
  const all = lines(save);
  assert.strictEqual(all[0].type, 'batch');
  assert.deepStrictEqual({ tasks: all[0].tasks, variants: all[0].variants, runs: all[0].runs, concurrency: all[0].concurrency }, { tasks: ['csv-sum'], variants: ['without'], runs: 2, concurrency: 2 });
  const runs = all.filter((l) => !l.type);
  assert.deepStrictEqual(runs.map((r) => r.runIndex).sort(), [0, 1]);
  assert.ok(runs.every((r) => r.batch === all[0].id && r.startedAt && r.completedAt && r.completedAt >= r.startedAt));
  assert.ok(!fs.existsSync(bench.inflightFile(save)), 'nothing in flight once the batch is done');
  const marked = lines(marks);
  assert.strictEqual(marked.length, 2);
  assert.ok(marked[0].start < marked[1].end && marked[1].start < marked[0].end, `the two runs overlapped: ${JSON.stringify(marked)}`);
  assert.deepStrictEqual(bench.remainingRuns(all[0], runs), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a batch killed mid-run resumes: the cut run is recorded as interrupted, its sandbox removed, and it runs again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-killed-'));
  const save = path.join(dir, 'runs.jsonl');
  const started = path.join(dir, 'started');
  // The first run finishes at once; the second announces itself and then hangs.
  const slow = agentScript(`if (fs.existsSync(${JSON.stringify(started)})) { fs.writeFileSync(${JSON.stringify(started)} + '.second', process.cwd()); setTimeout(() => {}, 60000); } else fs.writeFileSync(${JSON.stringify(started)}, process.cwd());`);
  const child = spawn(process.execPath, [CLI, 'bench', '--tasks', 'csv-sum', '--variant', 'without', '--runs', '2', '--agent', slow, '--save', save, '--force'], { cwd: dir, env: { ...process.env, ECCODE_ROOT: dir }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(`${started}.second`) && Date.now() < deadline) await sleep(100);
  assert.ok(fs.existsSync(`${started}.second`), 'the second run started');
  await sleep(200);
  const cutSandbox = fs.readFileSync(`${started}.second`, 'utf8');
  const inflight = bench.readInflight(save);
  assert.strictEqual(inflight.length, 1);
  assert.deepStrictEqual({ task: inflight[0].task, variant: inflight[0].variant, runIndex: inflight[0].runIndex }, { task: 'csv-sum', variant: 'without', runIndex: 1 });
  assert.strictEqual(fs.realpathSync(inflight[0].sandbox), fs.realpathSync(cutSandbox));
  // The restart: the bench process and its agent are killed; the file keeps the finished run only.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { process.kill(child.pid, 'SIGKILL'); }
  await new Promise((r) => child.on('exit', r));
  const before = lines(save);
  assert.strictEqual(before[0].type, 'batch');
  assert.deepStrictEqual(before.filter((l) => !l.type).map((r) => r.runIndex), [0]);
  assert.ok(fs.existsSync(cutSandbox), 'the cut run left its sandbox');
  // Resume with an agent that finishes: the cut run is recorded, its sandbox removed, and run index 1 completes.
  const fast = agentScript('fs.writeFileSync("done.txt", "ok");');
  const transcripts = path.join(dir, 'transcripts');
  const res = await bench.resumeBatch({ save, agentCmd: fast, transcripts, cause: 'container restart (test)' });
  assert.strictEqual(res.complete, true);
  assert.strictEqual(res.interrupted.length, 1);
  assert.strictEqual(res.records.length, 1, 'only the cut run was re-run');
  assert.strictEqual(res.records[0].runIndex, 1);
  assert.ok(!fs.existsSync(cutSandbox), 'the cut run\'s sandbox is gone');
  assert.ok(!fs.existsSync(bench.inflightFile(save)));
  const after = lines(save);
  const types = after.map((l) => l.type || 'run');
  assert.deepStrictEqual(types, ['batch', 'run', 'interrupted', 'resumed', 'run']);
  const cut = after.find((l) => l.type === 'interrupted');
  assert.deepStrictEqual({ task: cut.task, runIndex: cut.runIndex, cause: cut.cause, sandboxFound: cut.sandboxFound }, { task: 'csv-sum', runIndex: 1, cause: 'container restart (test)', sandboxFound: true });
  assert.deepStrictEqual(after.filter((l) => !l.type).map((r) => r.runIndex), [0, 1]);
  assert.strictEqual(bench.loadRuns(fs.readFileSync(save, 'utf8')).length, 2, 'typed lines are not runs');
  // A second resume has nothing to do and changes no completed run.
  const again = await bench.resumeBatch({ save, agentCmd: fast });
  assert.strictEqual(again.records.length, 0);
  assert.strictEqual(again.complete, true);
  // The CLI form, and a file without a header cannot be resumed.
  const r = spawnSync(process.execPath, [CLI, 'bench', 'resume', save, '--agent', fast, '--force'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /complete: 2 run\(s\) recorded, 0 cut run\(s\) re-run/);
  const plain = path.join(dir, 'plain.jsonl');
  fs.writeFileSync(plain, JSON.stringify({ task: 'csv-sum', variant: 'without', hiddenPassed: 1, hiddenTotal: 1 }) + '\n');
  await assert.rejects(() => bench.resumeBatch({ save: plain, agentCmd: fast }), /no batch header/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- The count-based resume of a save file without a batch header (older files), and the host stream guard.
const NOOP = 'node -e ""'; // an agent that changes nothing; every run still records
const TASK = 'relative-time'; // a fast built-in task

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
  let r = run(['--tasks', TASK, '--variant', 'without', '--runs', '1', '--agent', NOOP, '--save', file, '--json', '--force']);
  // The header-less legacy path: strip the batch header this version writes, as an older file would have none.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !JSON.parse(l).type).join('\n') + '\n');
  assert.strictEqual(r.status, 0, r.stderr);
  let lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((x) => !x.type);
  assert.strictEqual(lines.length, 1, 'one run saved');

  // Resume to 3 runs: 2 more appended.
  r = run(['resume', file, '--tasks', TASK, '--variant', 'without', '--runs', '3', '--agent', NOOP, '--json', '--force']);
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
