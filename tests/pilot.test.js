'use strict';
// The big-project pilot's harness: hidden files exported from the source
// mirror, task setup, per-track prompts, chain mode, transcripts and refusal
// extraction, and the pure logic of the Part A measurement scripts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const bench = require('../lib/bench');

/** A local origin with two commits: "before" (agent-era) and "after" (the fix and its test). */
function origin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-origin-'));
  const g = (args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  g(['init', '-q']);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'tests', 'test_x.py'), 'before\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'before']);
  const before = g(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(dir, 'tests', 'test_x.py'), 'upstream\n');
  fs.writeFileSync(path.join(dir, 'tests', 'test_y.py'), 'other\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'after']);
  return { dir, before, after: g(['rev-parse', 'HEAD']) };
}

/** Run fn with ECCODE_BENCH_CACHE pointed at a fresh directory. */
function withCache(fn) {
  const saved = process.env.ECCODE_BENCH_CACHE;
  process.env.ECCODE_BENCH_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-cache-'));
  try {
    return fn();
  } finally {
    fs.rmSync(process.env.ECCODE_BENCH_CACHE, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ECCODE_BENCH_CACHE;
    else process.env.ECCODE_BENCH_CACHE = saved;
  }
}

/** A one-task suite whose source is the origin's "before" commit. */
function suiteWith(o, fields) {
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-suite-'));
  const dir = path.join(suite, 't1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id: 't1', source: { repo: o.dir, commit: o.before }, prompt: 'Change it.', ...fields }));
  return bench.listTasks(suite)[0];
}

test('exportPaths writes only the named files at the commit', () => withCache(() => {
  const o = origin();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-export-'));
  const written = bench.exportPaths({ repo: o.dir, commit: o.after }, ['tests/test_x.py'], dest);
  assert.deepStrictEqual(written, ['tests/test_x.py']);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'tests', 'test_x.py'), 'utf8'), 'upstream\n');
  assert.ok(!fs.existsSync(path.join(dest, 'tests', 'test_y.py')), 'an unnamed file is not written');
  assert.ok(!fs.existsSync(path.join(dest, 'src')), 'nothing else of the commit is written');
}));

test('exportPaths names a missing path', () => withCache(() => {
  const o = origin();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-export-'));
  assert.throws(() => bench.exportPaths({ repo: o.dir, commit: o.after }, ['tests/test_x.py', 'tests/nope.py'], dest), /tests\/nope\.py/);
}));

test("fromSource overwrites the agent's file", () => withCache(() => {
  const o = origin();
  const task = suiteWith(o, { hidden: { fromSource: { commit: o.after, paths: ['tests/test_x.py'] } } });
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-sandbox-'));
  fs.mkdirSync(path.join(sandbox, 'tests'));
  fs.writeFileSync(path.join(sandbox, 'tests', 'test_x.py'), 'agent\n');
  bench.placeHidden(task, sandbox);
  assert.strictEqual(fs.readFileSync(path.join(sandbox, 'tests', 'test_x.py'), 'utf8'), 'upstream\n');
}));

test('task.setup runs before the agent with ECCODE_BENCH_TASK_DIR', () => withCache(() => {
  const o = origin();
  const task = suiteWith(o, {
    setup: 'node -e "require(\'fs\').writeFileSync(\'setup.txt\', process.env.ECCODE_BENCH_TASK_DIR)"',
    hiddenChecks: [{ id: 'saw', command: 'node -e "process.exit(require(\'fs\').readFileSync(\'agent-saw.txt\', \'utf8\') === process.argv[1] ? 0 : 1)" "$EXPECT"' }],
    env: { EXPECT: '${ECCODE_TEST_EXPECT}' },
  });
  process.env.ECCODE_TEST_EXPECT = task.dir;
  try {
    const record = bench.runOnce(task, { agentCmd: 'node -e "require(\'fs\').copyFileSync(\'setup.txt\', \'agent-saw.txt\')"', variant: 'without' });
    assert.strictEqual(record.setup.ok, true);
    assert.strictEqual(record.hiddenPassed, 1, JSON.stringify(record.checks));
    assert.ok(!record.patch.includes('setup.txt'), "the setup's output is part of the starting point, not the agent's change");
  } finally {
    delete process.env.ECCODE_TEST_EXPECT;
  }
}));

test('a failing setup skips the agent', () => withCache(() => {
  const o = origin();
  const task = suiteWith(o, { setup: 'exit 3', hiddenChecks: [{ id: 'any', command: 'true' }] });
  const record = bench.runOnce(task, { agentCmd: 'node -e "require(\'fs\').writeFileSync(\'marker\', \'ran\')"', variant: 'without', keep: true });
  try {
    assert.strictEqual(record.setup.ok, false);
    assert.ok(!fs.existsSync(path.join(record.sandbox, 'marker')), 'the agent did not run');
    assert.strictEqual(record.hiddenPassed, 0, 'a run whose setup failed counts as a failure');
    assert.strictEqual(record.hiddenTotal, 1);
  } finally {
    fs.rmSync(record.sandbox, { recursive: true, force: true });
  }
}));
