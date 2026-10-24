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
