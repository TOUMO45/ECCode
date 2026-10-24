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
    // The expected value comes through the environment, not a shell argument: cmd.exe has no $NAME.
    hiddenChecks: [{ id: 'saw', command: 'node -e "process.exit(require(\'fs\').readFileSync(\'agent-saw.txt\', \'utf8\') === process.env.EXPECT ? 0 : 1)"' }],
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

// The texts the quick and debug variants have always used: changing them
// would change what earlier batches measured.
const QUICK_TEXT = [
  'This repository has the ECCode toolkit installed under .claude/. Deliver the change below through its quick track:',
  'follow .claude/commands/eccode/quick.md step by step, with `node .claude/eccode/bin/eccode.js` as the CLI and the ECCode',
  'subagents it names. The change is done when the delivery step succeeds.',
  '',
  'The change:',
  '',
].join('\n');
const DEBUG_TEXT = [
  'This repository has the ECCode toolkit installed under .claude/. Fix the bug below through its debug track:',
  'follow .claude/commands/eccode/debug.md step by step, with `node .claude/eccode/bin/eccode.js` as the CLI and the ECCode',
  'subagents it names. The fix is done when the delivery step succeeds.',
  '',
  'The bug:',
  '',
].join('\n');

test('enginePrompt keeps the quick and debug texts', () => {
  assert.strictEqual(bench.enginePrompt('engine'), QUICK_TEXT);
  assert.strictEqual(bench.enginePrompt('engine', 'quick'), QUICK_TEXT);
  assert.strictEqual(bench.enginePrompt('debug'), DEBUG_TEXT);
  assert.strictEqual(bench.enginePrompt('engine', 'debug'), DEBUG_TEXT);
});

test('enginePrompt names start.md and the track for fix, feature, refactor and greenfield', () => {
  for (const t of ['fix', 'feature', 'refactor', 'greenfield']) {
    const p = bench.enginePrompt('engine', t, { behavior: 'pytest -q' });
    assert.match(p, /\.claude\/commands\/eccode\/start\.md/, t);
    assert.ok(p.includes(`--track ${t}`), `${t}: names its track`);
    assert.match(p, /work start --track/, `${t}: says how to start the next work item on a delivered record`);
  }
});

test('the refactor prompt names its behavior command', () => {
  assert.ok(bench.enginePrompt('engine', 'refactor', { behavior: 'python -m pytest -q tests' }).includes('--behavior "python -m pytest -q tests"'));
  assert.ok(!bench.enginePrompt('engine', 'feature', { behavior: 'x' }).includes('--behavior'));
});

/** An upstream with three commits, one per chain item: u1, u2, u3. */
function chainOrigin({ withClaude = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-upstream-'));
  const g = (args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  g(['init', '-q']);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'check.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'chain', scripts: { test: 'node check.js' } }));
  const commits = [];
  for (const v of ['v1', 'v2', 'v3']) {
    fs.writeFileSync(path.join(dir, 'src', 'value.txt'), `${v}\n`);
    if (v === 'v2') fs.writeFileSync(path.join(dir, 'src', 'renamed-upstream.txt'), 'teammate file\n');
    if (withClaude && v === 'v2') {
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');
    }
    g(['add', '-A']);
    g(['commit', '-qm', v]);
    commits.push(g(['rev-parse', 'HEAD']));
  }
  return { dir, commits };
}

/** Tasks c1..c3 at the upstream's three commits; c1 has a hidden file. */
function chainTasks(o) {
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-chain-suite-'));
  ['c1', 'c2', 'c3'].forEach((id, i) => {
    const dir = path.join(suite, id);
    fs.mkdirSync(dir);
    if (id === 'c1') {
      fs.mkdirSync(path.join(dir, 'hidden'));
      fs.writeFileSync(path.join(dir, 'hidden', 'flag.txt'), 'hidden of c1\n');
    }
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
      id, order: i + 1, track: 'quick',
      source: { repo: o.dir, commit: o.commits[i] },
      prompt: `Item: ${id}\nAppend the item id to src/value.txt.`,
      hiddenChecks: [{ id: 'value', command: `node -e "process.exit(require('fs').readFileSync('src/value.txt','utf8').includes('${id}') ? 0 : 1)"` }],
    }));
  });
  return bench.listTasks(suite).sort((a, b) => a.order - b.order);
}

const CHAIN_AGENT = `node "${path.join(__dirname, 'bench-reference', 'chain', 'fake-chain-agent.js')}"`;

test('chain mode: three items on one record', async (t) => {
  const chain = require('../lib/chain');
  const obs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-obs-')), 'obs.jsonl');
  process.env.ECCODE_TEST_OBS = obs;
  let res;
  try {
    res = withCache(() => chain.runChain(chainTasks(chainOrigin()), { agentCmd: CHAIN_AGENT, variant: 'engine', timeoutMs: 180000 }));
  } finally {
    delete process.env.ECCODE_TEST_OBS;
  }
  const seen = fs.readFileSync(obs, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  await t.test('a chain delivers three items on one record, audit clean', () => {
    assert.strictEqual(res.records.length, 3);
    for (const r of res.records) {
      assert.strictEqual(r.engine.delivered, true, `${r.task} delivered`);
      assert.strictEqual(r.hiddenPassed, 1, `${r.task}: ${JSON.stringify(r.checks)}`);
    }
    assert.strictEqual(res.summary.auditOk, true);
    assert.deepStrictEqual(res.records.map((r) => r.chain.index), [0, 1, 2]);
    assert.strictEqual(res.records[1].engine.track, 'quick');
  });

  await t.test('sync removes files upstream does not have', () => {
    assert.strictEqual(seen[1].extra, false, 'c1 left src/extra.txt; the sync to u2 removed it');
    assert.strictEqual(seen[1].value, 'v2\n', "c1's edit is replaced by upstream's tree");
    assert.ok(res.records[1].chain.sync.removed > 0);
  });

  await t.test('hidden files never reach the next item', () => {
    assert.deepStrictEqual(seen.map((s) => s.hidden), [false, false, false]);
  });

  await t.test('the chain summary times status, metrics and audit', () => {
    for (const k of ['status', 'metrics', 'audit']) assert.strictEqual(typeof res.summary.latencyMs[k], 'number', k);
    assert.ok(res.summary.events > 0);
    assert.ok(res.summary.recordBytes > 0);
    assert.strictEqual(typeof res.records[1].chain.indexMs, 'number', 'the incremental index is timed on items after the first');
  });
});

test('sync refuses a source tree with .claude or .eccode', () => withCache(() => {
  const chain = require('../lib/chain');
  const o = chainOrigin({ withClaude: true });
  const tasks = chainTasks(o);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-chain-'));
  execFileSync('git', ['init', '-q'], { cwd: sandbox });
  chain.syncSource(tasks[0], sandbox);
  assert.throws(() => chain.syncSource(tasks[1], sandbox), /\.claude/);
}));

test('a crashed item is abandoned by the operator and the next one runs', () => withCache(() => {
  const chain = require('../lib/chain');
  const o = chainOrigin();
  process.env.ECCODE_TEST_CRASH_ITEM = 'c2';
  let res;
  try {
    res = chain.runChain(chainTasks(o), { agentCmd: CHAIN_AGENT, variant: 'engine', timeoutMs: 180000 });
  } finally {
    delete process.env.ECCODE_TEST_CRASH_ITEM;
  }
  assert.deepStrictEqual(res.records.map((r) => r.engine.delivered), [true, false, true]);
  assert.strictEqual(res.records[1].chain.abandoned, true, 'the stuck work item was abandoned by the operator');
  assert.strictEqual(res.summary.auditOk, true);
}));

test('--max-cost stops before the next run once the cap is reached', () => withCache(() => {
  const o = origin();
  const suite = path.dirname(suiteWith(o, { hiddenChecks: [{ id: 'any', command: 'true' }] }).dir);
  const agent = `node -e "process.stdout.write(JSON.stringify({type:'result',total_cost_usd:0.2,num_turns:1}) + '\\n')"`;
  const out = bench.run({ suite, agentCmd: agent, variants: ['without'], runs: 5, maxCostUsd: 0.3 });
  assert.strictEqual(out.records.length, 2);
  assert.deepStrictEqual(out.stopped, { reason: 'max-cost', spentUsd: 0.4 });
  const chain = require('../lib/chain');
  const c = chain.runChain(chainTasks(chainOrigin()), { agentCmd: agent, variant: 'without', maxCostUsd: 0.3 });
  assert.strictEqual(c.records.length, 2);
  assert.strictEqual(c.stopped.reason, 'max-cost');
}));

test('bench --chain saves records, a chain-summary line per chain, and report skips the typed lines', () => withCache(() => {
  const o = chainOrigin();
  const tasks = chainTasks(o);
  const save = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-save-')), 'runs.jsonl');
  const cliPath = path.join(__dirname, '..', 'bin', 'eccode.js');
  const agent = `node -e "process.stdout.write(JSON.stringify({type:'result',total_cost_usd:0.1,num_turns:1}) + '\\n')"`;
  execFileSync(process.execPath, [cliPath, 'bench', '--suite', path.dirname(tasks[0].dir), '--chain', '--variant', 'without', '--runs', '2', '--agent', agent, '--save', save], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = fs.readFileSync(save, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => l.type || l.task), ['c1', 'c2', 'c3', 'chain-summary', 'c1', 'c2', 'c3', 'chain-summary']);
  assert.deepStrictEqual(lines.filter((l) => !l.type).map((l) => l.chainRun), [1, 1, 1, 2, 2, 2]);
  assert.strictEqual(bench.loadRuns(fs.readFileSync(save, 'utf8')).length, 6, 'loadRuns keeps run records only');
}));

test('transcriptDir encodes like Claude Code', () => {
  assert.strictEqual(bench.transcriptDir('/tmp/a.b/c'), path.join(os.homedir(), '.claude', 'projects', '-tmp-a-b-c'));
});

test('extractRefusals finds the refusals in the fixture and nothing else', () => {
  const { extractRefusals } = require('../bench/pilot/refusals');
  const text = fs.readFileSync(path.join(__dirname, 'bench-reference', 'transcripts', 'refusals.jsonl'), 'utf8');
  const found = extractRefusals(text, 'fixture');
  assert.deepStrictEqual(found.map((r) => [r.kind, r.code]), [['eccode', 'TRACK_RULE'], ['eccode', 'NOT_OWNER'], ['denial', 'config:bashMiss:too-complex'], ['denial', 'hook:deny']]);
  assert.strictEqual(found[0].command, 'node .claude/eccode/bin/eccode.js gate submit phase:fix --actor backend-engineer');
  assert.match(found[1].message, /owned by backend-engineer/);
  assert.match(found[0].id, /^fixture:\d+$/);
});

test('copyTranscripts copies the session files written since the run started', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tr-'));
  const dir = bench.transcriptDir(sandbox);
  fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
  const old = path.join(dir, 'old.jsonl');
  fs.writeFileSync(old, '{}\n');
  fs.utimesSync(old, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const since = Date.now() - 1000;
  fs.writeFileSync(path.join(dir, 's1.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-a.jsonl'), '{}\n');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tr-dest-'));
  try {
    const copied = bench.copyTranscripts(sandbox, dest, since).map((f) => path.relative(dest, f)).sort();
    assert.deepStrictEqual(copied, ['s1.jsonl', path.join('s1', 'subagents', 'agent-a.jsonl')].sort(), 'the old session file is left out');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sample is seeded and stratified', () => {
  const { sample } = require('../bench/pilot/lib');
  const items = Array.from({ length: 60 }, (_, i) => ({ id: i, s: ['routes', 'services', 'core'][i % 3] }));
  const a = sample(items, 9, 42, (x) => x.s);
  assert.deepStrictEqual(a, sample(items, 9, 42, (x) => x.s), 'the same seed gives the same draw');
  assert.notDeepStrictEqual(a.map((x) => x.id), sample(items, 9, 7, (x) => x.s).map((x) => x.id), 'another seed, another draw');
  assert.strictEqual(a.length, 9);
  for (const s of ['routes', 'services', 'core']) assert.ok(a.filter((x) => x.s === s).length >= 3, `${s} gets its share`);
  const small = [{ id: 'a', s: 'x' }, ...Array.from({ length: 10 }, (_, i) => ({ id: i, s: 'y' }))];
  const b = sample(small, 6, 42, (x) => x.s);
  assert.strictEqual(b.length, 6, 'a stratum too small for its share gives its rest to the others');
  assert.strictEqual(b.filter((x) => x.s === 'x').length, 1);
});

test('recallPrecision on known sets', () => {
  const { recallPrecision } = require('../bench/pilot/lib');
  const r = recallPrecision(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']));
  assert.deepStrictEqual(r, { recall: 2 / 3, precision: 2 / 3, tp: 2, fp: 1, fn: 1 });
  assert.strictEqual(recallPrecision(new Set(['a']), new Set()).recall, null, 'no truth, no recall');
  assert.strictEqual(recallPrecision(new Set(), new Set(['a'])).precision, null, 'nothing predicted, no precision');
});

test('replay records skips with reasons', () => {
  const { replay } = require('../bench/pilot/lib');
  const out = replay([{ id: 'a' }, { id: 'b' }, { id: 'c' }], (x) => {
    if (x.id === 'b') throw new Error('merge commit\nwith detail');
    return x.id.toUpperCase();
  });
  assert.deepStrictEqual(out.results, ['A', 'C']);
  assert.deepStrictEqual(out.skipped, [{ id: 'b', reason: 'merge commit' }]);
});

test('testFilesFromContexts strips test ids and phases', () => {
  const { testFilesFromContexts } = require('../bench/pilot/mealie/a2-impact');
  assert.deepStrictEqual([...testFilesFromContexts(['tests/x/test_y.py::test_z|run', 'tests/x/test_y.py::TestA::test_b[1]', 'tests/unit_tests/test_q.py::test_r', ''])].sort(), ['tests/unit_tests/test_q.py', 'tests/x/test_y.py']);
});

test('a2 strata follow the spec', () => {
  const { stratumOf } = require('../bench/pilot/mealie/a2-impact');
  assert.deepStrictEqual(['mealie/routes/a.py', 'mealie/services/b/c.py', 'mealie/repos/d.py', 'mealie/db/models/e.py', 'mealie/schema/f.py', 'mealie/core/g.py', 'mealie/pkgs/h.py'].map(stratumOf), ['routes', 'services', 'repos', 'db/models', 'schema', 'core', 'other']);
});

test('the behavioural fault makes every function and method of the module raise, and the module still imports', (t) => {
  const { faultSource } = require('../bench/pilot/mealie/a2-impact');
  const py = ['python3', 'python'].find((p) => require('child_process').spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no python on PATH');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-fault-'));
  fs.writeFileSync(path.join(dir, 'm.py'), faultSource('X = 1\n\ndef f():\n    return 2\n\nclass C:\n    def g(self):\n        return 3\n\n    @property\n    def p(self):\n        return 4\n\n    @classmethod\n    def k(cls):\n        return 5\n'));
  const probe = 'import m\nassert m.X == 1\nfor call in (m.f, lambda: m.C().g(), lambda: m.C().p, lambda: m.C.k()):\n    try:\n        call()\n    except RuntimeError as e:\n        assert "eccode-pilot fault" in str(e)\n    else:\n        raise SystemExit("did not raise")\nprint("ok")\n';
  const out = execFileSync(py, ['-c', probe], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(out.trim(), 'ok');
});

test('detectBetween finds a route moved between files as a removal from the old file', () => {
  const { detectBetween } = require('../bench/pilot/mealie/a3-compat');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-a3-p-'));
  const commit = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-a3-c-'));
  fs.writeFileSync(path.join(parent, 'r1.py'), '@router.get("/a")\ndef a():\n    return 1\n');
  fs.writeFileSync(path.join(parent, 'r2.py'), 'X = 1\n');
  fs.writeFileSync(path.join(commit, 'r1.py'), 'Y = 2\n');
  fs.writeFileSync(path.join(commit, 'r2.py'), 'X = 1\n\n@router.get("/a")\ndef a():\n    return 1\n');
  const found = detectBetween(parent, commit, ['r1.py', 'r2.py'], 'abc');
  const routes = found.filter((f) => f.kind === 'route');
  assert.strictEqual(routes.length, 1, JSON.stringify(found));
  assert.strictEqual(routes[0].id, 'abc:route:GET /a');
});

test('upgradeBody keeps only the upgrade() function of an Alembic migration', () => {
  const { upgradeBody } = require('../bench/pilot/mealie/a3-compat');
  const text = 'def upgrade():\n    op.add_column("t", c)\n\n\ndef downgrade():\n    op.drop_column("t", "c")\n';
  assert.match(upgradeBody(text), /add_column/);
  assert.doesNotMatch(upgradeBody(text), /drop_column/);
});

test('bench.cacheDir honours ECCODE_BENCH_CACHE (the pilot scripts locate the mirror with it)', () => withCache(() => {
  assert.strictEqual(bench.cacheDir(), process.env.ECCODE_BENCH_CACHE);
}));

test('fastapi-routes.py writes only the served routes, whatever the app prints on import', (t) => {
  const py = ['python3', 'python'].find((p) => require('child_process').spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no python on PATH');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-routes-'));
  fs.mkdirSync(path.join(tree, 'mealie'));
  fs.writeFileSync(path.join(tree, 'mealie', '__init__.py'), '');
  fs.writeFileSync(path.join(tree, 'mealie', 'app.py'), 'import time\nprint(f"[INFO] {time.time()} setup plugin")\nclass R:\n    def __init__(self, methods, path):\n        self.methods, self.path = methods, path\nclass App:\n    routes = [R({"GET", "HEAD"}, "/api/a"), R({"POST"}, "/api/b"), R(None, "/docs")]\napp = App()\n');
  const out = path.join(tree, 'routes.txt');
  execFileSync(py, [path.join(__dirname, '..', 'bench', 'pilot', 'mealie', 'fastapi-routes.py'), tree, out], { encoding: 'utf8' });
  assert.deepStrictEqual(fs.readFileSync(out, 'utf8').trim().split('\n'), ['GET /api/a', 'POST /api/b']);
});

test('fixPopulation keeps code fixes with tests and drops dependency bumps', () => {
  const { fixPopulation } = require('../bench/pilot/mealie/scratch');
  const c = (subject, files) => ({ sha: subject, subject, parent: 'p', files: files.map((p) => ({ status: 'M', path: p })) });
  const kept = fixPopulation([
    c('fix: keep ids (#1)', ['mealie/a.py', 'tests/unit_tests/test_a.py']),
    c('fix(deps): update pydantic (#2)', ['mealie/a.py', 'tests/unit_tests/test_a.py']),
    c('fix: frontend only (#3)', ['frontend/x.ts']),
    c('fix(api): scoped fix (#4)', ['mealie/routes/b.py', 'tests/integration_tests/test_b.py']),
    c('feat: new thing (#5)', ['mealie/c.py', 'tests/unit_tests/test_c.py']),
    c('fix: code without a test (#6)', ['mealie/d.py']),
  ]).map((x) => x.sha);
  assert.deepStrictEqual(kept, ['fix: keep ids (#1)', 'fix(api): scoped fix (#4)']);
});

test('report marks a criterion met or missed from a results fixture', () => {
  const { criteria } = require('../bench/pilot/mealie/report');
  const row = (recall) => criteria({ a2: { medians: { staticRecall: recall } } }, {}).find((r) => r.id === 'impact-static-recall');
  assert.strictEqual(row(0.92).met, true);
  assert.strictEqual(row(0.85).met, false);
  assert.strictEqual(row(0.92).criterion, '≥ 0.90');
  const missing = criteria({}, {}).find((r) => r.id === 'compat-precision');
  assert.strictEqual(missing.met, null, 'no result, no verdict');
});

test('a6 counts every line of a new file as added', () => {
  const { addedCount } = require('../bench/pilot/mealie/a6-bugs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-a6-'));
  fs.writeFileSync(path.join(dir, 'new.py'), 'a = 1\nb = 2\nc = 3\n');
  assert.strictEqual(addedCount(dir, 'new.py', null), 3);
  assert.strictEqual(addedCount(dir, 'old.py', new Set([4, 9])), 2);
});

test('a hidden check can carry its own timeout', () => {
  const task = { id: 't', hiddenChecks: [{ id: 'slow', command: 'node -e "setTimeout(() => {}, 1500)"', timeoutMs: 500 }, { id: 'ok', command: 'node -e "setTimeout(() => {}, 300)"', timeoutMs: 5000 }] };
  const [slow, ok] = bench.runChecks(task, os.tmpdir(), {});
  assert.strictEqual(slow.passed, false, 'stopped at its own timeout');
  assert.strictEqual(ok.passed, true);
});

test('a chain item without a source keeps the tree: the next item builds on the agent\'s own work', () => withCache(() => {
  const chain = require('../lib/chain');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-chain-'));
  execFileSync('git', ['init', '-q'], { cwd: sandbox });
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-nosrc-'));
  fs.mkdirSync(path.join(suite, 'g1', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(suite, 'g1', 'fixture', 'README.md'), 'start\n');
  fs.writeFileSync(path.join(suite, 'g1', 'task.json'), JSON.stringify({ id: 'g1', order: 1, prompt: 'Build it.' }));
  fs.mkdirSync(path.join(suite, 'g2'));
  fs.writeFileSync(path.join(suite, 'g2', 'task.json'), JSON.stringify({ id: 'g2', order: 2, prompt: 'Extend it.' }));
  const [g1, g2] = bench.listTasks(suite).sort((a, b) => a.order - b.order);
  chain.syncSource(g1, sandbox);
  assert.strictEqual(fs.readFileSync(path.join(sandbox, 'README.md'), 'utf8'), 'start\n');
  fs.writeFileSync(path.join(sandbox, 'app.js'), 'agent work\n');
  chain.syncSource(g2, sandbox);
  assert.strictEqual(fs.readFileSync(path.join(sandbox, 'app.js'), 'utf8'), 'agent work\n', 'nothing is reset without an upstream');
}));

const PLANNER = path.join(__dirname, '..', 'bench', 'suites', 'planner');
const hasSqlite = (() => {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

/** Run the planner check (the hidden one) against a project directory; {code, out}. */
function plannerCheck(projectDir, tag) {
  const hidden = path.join(projectDir, '.bench-hidden');
  fs.cpSync(path.join(PLANNER, '_hidden'), hidden, { recursive: true });
  const r = require('child_process').spawnSync(process.execPath, [path.join(hidden, 'check.js'), tag], { cwd: projectDir, encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('the acceptance suite passes against the reference', { skip: !hasSqlite && 'the reference needs node:sqlite (Node >= 22.5)' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-ref-'));
  fs.cpSync(path.join(PLANNER, 'reference'), dir, { recursive: true });
  for (const tag of ['c1', 'c2', 'c3']) {
    const r = plannerCheck(dir, tag);
    assert.strictEqual(r.code, 0, `${tag}:\n${r.out.split('\n').filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 20).join('\n')}`);
  }
});

test('the acceptance suite fails against an empty service', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-empty-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'empty', scripts: { start: 'node server.js' } }));
  fs.writeFileSync(path.join(dir, 'server.js'), "require('http').createServer((q, s) => { s.writeHead(q.url === '/health' ? 200 : 404, { 'content-type': 'application/json' }); s.end(q.url === '/health' ? '{\"ok\":true}' : '{}'); }).listen(process.env.PORT);\n");
  assert.notStrictEqual(plannerCheck(dir, 'c1').code, 0);
});

test("c3's check refuses an edited old migration", { skip: !hasSqlite && 'the reference needs node:sqlite (Node >= 22.5)' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-edit-'));
  fs.cpSync(path.join(PLANNER, 'reference'), dir, { recursive: true });
  const first = fs.readdirSync(path.join(dir, 'migrations')).filter((f) => f.endsWith('.sql')).sort()[0];
  fs.appendFileSync(path.join(dir, 'migrations', first), '\n-- households were added here instead of in a new migration\n');
  const r = plannerCheck(dir, 'c3');
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /c3: migrations are append-only/);
});

test('the dev copy of the fake Mealie server is the hidden one', () => {
  assert.strictEqual(fs.readFileSync(path.join(PLANNER, 'c1', 'fixture', 'dev', 'fake-mealie', 'server.js'), 'utf8'), fs.readFileSync(path.join(PLANNER, '_hidden', 'fake-mealie', 'server.js'), 'utf8'));
});

test('A7: the direct commands are the ones Mealie\'s own Taskfile runs at P', (t) => {
  const lib = require('../bench/pilot/lib');
  const { DIRECT } = require('../bench/pilot/mealie/a7-stack');
  const mirror = lib.mealieMirror();
  if (!fs.existsSync(mirror)) return t.skip(`no Mealie mirror at ${mirror}`);
  const P = 'dbe84cc91b9e1dfc88b783a1e31d8a8495800337';
  const show = (f) => execFileSync('git', ['--git-dir', mirror, 'show', `${P}:${f}`], { encoding: 'utf8' });
  const taskfile = show('Taskfile.yml');
  // Python tools run through `uv run` there; here the venv is first on PATH.
  for (const tool of ['ruff', 'mypy']) assert.ok(taskfile.includes(`uv run ${DIRECT[tool]}\n`), `${tool}: Taskfile runs "uv run ${DIRECT[tool]}"`);
  assert.ok(taskfile.includes('uv run pytest'), 'pytest through uv run');
  assert.match(DIRECT.pytest, /^python -m pytest\b/);
  // Frontend tasks run in frontend/; `yarn test` is vitest, test:ci its no-watch form.
  assert.strictEqual(DIRECT.eslint, `cd frontend && ${taskfile.match(/ui:lint:[\s\S]*?- (yarn lint[^\n]*)/)[1]}`);
  assert.match(show('frontend/package.json'), /"test:ci": "vitest --watch=false"/);
  assert.strictEqual(DIRECT.vitest, 'cd frontend && yarn test:ci');
});

test('report: fix verify agreement counts the disagreements labelled engine-wrong; an unlabelled one leaves no verdict', () => {
  const { criteria } = require('../bench/pilot/mealie/report');
  const a4 = { agreement: 0.5, rows: [{ sha: 'a', agree: true }, { sha: 'b', agree: false }] };
  const row = (labels) => criteria({ a4 }, labels).find((r) => r.id === 'fixverify-agreement');
  assert.strictEqual(row({}).met, null, 'a disagreement without a label: no verdict');
  assert.match(row({}).note, /1 of 1 disagreements unlabelled/);
  assert.strictEqual(row({ fixverify: { b: { label: 'oracle-wrong', reason: 'x' } } }).met, true);
  assert.strictEqual(row({ fixverify: { b: { label: 'engine-wrong', reason: 'x' } } }).met, false);
  assert.strictEqual(row({ fixverify: { b: { label: 'engine-wrong', reason: 'x' } } }).result, 0.5);
  assert.match(row({ fixverify: { b: { label: 'oracle-wrong', reason: 'x' } } }).note, /raw agreement 0\.5/);
});

test('copyRecord copies the engine record without its index cache, and reports false when there is none', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-rec-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-rec-dest-'));
  assert.strictEqual(bench.copyRecord(sandbox, path.join(dest, 'a')), false);
  fs.mkdirSync(path.join(sandbox, '.eccode', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, '.eccode', 'reviews'));
  fs.writeFileSync(path.join(sandbox, '.eccode', 'events.jsonl'), '{}\n');
  fs.writeFileSync(path.join(sandbox, '.eccode', 'cache', 'index.json'), '{}');
  fs.writeFileSync(path.join(sandbox, '.eccode', 'reviews', 'r1.json'), '{}');
  assert.strictEqual(bench.copyRecord(sandbox, path.join(dest, 'b')), true);
  assert.ok(fs.existsSync(path.join(dest, 'b', 'record', 'events.jsonl')));
  assert.ok(fs.existsSync(path.join(dest, 'b', 'record', 'reviews', 'r1.json')));
  assert.ok(!fs.existsSync(path.join(dest, 'b', 'record', 'cache')), 'the index cache is left out');
});

test('with --transcripts, each engine chain item keeps the record as it stood after the item', () => withCache(() => {
  const chain = require('../lib/chain');
  const tr = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tr-rec-'));
  const res = chain.runChain(chainTasks(chainOrigin()), { agentCmd: CHAIN_AGENT, variant: 'engine', timeoutMs: 180000, transcripts: tr });
  const counts = res.records.map((r) => {
    assert.strictEqual(r.chain.transcripts.record, true, `${r.task}: record kept`);
    const dir = path.join(tr, r.chain.transcripts.dir, 'record');
    assert.ok(!fs.existsSync(path.join(dir, 'cache')), 'the index cache is left out');
    return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  });
  assert.ok(counts[0] < counts[1] && counts[1] < counts[2], `the record grows item by item: ${counts}`);
}));

test('a2 frontend truth: the source files a spec file loaded, from the setup file\'s lines', () => {
  const { loadedModules } = require('../bench/pilot/mealie/a2-impact');
  const tree = path.join(os.tmpdir(), 'a2-tree');
  const f = (p) => path.join(tree, 'frontend', p);
  const text = `${JSON.stringify([f('app/tests/setup.ts'), f('a2-loaded.mjs'), 'fs', f('app/lib/validators/inputs.test.ts'), f('app/lib/validators/inputs.ts'), `mock:${f('app/composables/use-i18n.ts')}`, f('node_modules/vue/index.js'), '/elsewhere/x.ts'])}\nnull\n`;
  assert.deepStrictEqual([...loadedModules(text, tree, { setupFile: f('a2-loaded.mjs') })].sort(), ['frontend/app/lib/validators/inputs.test.ts', 'frontend/app/lib/validators/inputs.ts', 'frontend/app/tests/setup.ts'].sort());
});

test('report: the stack row requires both the Python and the Node stacks', () => {
  const { criteria } = require('../bench/pilot/mealie/report');
  const row = (stacks) => criteria({ a7: { stacks, checks: [], secrets: { hits: [] } } }, {}).find((r) => r.id === 'stack-detect');
  assert.strictEqual(row(['python']).met, false);
  assert.strictEqual(row(['python', 'node']).met, true);
  assert.strictEqual(row(['python']).result, 'python');
});
