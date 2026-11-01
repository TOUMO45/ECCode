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
  const child = spawn(process.execPath, [CLI, 'bench', '--tasks', 'csv-sum', '--variant', 'without', '--runs', '2', '--agent', slow, '--save', save], { cwd: dir, env: { ...process.env, ECCODE_ROOT: dir }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const r = spawnSync(process.execPath, [CLI, 'bench', 'resume', '--save', save, '--agent', fast], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /complete: 2 run\(s\) recorded, 0 cut run\(s\) re-run/);
  const plain = path.join(dir, 'plain.jsonl');
  fs.writeFileSync(plain, JSON.stringify({ task: 'csv-sum', variant: 'without', hiddenPassed: 1, hiddenTotal: 1 }) + '\n');
  await assert.rejects(() => bench.resumeBatch({ save: plain, agentCmd: fast }), /no batch header/);
  fs.rmSync(dir, { recursive: true, force: true });
});
