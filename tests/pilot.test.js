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
  // A fresh record on the refactor track is started by init, so init carries it too.
  const initLine = bench.enginePrompt('engine', 'refactor', { behavior: 'python -m pytest -q tests' }).split('\n').find((l) => l.includes('init --name'));
  assert.ok(initLine.includes('--track refactor --behavior "python -m pytest -q tests"'), initLine);
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

test('extractRefusals counts a refused tool call once when an api-request-blob event repeats its result', () => {
  const { extractRefusals } = require('../bench/pilot/refusals');
  const use = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'node .claude/eccode/bin/eccode.js work show w2' } }] } };
  const result = { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'Exit code 2\neccode: [USAGE] Unknown work subcommand show' };
  const text = [use, { type: 'user', message: { role: 'user', content: [result] } }, { type: 'api-request-blob', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'ok' }, result] } }].map((e) => JSON.stringify(e)).join('\n');
  assert.deepStrictEqual(extractRefusals(text, 's').map((x) => [x.id, x.code]), [['s:2', 'USAGE']]);
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

// The rerun's greenfield suite (bench/suites/pantry): fresh requests, the same grading.
const PANTRY = path.join(__dirname, '..', 'bench', 'suites', 'pantry');
function pantryCheck(projectDir, tag) {
  const hidden = path.join(projectDir, '.bench-hidden');
  fs.cpSync(path.join(PANTRY, '_hidden'), hidden, { recursive: true });
  const r = require('child_process').spawnSync(process.execPath, [path.join(hidden, 'check.js'), tag], { cwd: projectDir, encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const pantryReference = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(path.join(PANTRY, 'reference'), dir, { recursive: true });
  return dir;
};

test('pantry: the acceptance suite passes against the reference', { skip: !hasSqlite && 'the reference needs node:sqlite (Node >= 22.5)' }, () => {
  const dir = pantryReference('pantry-ref-');
  for (const tag of ['c1', 'c2', 'c3']) {
    const r = pantryCheck(dir, tag);
    assert.strictEqual(r.code, 0, `${tag}:\n${r.out.split('\n').filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 20).join('\n')}`);
  }
});

test('pantry: the acceptance suite fails against an empty service and against a client that reads one page of recipes', { skip: !hasSqlite && 'the reference needs node:sqlite (Node >= 22.5)' }, () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pantry-empty-'));
  fs.writeFileSync(path.join(empty, 'package.json'), JSON.stringify({ name: 'empty', scripts: { start: 'node server.js' } }));
  fs.writeFileSync(path.join(empty, 'server.js'), "require('http').createServer((q, s) => { s.writeHead(q.url === '/health' ? 200 : 404, { 'content-type': 'application/json' }); s.end(q.url === '/health' ? '{\"ok\":true}' : '{}'); }).listen(process.env.PORT);\n");
  assert.notStrictEqual(pantryCheck(empty, 'c1').code, 0);
  const onePage = pantryReference('pantry-page-');
  const server = path.join(onePage, 'server.js');
  fs.writeFileSync(server, fs.readFileSync(server, 'utf8').replace('if (page >= p.total_pages) return out;', 'return out;'));
  const r = pantryCheck(onePage, 'c1');
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /not ok \d+ - c1: cookable recipes read every page of Mealie/);
});

test("pantry: c3's check refuses an edited first migration", { skip: !hasSqlite && 'the reference needs node:sqlite (Node >= 22.5)' }, () => {
  const dir = pantryReference('pantry-edit-');
  fs.appendFileSync(path.join(dir, 'migrations', '001_init.sql'), '\n-- expiry dates were added here instead of in a new migration\n');
  const r = pantryCheck(dir, 'c3');
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /c3: migrations are append-only/);
});

test('pantry: the dev copy of the fake Mealie server is the hidden one', () => {
  assert.strictEqual(fs.readFileSync(path.join(PANTRY, 'c1', 'fixture', 'dev', 'fake-mealie', 'server.js'), 'utf8'), fs.readFileSync(path.join(PANTRY, '_hidden', 'fake-mealie', 'server.js'), 'utf8'));
});

test('A7: the direct commands are the ones Mealie\'s own Taskfile runs, with the package manager of the commit', (t) => {
  const lib = require('../bench/pilot/lib');
  const { directFor } = require('../bench/pilot/mealie/a7-stack');
  const mirror = lib.mealieMirror();
  if (!fs.existsSync(mirror)) return t.skip(`no Mealie mirror at ${mirror}`);
  // P, the pilot's pin (yarn), and P2, the rerun's (pnpm 11).
  for (const [commit, manager] of [['dbe84cc91b9e1dfc88b783a1e31d8a8495800337', 'yarn'], ['dedc6cc75f2bd8e89108ad998970e7bdf6d4444f', 'pnpm']]) {
    const show = (f) => execFileSync('git', ['--git-dir', mirror, 'show', `${commit}:${f}`], { encoding: 'utf8' });
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-a7-'));
    for (const f of execFileSync('git', ['--git-dir', mirror, 'ls-tree', '--name-only', commit, 'frontend/'], { encoding: 'utf8' }).split('\n').filter((x) => /lock|pnpm-workspace/.test(x))) {
      fs.mkdirSync(path.join(tree, 'frontend'), { recursive: true });
      fs.writeFileSync(path.join(tree, f), '');
    }
    const DIRECT = directFor(tree);
    const taskfile = show('Taskfile.yml');
    // Python tools run through `uv run` there; here the venv is first on PATH.
    for (const tool of ['ruff', 'mypy']) assert.ok(taskfile.includes(`uv run ${DIRECT[tool]}\n`), `${commit.slice(0, 8)} ${tool}: Taskfile runs "uv run ${DIRECT[tool]}"`);
    assert.ok(taskfile.includes('uv run pytest'), 'pytest through uv run');
    assert.match(DIRECT.pytest, /^python -m pytest\b/);
    // Frontend tasks run in frontend/; `test` is vitest, test:ci its no-watch form.
    assert.strictEqual(DIRECT.eslint, `cd frontend && ${taskfile.match(new RegExp(`ui:lint:[\\s\\S]*?- (${manager} lint[^\\n]*)`))[1]}`, `${commit.slice(0, 8)} eslint`);
    assert.match(show('frontend/package.json'), /"test:ci": "vitest --watch=false"/);
    assert.strictEqual(DIRECT.vitest, `cd frontend && ${manager} test:ci`, `${commit.slice(0, 8)} vitest`);
    fs.rmSync(tree, { recursive: true, force: true });
  }
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

test('analyse: gate order of the first work item, and the greenfield order rule', () => {
  const { gateOrder, gatesInOrder } = require('../bench/pilot/analyse');
  const ap = (gate, decision = 'approve') => ({ type: 'review.recorded', data: { gate, review: { decision } } });
  const events = [{ type: 'project.initialized', data: {} }, ap('architecture', 'request_changes'), ap('architecture'), ap('design'), ap('plan'), ap('phase:api'), ap('phase:api'), ap('phase:db'), ap('verification'), { type: 'work.started', data: {} }, ap('design'), ap('phase:next-item')];
  const order = gateOrder(events);
  assert.deepStrictEqual(order, ['architecture', 'design', 'plan', 'phase:api', 'phase:db', 'verification'], 'first approvals only, first work item only');
  assert.strictEqual(gatesInOrder(order), true);
  assert.strictEqual(gatesInOrder(['design', 'architecture', 'plan', 'phase:a', 'verification']), false);
  assert.strictEqual(gatesInOrder(['architecture', 'design', 'plan', 'verification']), false, 'at least one phase');
});

test('analyse: the greenfield rows read the suite the runs used (the rerun\'s pantry)', () => {
  const { criteria } = require('../bench/pilot/analyse');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-analyse-gf-'));
  const done = (task) => ({ task, chainRun: 1, engine: { delivered: true, auditOk: true, initialized: true }, patch: '' });
  const runs = { c1: { records: [done('pantry-c1'), done('pantry-c2')], summaries: [], stopped: [] } };
  const row = (opts) => criteria(dir, runs, { refusals: {} }, opts).rows.find((r) => r.id === 'greenfield-1').result;
  assert.match(row({ greenfield: 'pantry' }), /2\/3 delivered/);
  assert.match(row(undefined), /0\/3 delivered/, 'the pilot\'s planner by default');
});

test('analyse: migration files a patch adds, modifies or deletes', () => {
  const { migrationChange } = require('../bench/pilot/analyse');
  const patch = [
    'diff --git a/migrations/003_households.sql b/migrations/003_households.sql\nnew file mode 100644\n--- /dev/null\n+++ b/migrations/003_households.sql\n@@ -0,0 +1 @@\n+CREATE TABLE h (id INTEGER);\n',
    'diff --git a/migrations/001_init.sql b/migrations/001_init.sql\nindex 1..2 100644\n--- a/migrations/001_init.sql\n+++ b/migrations/001_init.sql\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/db/migration/002.sql b/db/migration/002.sql\ndeleted file mode 100644\n',
    'diff --git a/src/server.js b/src/server.js\nnew file mode 100644\n',
  ].join('');
  assert.deepStrictEqual(migrationChange(patch), { added: ['migrations/003_households.sql'], modified: ['migrations/001_init.sql'], deleted: ['db/migration/002.sql'] });
});

test('analyse: delivered share, tool-result text and lessons surfaced in a later item', () => {
  const { deliveredShare, toolResultText, lessonsSurfaced } = require('../bench/pilot/analyse');
  assert.strictEqual(deliveredShare([{ engine: { delivered: true, auditOk: true } }, { engine: { delivered: true, auditOk: false } }, { engine: { delivered: false, auditOk: true } }, {}]), 0.25);
  const jsonl = [{ message: { content: [{ type: 'tool_result', content: 'lesson L-1: run the migrations first' }] } }, { message: { content: [{ type: 'text', text: 'L-2 in my own words', content: 'L-2 typed' }] } }, { message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'brief' }] }] } }].map((x) => JSON.stringify(x)).join('\n');
  assert.strictEqual(toolResultText(jsonl), 'lesson L-1: run the migrations first\nbrief', 'tool results only, not the agent\'s own text');
  const r = lessonsSurfaced([{ lessons: [], toolText: '' }, { lessons: ['L-1'], toolText: 'L-1 here, in the item that recorded it' }, { lessons: ['L-1', 'L-2'], toolText: 'nothing' }, { lessons: ['L-1', 'L-2'], toolText: 'see L-1' }]);
  assert.strictEqual(r.recorded, 2);
  assert.deepStrictEqual(r.surfaced, [{ lesson: 'L-1', recordedIn: 1, surfacedIn: 3 }], 'only a later item counts');
});

test('A7: a project-script check is compared with the tool its script runs', () => {
  const { toolOf } = require('../bench/pilot/mealie/a7-stack');
  assert.strictEqual(toolOf({ id: 'node-test', command: 'cd frontend && yarn test', script: 'vitest' }), 'vitest');
  assert.strictEqual(toolOf({ id: 'node-lint', command: 'cd frontend && yarn lint', script: 'yarn lint:js → eslint .' }), 'eslint');
  assert.strictEqual(toolOf({ id: 'ruff', command: 'ruff check mealie' }), 'ruff');
  assert.strictEqual(toolOf({ id: 'tsc', command: 'cd frontend && npx tsc --noEmit' }), null);
});

// Amendment (2026-10-24, during the batch): every benchmark session inherited
// the operator's session id, so a chain's items (one sandbox) appended to one
// transcript file and item k's copy held items 1..k. Only an item's own lines count.
test('analyse: a chain item counts only the transcript lines it added', () => {
  const { allRefusals, itemToolText, ownOffset } = require('../bench/pilot/analyse');
  const line = (o) => JSON.stringify(o);
  const use = (id, command) => line({ message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const refused = (id, text) => line({ message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } });
  const result = (text) => line({ message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: text }] } });
  const item1 = [use('a', 'eccode task claim T1'), refused('a', 'eccode: [WORK_ACTIVE] w1 is active'), result('lesson L-7 recorded')].join('\n') + '\n';
  const item2 = item1 + [use('b', 'eccode gate start plan'), refused('b', 'eccode: [INVALID_TRANSITION] plan is approved'), result('nothing about lessons')].join('\n') + '\n';
  assert.strictEqual(ownOffset(item2, item1), 3, 'the lines the previous copy already held');
  assert.strictEqual(ownOffset(item2, 'something else\n'), 0, 'not a prefix: every line counts');
  assert.strictEqual(ownOffset(item2, null), 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-analyse-'));
  const sess = 'abc.jsonl';
  const base = 'eccode-chain-engine-XyZ123';
  const rec = (index, task) => ({ task, variant: 'engine', chain: { index, transcripts: { dir: `${base}-${index + 1}-${task}`, files: [] } } });
  const records = [rec(0, 'mealie-01-refactor'), rec(1, 'mealie-02-fix')];
  fs.writeFileSync(path.join(dir, 'b1.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const [r, text] of [[records[0], item1], [records[1], item2]]) {
    fs.mkdirSync(path.join(dir, 'tr-b1', r.chain.transcripts.dir), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tr-b1', r.chain.transcripts.dir, sess), text);
  }
  const runs = { b1: { records, summaries: [], stopped: [] } };
  const ref = allRefusals(dir, runs);
  assert.deepStrictEqual(ref.map((x) => [x.task, x.code]), [['mealie-01-refactor', 'WORK_ACTIVE'], ['mealie-02-fix', 'INVALID_TRANSITION']], 'item 1\'s refusal once, not again in item 2');
  assert.ok(itemToolText(dir, 'b1', records[0]).includes('L-7'));
  assert.ok(!itemToolText(dir, 'b1', records[1]).includes('L-7'), 'item 1\'s own result is not item 2 surfacing the lesson');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Rerun amendment 1: a container restart killed the batch processes mid-item.
const resume = require('../bench/pilot/resume');

/** A chain cut off during c2: c1 done and saved, c2's agent crashed with its work item open. */
function cutChain() {
  const chain = require('../lib/chain');
  const tasks = chainTasks(chainOrigin());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-resume-'));
  const sandbox = path.join(dir, 'sandbox');
  fs.mkdirSync(sandbox);
  execFileSync('git', ['init', '-q'], { cwd: sandbox });
  const save = path.join(dir, 'runs', 'b1.jsonl');
  fs.mkdirSync(path.dirname(save));
  const r = chain.runChainItem(tasks[0], sandbox, { agentCmd: CHAIN_AGENT, variant: 'engine', first: true, index: 0, timeoutMs: 180000 });
  fs.appendFileSync(save, JSON.stringify({ ...r, chainRun: 1 }) + '\n');
  // What runChainItem does for c2 up to its agent, then an agent killed mid-work.
  chain.syncSource(tasks[1], sandbox);
  fs.writeFileSync(path.join(sandbox, 'PROMPT.md'), bench.promptFor(tasks[1], 'engine').prompt);
  bench.git(sandbox, ['add', '-A']);
  bench.git(sandbox, ['commit', '-q', '-m', 'item: c2']);
  process.env.ECCODE_TEST_CRASH_ITEM = 'c2';
  try {
    bench.runAgent(sandbox, CHAIN_AGENT, bench.taskEnv(tasks[1]), 'engine', 180000);
  } finally {
    delete process.env.ECCODE_TEST_CRASH_ITEM;
  }
  return { dir, suite: path.dirname(tasks[0].dir), sandbox, save, registered: path.join(dir, 'registered', 'b1.jsonl') };
}

test('resume: a chain cut off by a restart continues on its sandbox; the cut item is a failure, and the registered reading counts the rest as not delivered', () => withCache(() => {
  const c = cutChain();
  // The harness had copied c2's transcripts: its agent had exited when the restart came.
  const tr = path.join(c.dir, 'tr');
  fs.mkdirSync(path.join(tr, `${path.basename(c.sandbox)}-2-c2`), { recursive: true });
  const posthoc = path.join(c.dir, 'posthoc.jsonl');
  resume.resumeChain({ suite: c.suite, sandbox: c.sandbox, save: c.save, registered: c.registered, chainRun: 1, interrupted: 'c2', cause: 'container restart (test)', agentCmd: CHAIN_AGENT, variant: 'engine', timeoutMs: 180000, transcripts: tr, posthoc, keep: true });
  const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const main = read(c.save);
  assert.deepStrictEqual(main.map((l) => l.type || l.task), ['c1', 'c2', 'c3', 'chain-summary']);
  const [, cut, next, summary] = main;
  assert.strictEqual(cut.hiddenPassed, 0);
  assert.strictEqual(cut.agentExit, 1);
  assert.strictEqual(cut.usage, null);
  assert.strictEqual(cut.engine.delivered, false);
  assert.strictEqual(cut.engine.initialized, true);
  assert.strictEqual(cut.infrastructure.cause, 'container restart (test)');
  assert.strictEqual(cut.chain.index, 1);
  assert.strictEqual(cut.chain.abandoned, true, 'the open work item is abandoned by the registered operator policy');
  assert.strictEqual(cut.chainRun, 1);
  assert.strictEqual(cut.amendment, 1);
  assert.strictEqual(cut.infrastructure.agentFinished, true);
  assert.strictEqual(cut.chain.transcripts.record, true, 'the record as the operator left it is kept next to the transcripts');
  const graded = read(posthoc);
  assert.deepStrictEqual(graded.map((g) => [g.task, g.posthoc, g.hiddenPassed, g.hiddenTotal]), [['c2', true, 0, 1]], 'graded from a copy, outside both readings');
  assert.strictEqual(next.engine.delivered, true, 'the next item runs on the same record');
  assert.strictEqual(next.hiddenPassed, 1);
  assert.strictEqual(next.chain.index, 2);
  assert.strictEqual(next.amendment, 1);
  assert.strictEqual(summary.auditOk, true);
  assert.strictEqual(summary.chain, 1);
  const reg = read(c.registered);
  assert.deepStrictEqual(reg.map((l) => l.type || l.task), ['c1', 'c2', 'c3', 'chain-summary']);
  assert.deepStrictEqual(reg[1], cut);
  assert.strictEqual(reg[2].infrastructure.neverStarted, true);
  assert.strictEqual(reg[2].engine.delivered, false);
  assert.strictEqual(reg[2].hiddenPassed, 0);
  assert.strictEqual(reg[3].at, 'restart', 'the registered summary is the record as the chain left it');
  assert.throws(() => resume.resumeChain({ suite: c.suite, sandbox: c.sandbox, save: c.save, registered: c.registered, chainRun: 1, interrupted: 'c2', cause: 'again', agentCmd: CHAIN_AGENT, variant: 'engine' }), /already resumed/);
}));

test('resume: a sandbox that is not on the named item is refused', () => withCache(() => {
  const c = cutChain();
  assert.throws(() => resume.resumeChain({ suite: c.suite, sandbox: c.sandbox, save: c.save, registered: c.registered, chainRun: 1, interrupted: 'c3', cause: 'x', agentCmd: CHAIN_AGENT, variant: 'engine' }), /not on item c3/);
}));

test('resume: an independent run cut off by a restart is a failure; the runs that never started run once and are failures in the registered reading', () => withCache(() => {
  const o = origin();
  const task = suiteWith(o, { hiddenChecks: [{ id: 'any', command: 'true' }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-resume-'));
  const sandbox = path.join(dir, `eccode-bench-${task.id}-without-x`);
  fs.mkdirSync(sandbox);
  bench.materialize(task, sandbox);
  const save = path.join(dir, 'runs', 'b3.jsonl');
  fs.mkdirSync(path.dirname(save));
  fs.writeFileSync(save, JSON.stringify({ task: 't1', variant: 'without', hiddenPassed: 1, hiddenTotal: 1, usage: { costUsd: 0.1 } }) + '\n');
  const agent = `node -e "process.stdout.write(JSON.stringify({type:'result',total_cost_usd:0.1,num_turns:1}) + '\\n')"`;
  resume.resumeRuns({ suite: path.dirname(task.dir), sandbox, save, registered: path.join(dir, 'registered', 'b3.jsonl'), interrupted: 't1', variant: 'without', cause: 'container restart (test)', then: [['t1', 2]], agentCmd: agent, maxCostUsd: 10 });
  const read = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const main = read(save);
  assert.deepStrictEqual(main.map((l) => [l.hiddenPassed, l.amendment || 0]), [[1, 0], [0, 1], [1, 1], [1, 1]]);
  assert.strictEqual(main[1].infrastructure.cause, 'container restart (test)');
  assert.strictEqual(fs.existsSync(sandbox), false, 'the cut run\'s sandbox is removed, as the harness does');
  const reg = read(path.join(dir, 'registered', 'b3.jsonl'));
  assert.deepStrictEqual(reg.map((l) => [l.hiddenPassed, Boolean(l.infrastructure && l.infrastructure.neverStarted)]), [[1, false], [0, false], [0, true], [0, true]]);
}));

test('readings: registered, its sensitivity without runs that have no result line, and the continued reading', () => {
  const { readings } = require('../bench/pilot/readings');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-readings-'));
  const line = (r) => JSON.stringify(r) + '\n';
  const ok = { task: 'i1', usage: { costUsd: 1, turns: 9 }, hiddenPassed: 1, hiddenTotal: 1 };
  const cut = { task: 'i2', usage: null, hiddenPassed: 0, hiddenTotal: 1, infrastructure: { cause: 'restart', neverStarted: false }, amendment: 1 };
  const later = { task: 'i3', usage: { costUsd: 1, turns: 4 }, hiddenPassed: 1, hiddenTotal: 1, amendment: 1 };
  const never = { task: 'i3', usage: null, hiddenPassed: 0, hiddenTotal: 1, infrastructure: { cause: 'restart', neverStarted: true }, amendment: 1 };
  const zero = { task: 'i4', usage: { costUsd: 0, turns: 0 }, hiddenPassed: 0, hiddenTotal: 1 };
  fs.writeFileSync(path.join(dir, 'b1.jsonl'), line(ok) + line(cut) + line(later) + line({ type: 'chain-summary', chain: 1, amendment: 1 }));
  fs.mkdirSync(path.join(dir, 'registered'));
  fs.writeFileSync(path.join(dir, 'registered', 'b1.jsonl'), line(ok) + line(cut) + line(never) + line({ type: 'chain-summary', chain: 1, at: 'restart' }));
  fs.writeFileSync(path.join(dir, 'c2.jsonl'), line(ok) + line(zero));
  fs.mkdirSync(path.join(dir, 'tr-b1'));
  const out = readings(dir);
  const tasks = (reading, p) => fs.readFileSync(path.join(out[reading], `${p}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => r.type || r.task);
  assert.deepStrictEqual(tasks('registered', 'b1'), ['i1', 'i2', 'i3', 'chain-summary']);
  assert.deepStrictEqual(tasks('registered', 'c2'), ['i1', 'i4'], 'a process the restart did not cut is the same in every reading');
  assert.deepStrictEqual(tasks('sensitivity', 'b1'), ['i1', 'chain-summary']);
  assert.deepStrictEqual(tasks('sensitivity', 'c2'), ['i1'], 'zero turns counts as never started');
  assert.deepStrictEqual(tasks('continued', 'b1'), ['i1', 'i2', 'i3', 'chain-summary']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out.continued, 'b1.jsonl'), 'utf8').split('\n')[2]).usage.turns, 4);
  assert.ok(fs.existsSync(path.join(out.registered, 'tr-b1')), 'transcripts are reachable from every reading');
});

test('A4: the oracle names its verdicts as fix verify does', () => {
  const { expectedVerdict } = require('../bench/pilot/mealie/a4-fixverify');
  assert.strictEqual(expectedVerdict({ code: 0 }, { code: 0 }), 'tests-pass-without-fix');
  assert.strictEqual(expectedVerdict({ code: 1, out: 'E   assert 1 == 2' }, { code: 1 }), 'fix-fails-tests');
  assert.strictEqual(expectedVerdict({ code: 1, out: "ImportError: cannot import name 'x'" }, { code: 0 }), 'inconclusive');
  assert.strictEqual(expectedVerdict({ code: 1, out: 'E   assert 500 == 200' }, { code: 0 }), 'proven');
  // In fix verify's order: a pre-fix run that fails for a missing API is inconclusive whatever the post-fix run does.
  assert.strictEqual(expectedVerdict({ code: 1, out: "ImportError: cannot import name 'x'" }, { code: 1 }), 'inconclusive');
});

test('A3: the route table reads routes FastAPI keeps under an included router (0.141+) as well as top-level ones', (t) => {
  const py = ['python3', 'python'].find((p) => require('child_process').spawnSync(p, ['--version']).status === 0);
  if (!py) return t.skip('no python');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-routes-'));
  fs.mkdirSync(path.join(tree, 'mealie'));
  fs.writeFileSync(path.join(tree, 'mealie', '__init__.py'), '');
  // The two shapes: a plain route with methods and a path, and FastAPI 0.141's
  // _IncludedRouter, whose routes come from effective_route_contexts().
  fs.writeFileSync(path.join(tree, 'mealie', 'app.py'), [
    'from types import SimpleNamespace as N',
    'class _IncludedRouter:',
    '    def effective_route_contexts(self):',
    '        return [N(methods={"GET"}, path="/api/app/about"), N(methods={"POST", "HEAD"}, path="/api/groups/seeders/labels"),',
    '                N(methods=None, path=None, starlette_route=N(methods={"GET"}, path="/api/plain"))]',
    'app = N(routes=[N(methods={"GET", "HEAD"}, path="/docs"), _IncludedRouter()])',
    '',
  ].join('\n'));
  const out = path.join(tree, 'routes.txt');
  const r = require('child_process').spawnSync(py, [path.join(__dirname, '..', 'bench', 'pilot', 'mealie', 'fastapi-routes.py'), tree, out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean), ['GET /api/app/about', 'GET /api/plain', 'GET /docs', 'POST /api/groups/seeders/labels']);
});

test('A6: a changed-files scratch repo keeps the project\'s lint configuration, so the analyzers judge it as the project does', (t) => {
  const lib = require('../bench/pilot/lib');
  const { scratchRepo } = require('../bench/pilot/mealie/scratch');
  const mirror = lib.mealieMirror();
  if (!fs.existsSync(mirror)) return t.skip(`no Mealie mirror at ${mirror}`);
  const sha = '6fb78ba468401e7b9b5679ae39454ca6cf0742df';
  const parent = execFileSync('git', ['--git-dir', mirror, 'rev-parse', `${sha}^`], { encoding: 'utf8' }).trim();
  const s = scratchRepo(mirror, { sha, parent, files: [{ path: 'mealie/core/settings/branding.py', status: 'A' }] }, { full: false });
  try {
    assert.ok(fs.existsSync(path.join(s.root, 'mealie/core/settings/branding.py')));
    assert.match(fs.readFileSync(path.join(s.root, 'pyproject.toml'), 'utf8'), /target-version = "py314"/);
    assert.strictEqual(execFileSync('git', ['status', '--porcelain', 'pyproject.toml'], { cwd: s.root, encoding: 'utf8' }), '', 'configuration is part of the base, not of the change');
  } finally {
    s.cleanup();
  }
});

test('proof run: hard items are those a stage-1 bare run failed by agent error; the primary test uses stage-2 runs on them only', () => {
  const { runKeys, hardItems, primary, delivery } = require('../bench/pilot/proof');
  const row = (process, task, variant, ok, extra = {}) => ({ process, task, variant, hiddenPassed: ok ? 2 : 1, hiddenTotal: 2, usage: { costUsd: variant === 'engine' ? 2 : 0.5 }, ...extra });
  const stage1 = [
    row('w1', 'a', 'without', false), row('w1', 'a', 'without', true),
    row('w1', 'b', 'without', false), row('w1', 'c', 'without', true),
    { process: 'w1', task: 'd', variant: 'without' }, // cut: no result line
    row('e1', 'a', 'engine', true),
  ];
  const keys = runKeys(stage1);
  assert.deepStrictEqual(keys.slice(0, 3), ['w1:a:1', 'w1:a:2', 'w1:b:1']);
  const labels = { 'w1:a:1': { label: 'agent-error' }, 'w1:b:1': { label: 'spec-gap' }, 'w1:d:1': { label: 'harness' } };
  assert.deepStrictEqual(hardItems(stage1, labels), ['a'], 'b is a spec gap, d a harness failure, c passed');
  assert.throws(() => hardItems(stage1, {}), /unlabelled/, 'every failed bare run is labelled before stage 2');
  const stage2 = [row('w2', 'a', 'without', false), row('w2', 'a', 'without', false), row('e2', 'a', 'engine', true), row('e2', 'a', 'engine', true), row('e2', 'z', 'engine', false)];
  const p = primary(stage2, ['a']);
  assert.deepStrictEqual([p.engine, p.without], [{ passed: 2, runs: 2 }, { passed: 0, runs: 2 }], 'item z is not hard and does not count');
  assert.strictEqual(p.test.delta, 1);
  const d = delivery([row('e1', 'a', 'engine', true, { engine: { delivered: true, auditOk: true } }), row('e1', 'b', 'engine', true, { engine: { delivered: true, auditOk: false } }), { process: 'e1', task: 'c', variant: 'engine' }]);
  assert.deepStrictEqual(d, { delivered: 1, runs: 3, share: 1 / 3 });
});

test('proof run: friction is the false refusals per engine run, from the engine processes\' transcripts only', () => {
  const { friction } = require('../bench/pilot/proof');
  const { write } = require('./helpers');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-proof-friction-'));
  const use = (id, command) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const refused = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } });
  const jsonl = (events) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  const run = 'tr-e1/eccode-bench-x-engine-AAAAAA';
  write(dir, `${run}/s1.jsonl`, jsonl([use('t1', 'eccode gate submit verification'), refused('t1', 'eccode: [TRACK_RULE] no reproduction pair')]));
  write(dir, `${run}/s1/subagents/agent-1.jsonl`, jsonl([use('t2', 'eccode memory help'), refused('t2', 'eccode: [USAGE] Unknown memory subcommand')]));
  write(dir, `${run}/record/events.jsonl`, jsonl([use('t8', 'eccode x'), refused('t8', 'eccode: [USAGE] the record copy is not a transcript')]));
  write(dir, 'tr-w1/eccode-bench-x-without-BBBBBB/s.jsonl', jsonl([use('t9', 'eccode x'), refused('t9', 'eccode: [USAGE] a bare run is not counted')]));
  const rows = [{ process: 'e1', task: 'x', variant: 'engine' }, { process: 'e1', task: 'y', variant: 'engine' }, { process: 'w1', task: 'x', variant: 'without' }];
  const ids = [`e1/eccode-bench-x-engine-AAAAAA/s1.jsonl:2`, `e1/eccode-bench-x-engine-AAAAAA/s1/subagents/agent-1.jsonl:2`];
  assert.deepStrictEqual(friction(dir, rows, { [ids[0]]: { label: 'false' }, [ids[1]]: { label: 'correct' } }), { refusals: 2, unlabelled: [], false: 1, runs: 2, perRun: 0.5 });
  assert.deepStrictEqual(friction(dir, rows, {}).unlabelled.sort(), [...ids].sort(), 'every refusal is labelled before the figure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('proof run: the report gives the primary verdict, both secondary criteria over stage-1 engine runs, and stage-1 correctness', () => {
  const { report } = require('../bench/pilot/proof');
  const row = (process, task, variant, ok, extra = {}) => ({ process, task, variant, hiddenPassed: ok ? 2 : 1, hiddenTotal: 2, durationMs: variant === 'engine' ? 600000 : 60000, usage: { costUsd: variant === 'engine' ? 2 : 0.5 }, engine: variant === 'engine' ? { delivered: true, auditOk: true } : undefined, ...extra });
  const stage1 = [
    row('w1', 'a', 'without', false), row('w1', 'a', 'without', true), row('w1', 'b', 'without', true), row('w1', 'b', 'without', true),
    row('e1', 'a', 'engine', true), row('e1', 'a', 'engine', true), row('e1', 'b', 'engine', true), row('e1', 'b', 'engine', true, { engine: { delivered: false } }),
  ];
  const md = report({ stage1, stage2: null, labels: { 'w1:a:1': { label: 'spec-gap' } }, friction: { refusals: 9, unlabelled: [], false: 1, runs: 4, perRun: 0.25 } });
  assert.match(md, /Hard items[^\n]*: none\./);
  assert.match(md, /Primary[^\n]*no verdict[^\n]*fewer than 3 hard items/i);
  assert.match(md, /Delivery[^\n]*3\/4 stage-1 engine runs \(75%\)[^\n]*missed/i);
  assert.match(md, /Friction[^\n]*1 false refusal in 4 stage-1 engine runs \(0\.25 per run\)[^\n]*met/i);
  assert.match(md, /Stage 1, all items: engine 4\/4, bare 3\/4/);
  assert.match(md, /Stratified permutation test/);
  assert.match(md, /Median run time: engine 10\.0 min, bare 1\.0 min/);
  const unlabelled = report({ stage1, stage2: null, labels: { 'w1:a:1': { label: 'spec-gap' } }, friction: { refusals: 9, unlabelled: ['x'], false: 1, runs: 4, perRun: 0.25 } });
  assert.match(unlabelled, /Friction[^\n]*1 refusal unlabelled/i, 'no friction verdict before every refusal is labelled');
});

test('proof run tools: the replay splits a backend-and-frontend target; the lint check counts only what a patch introduces', () => {
  const { parts } = require('../bench/pilot/mealie/proof-replay');
  assert.deepStrictEqual(parts('python -m pytest -q a.py && (cd frontend && npx vitest run b.test.ts)', true), ['python -m pytest -q a.py', '(cd frontend && npx vitest run b.test.ts)']);
  assert.deepStrictEqual(parts('python -m pytest -q a.py', true), ['python -m pytest -q a.py'], 'a backend-only target stays whole');
  assert.strictEqual(parts('a && (b)', false).length, 1, 'whole unless asked');
  const { changedPython, introduced } = require('../bench/pilot/mealie/proof-lint');
  const patch = ['diff --git a/m/a.py b/m/a.py', '--- a/m/a.py', '+++ b/m/a.py', 'diff --git a/m/gone.py b/m/gone.py', '--- a/m/gone.py', '+++ /dev/null', 'diff --git a/f/x.ts b/f/x.ts', '+++ b/f/x.ts', 'diff --git a/m/new.py b/m/new.py', '+++ b/m/new.py'].join('\n');
  assert.deepStrictEqual(changedPython(patch).map((f) => f.path), ['m/a.py', 'm/new.py'], 'added or changed Python files, not deleted ones or other languages');
  const before = { counts: { 'm/a.py': { E501: 2 }, 'm/new.py': null }, unformatted: new Set(['m/a.py']) };
  assert.deepStrictEqual(introduced(before, { counts: { 'm/a.py': { E501: 2 }, 'm/new.py': {} }, unformatted: new Set(['m/a.py']) }), { violations: 0, codes: [], unformatted: [], clean: true }, 'what was there before is not the patch\'s');
  assert.deepStrictEqual(introduced(before, { counts: { 'm/a.py': { E501: 3 }, 'm/new.py': { 'I001*': 1 } }, unformatted: new Set(['m/a.py', 'm/new.py']) }), { violations: 2, codes: ['E501', 'I001*'], unformatted: ['m/new.py'], clean: false });
  assert.strictEqual(introduced(before, { counts: { 'm/a.py': { E501: 1 }, 'm/new.py': {} }, unformatted: new Set() }).violations, 0, 'fixing old violations is not negative');
});

test('proof lint: a ruff that did not run fails loudly; renames compare with the old file; counts are per code', () => {
  // Found by the independent review: a missing ruff read as clean, a renamed
  // file's old violations counted as new, and a removed violation hid a new one.
  const { changedPython, introduced, ruffStatus } = require('../bench/pilot/mealie/proof-lint');
  assert.throws(() => ruffStatus({ status: null, error: new Error('spawn ruff ENOENT') }, 'ruff check'), /ruff check did not run/);
  assert.throws(() => ruffStatus({ status: 2, stderr: 'invalid config' }, 'ruff check'), /ruff check exited 2/);
  assert.doesNotThrow(() => ruffStatus({ status: 1 }, 'ruff check'));
  const patch = ['diff --git a/m/old.py b/m/new.py', 'similarity index 90%', 'rename from m/old.py', 'rename to m/new.py', '--- a/m/old.py', '+++ b/m/new.py', 'diff --git a/m/a b.py b/m/a b.py', '--- a/m/a b.py\t', '+++ b/m/a b.py\t'].join('\n');
  assert.deepStrictEqual(changedPython(patch), [{ path: 'm/new.py', before: 'm/old.py' }, { path: 'm/a b.py', before: 'm/a b.py' }]);
  const before = { counts: { 'm/a.py': { F401: 1, E501: 1 } }, unformatted: new Set() };
  assert.deepStrictEqual(introduced(before, { counts: { 'm/a.py': { E501: 1, B904: 1 } }, unformatted: new Set() }), { violations: 1, codes: ['B904'], unformatted: [], clean: false }, 'removing F401 does not hide the new B904');
});

test('proof run: the primary verdict waits for stage 2, needs runs on the hard items, and follows the test\'s sign; empty inputs do not throw', () => {
  // Found by the independent review of the report: with 3 hard items and no
  // stage 2 it printed no primary line, with no stage-2 runs "missed 0/0",
  // "met" ignored the test's sign, and 0 engine runs threw.
  const { report } = require('../bench/pilot/proof');
  const row = (process, task, variant, ok) => ({ process, task, variant, hiddenPassed: ok ? 2 : 1, hiddenTotal: 2, durationMs: 60000, usage: { costUsd: 1 }, engine: variant === 'engine' ? { delivered: true, auditOk: true } : undefined });
  const stage1 = ['a', 'b', 'c'].flatMap((t) => [row('w1', t, 'without', false), row('e1', t, 'engine', true)]);
  const labels = { 'w1:a:1': { label: 'agent-error' }, 'w1:b:1': { label: 'agent-error' }, 'w1:c:1': { label: 'agent-error' } };
  assert.match(report({ stage1, stage2: null, labels }), /Primary:\*\* pending: 3 hard items, stage 2 not run yet/);
  assert.match(report({ stage1, stage2: [row('w2', 'z', 'without', true)], labels }), /Primary:\*\* no verdict: no stage-2 run on the hard items/);
  const stage2 = ['a', 'b', 'c'].flatMap((t) => [0, 1, 2, 3].flatMap(() => [row('w2', t, 'without', true), row('e2', t, 'engine', false)]));
  assert.match(report({ stage1, stage2, labels }), /Primary:\*\* missed: engine 0\/12, bare 12\/12/, 'the bare agent ahead is not met');
  const bareOnly = [row('w1', 'a', 'without', true)];
  assert.doesNotThrow(() => report({ stage1: bareOnly, stage2: null, labels: {}, friction: { refusals: 0, unlabelled: [], false: 0, runs: 0, perRun: null } }));
  assert.match(report({ stage1: bareOnly, stage2: null, labels: {}, friction: { refusals: 0, unlabelled: [], false: 0, runs: 0, perRun: null } }), /Friction:\*\* no verdict: no engine run/);
  assert.match(report({ stage1: [{ ...row('w1', 'a', 'without', true), durationMs: undefined }], stage2: null, labels: {} }), /Median run time: engine — min, bare — min/);
});
