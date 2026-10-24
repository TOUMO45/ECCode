'use strict';
// The realbugs suite: twenty real bugs (BugsInPy) at their pre-fix commits.
// Always checked: every task is well formed, matches the recorded selection,
// and its bug report gives away neither the fix's code nor its files. With
// ECCODE_REALBUGS_VALIDATE=1 (and the environments from _tools/setup.sh in
// ECCODE_REALBUGS_VENVS, and network access for the first clone), every task
// is run for real: the untouched pre-fix tree fails the bug check and passes
// the regression check, and the real fix passes both.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const bench = require('../lib/bench');

const SUITE = path.join(__dirname, '..', 'bench', 'suites', 'realbugs');
const tasks = bench.listTasks(SUITE);
const selection = JSON.parse(fs.readFileSync(path.join(SUITE, '_tools', 'selection.json'), 'utf8'));

test('realbugs: twenty tasks, exactly the recorded draw, each well formed', () => {
  const drawn = Object.entries(selection.accepted).flatMap(([p, bugs]) => bugs.map((b) => `${p}-${b}`)).sort();
  assert.strictEqual(drawn.length, 20);
  assert.deepStrictEqual(tasks.map((t) => t.id).sort(), drawn, 'the suite is the draw, no more and no fewer');
  for (const [project, bugs] of Object.entries(selection.accepted)) {
    // The draw takes the shuffled order front to back, skipping only recorded exclusions.
    const skipped = new Set(selection.excluded.map((e) => e.id));
    const taken = selection.order[project].filter((b) => !skipped.has(`${project}-${b}`)).slice(0, bugs.length);
    assert.deepStrictEqual(taken, bugs, `${project}: accepted bugs follow the seeded order`);
  }
  for (const t of tasks) {
    assert.match(t.source.commit, /^[0-9a-f]{40}$/, t.id);
    assert.match(t.source.repo, /^https:\/\/github\.com\//, t.id);
    assert.match(t.env.PATH, /^\$\{ECCODE_REALBUGS_VENVS\}\/(py38|black|thefuck)\/bin:\$\{PATH\}$/, t.id);
    assert.deepStrictEqual(t.hiddenChecks.map((c) => c.id), ['bug', 'regression'], t.id);
    for (const c of t.hiddenChecks) assert.match(c.command, /^node \.bench-hidden\/place\.js && python -m pytest /, t.id);
    assert.ok(t.measured.bugTests.length >= 1 && t.measured.regressionTests >= 1, `${t.id}: a bug test and a regression set`);
    for (const f of t.measured.hiddenFiles) assert.ok(fs.existsSync(path.join(t.dir, 'hidden', 'files', f)), `${t.id}: ${f}`);
    assert.ok(fs.existsSync(path.join(t.dir, 'reference', 'fix.patch')), `${t.id}: the real fix is kept for validation`);
    assert.ok(t.prompt.length > 80 && /Tests: `python -m pytest/.test(t.prompt), `${t.id}: a bug report that says how tests run`);
  }
});

test('realbugs: no bug report contains the fix\'s code or names a file it changes', () => {
  for (const t of tasks) {
    const patch = fs.readFileSync(path.join(t.dir, 'reference', 'fix.patch'), 'utf8');
    for (const f of t.measured.fixFiles) {
      // As a path of its own: tests/test_black.py does not name black.py.
      const named = new RegExp(`(?<![\\w/.-])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      assert.ok(!named.test(t.prompt), `${t.id}: the report names ${f}`);
    }
    const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter((l) => l.length >= 15 && !l.startsWith('#'));
    for (const line of added) assert.ok(!t.prompt.includes(line), `${t.id}: the report contains the fix line ${JSON.stringify(line)}`);
  }
});

test('realbugs: every report names the tests that already fail here, and says how its tests run', () => {
  for (const t of tasks) {
    for (const k of t.measured.failingBeforeAndAfter) assert.ok(t.prompt.includes(k), `${t.id}: the report must name ${k}, which fails before and after the fix in this environment`);
    assert.ok(!/Tests: `python -m pytest -q tqdm\/tests`/.test(t.prompt), `${t.id}: pytest collects no tqdm tests from the directory alone`);
  }
});

/** The concrete test command a report gives (none when it is a template like test/<file>.py), with the known failures left out. */
function statedCommand(t) {
  const m = t.prompt.match(/Tests: `([^`]+)`/);
  if (!m || m[1].includes('<')) return null;
  const known = t.measured.failingBeforeAndAfter.map((k) => (k.includes('::') ? ` --deselect ${k}` : ` --ignore=${k}`)).join('');
  return `${m[1]}${known}`;
}

const live = process.env.ECCODE_REALBUGS_VALIDATE === '1';
test('realbugs (live): the pre-fix tree fails the bug check, the real fix passes every check', { skip: live ? false : 'set ECCODE_REALBUGS_VALIDATE=1 with ECCODE_REALBUGS_VENVS (see bench/suites/realbugs/_tools/setup.sh)' }, () => {
  const only = process.env.ECCODE_REALBUGS_ONLY ? process.env.ECCODE_REALBUGS_ONLY.split(',') : null;
  const problems = [];
  for (const t of tasks.filter((x) => !only || only.includes(x.id))) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-realbugs-${t.id}-`));
    try {
      bench.materialize(t, dir);
      bench.placeHidden(t, dir);
      const before = Object.fromEntries(bench.runChecks(t, dir).map((c) => [c.id, c]));
      if (before.bug.passed) problems.push(`${t.id}: the bug check passes on the pre-fix tree`);
      if (!before.regression.passed) problems.push(`${t.id}: the regression check fails on the pre-fix tree:\n${before.regression.tail}`);
      const stated = statedCommand(t);
      if (stated) {
        const c = spawnSync(`${stated} --collect-only -q -p no:cacheprovider`, { cwd: dir, shell: true, encoding: 'utf8', env: require('../lib/util').commandEnv(bench.taskEnv(t)) });
        if (c.status !== 0) problems.push(`${t.id}: the report's test command does not collect cleanly on the pre-fix tree (exit ${c.status}):\n${`${c.stdout}${c.stderr}`.split('\n').slice(-4).join('\n')}`);
      }
      const r = spawnSync('git', ['apply', '--whitespace=nowarn', path.join(t.dir, 'reference', 'fix.patch')], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) {
        problems.push(`${t.id}: the real fix does not apply: ${r.stderr}`);
        continue;
      }
      for (const c of bench.runChecks(t, dir)) if (!c.passed) problems.push(`${t.id}: ${c.id} fails with the real fix:\n${c.tail}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepStrictEqual(problems, []);
});

test('bench source fixtures: a pinned commit is exported without its history, from a mirror cloned once', () => {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-origin-'));
  const g = (args, cwd = origin) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  g(['init', '-q']);
  fs.writeFileSync(path.join(origin, 'a.py'), 'BUG = 1\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'buggy']);
  const buggy = g(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(origin, 'a.py'), 'BUG = 0\n');
  fs.writeFileSync(path.join(origin, 'test_a.py'), 'from a import BUG\ndef test_a():\n    assert BUG == 0\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'the fix']);
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-cache-'));
  const saved = process.env.ECCODE_BENCH_CACHE;
  process.env.ECCODE_BENCH_CACHE = cache;
  try {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-export-'));
    bench.exportSource({ repo: origin, commit: buggy }, dest);
    assert.strictEqual(fs.readFileSync(path.join(dest, 'a.py'), 'utf8'), 'BUG = 1\n', 'the pinned commit, not the latest');
    assert.ok(!fs.existsSync(path.join(dest, 'test_a.py')), 'nothing from after the commit');
    assert.ok(!fs.existsSync(path.join(dest, '.git')), 'no history: the fix is not reachable from the sandbox');
    assert.strictEqual(fs.readdirSync(cache).filter((f) => f.endsWith('.git')).length, 1, 'one mirror in the cache');
    const again = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-export-'));
    bench.exportSource({ repo: origin, commit: buggy }, again);
    assert.strictEqual(fs.readdirSync(cache).length, 1, 'the second export reuses the mirror');
    assert.throws(() => bench.exportSource({ repo: origin, commit: 'abc' }, again), /40-character/);
    // A commit made after the mirror was cloned is fetched into it, not missed.
    fs.writeFileSync(path.join(origin, 'a.py'), 'BUG = 2\n');
    g(['commit', '-qam', 'later']);
    const later = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-export-'));
    bench.exportSource({ repo: origin, commit: g(['rev-parse', 'HEAD']) }, later);
    assert.strictEqual(fs.readFileSync(path.join(later, 'a.py'), 'utf8'), 'BUG = 2\n');
    fs.rmSync(later, { recursive: true, force: true });
    assert.throws(() => bench.exportSource({ repo: origin, commit: 'f'.repeat(40) }, again), /not in|fatal|Command failed/);
    for (const d of [dest, again]) fs.rmSync(d, { recursive: true, force: true });
    // ${NAME} in a task's environment comes from the bench's own environment, or stops the run.
    assert.deepStrictEqual(bench.taskEnv({ id: 't', env: { P: '${ECCODE_BENCH_CACHE}/bin' } }), { P: `${cache}/bin` });
    assert.throws(() => bench.taskEnv({ id: 't', env: { P: '${ECCODE_NOT_SET_ANYWHERE}' } }), /needs ECCODE_NOT_SET_ANYWHERE/);
  } finally {
    if (saved === undefined) delete process.env.ECCODE_BENCH_CACHE;
    else process.env.ECCODE_BENCH_CACHE = saved;
    for (const d of [origin, cache]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('debug and method variants end to end on a source task: the debug track delivers, the report and tally compare both with without', () => {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-origin-'));
  const g = (args, cwd = origin) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  g(['init', '-q']);
  fs.mkdirSync(path.join(origin, 'src'));
  fs.mkdirSync(path.join(origin, 'tests'));
  fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(origin, 'src', 'price.js'), 'module.exports = { price: (n) => (n > 10 ? n * 9 : n * 10) };\n');
  fs.writeFileSync(path.join(origin, 'tests', 'price.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { price } = require('../src/price');\ntest('price', () => assert.strictEqual(price(2), 20));\n");
  g(['add', '-A']);
  g(['commit', '-qm', 'buggy']);
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-suite-'));
  const dir = path.join(suite, 'shop-1');
  fs.mkdirSync(path.join(dir, 'hidden'), { recursive: true });
  fs.mkdirSync(path.join(suite, '_hidden'));
  fs.writeFileSync(path.join(suite, '_hidden', 'flag.js'), "process.exit(process.env.BENCH_FLAG === 'on' ? 0 : 1);\n");
  fs.writeFileSync(path.join(dir, 'hidden', 'bug.js'), "const { price } = require('../src/price');\nprocess.exit(price(10) === 90 && price(12) === 108 ? 0 : 1);\n");
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
    id: 'shop-1',
    source: { repo: origin, commit: g(['rev-parse', 'HEAD']) },
    env: { BENCH_FLAG: '${ECCODE_TEST_BENCH_FLAG}' },
    prompt: 'Orders of 10 items get no bulk discount; from 10 items the price is 9 per item.',
    hiddenChecks: [{ id: 'bug', command: 'node .bench-hidden/bug.js' }, { id: 'env', command: 'node .bench-hidden/flag.js' }],
  }));
  const saved = { cache: process.env.ECCODE_BENCH_CACHE, flag: process.env.ECCODE_TEST_BENCH_FLAG };
  process.env.ECCODE_BENCH_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-cache-'));
  process.env.ECCODE_TEST_BENCH_FLAG = 'on';
  try {
    const t = bench.listTasks(suite)[0];
    const agent = path.join(__dirname, 'bench-reference', 'realbugs', 'fake-debug-agent.js');
    const debug = bench.runOnce(t, { agentCmd: `node "${agent}"`, variant: 'debug' });
    assert.strictEqual(debug.agentExit, 0, JSON.stringify(debug.checks));
    assert.deepStrictEqual([debug.hiddenPassed, debug.hiddenTotal], [2, 2], 'the fix passes, and the task environment reached the hidden checks');
    assert.deepStrictEqual({ delivered: debug.engine.delivered, auditOk: debug.engine.auditOk, reviews: debug.engine.reviews, track: debug.engine.track, fixProven: debug.engine.fixProven }, { delivered: true, auditOk: true, reviews: 1, track: 'debug', fixProven: true });
    assert.ok(debug.engine.mutation && debug.engine.mutation.total >= 1 && debug.engine.mutation.killed >= 1, JSON.stringify(debug.engine.mutation));
    // The method variant: the debugging method's text, nothing installed.
    const method = bench.runOnce(t, { agentCmd: 'node -e "const p=require(\'fs\').readFileSync(\'PROMPT.md\',\'utf8\'); process.exit(/Debug investigation/.test(p) && !require(\'fs\').existsSync(\'.claude\') ? 0 : 3)"', variant: 'method' });
    assert.strictEqual(method.agentExit, 0, 'the method prompt carries the debug-investigation text and no toolkit is installed');
    assert.strictEqual(method.engine, undefined);
    const without = bench.runOnce(t, { agentCmd: 'node -e ""', variant: 'without' });
    assert.deepStrictEqual(without.checks.map((c) => c.passed), [false, true], 'untouched: the bug check fails');
    const md = bench.report([without, method, debug], { agentCmd: 'claude -p --model m2' });
    assert.match(md, /## Debug track vs without/);
    assert.match(md, /\| shop-1 \| 0\/1 → 1\/1 \| Fisher 1\.000 \| bug 1; none \| — → 370 \| — → 0\.20 \|/);
    assert.match(md, /delivered, audit ok, 1 reviews, fix proven, mutants \d+\/\d+ killed \|/, 'the raw row carries the debug proofs');
    assert.match(md, /## Method text vs without/);
    assert.match(md, /\| shop-1 \| 0\/1 → 0\/1 \|[^\n]*\| — \|\n/, 'no engine record for the method text');
    const quick = { ...debug, variant: 'engine', hiddenPassed: 1, checks: debug.checks.map((c) => ({ ...c, passed: c.id !== 'bug' })), engine: { ...debug.engine, track: 'quick' } };
    const vsEngine = bench.report([without, debug, quick], { agentCmd: 'claude -p --model m2' });
    assert.match(vsEngine, /## Debug track vs engine \(quick track\)\n[\s\S]*\| shop-1 \| 0\/1 → 1\/1 \| Fisher 1\.000 \| bug 1; none \|/, 'debug is compared with the quick track too');
    assert.doesNotMatch(md, /vs engine/, 'and only when both ran');
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tally-'));
    fs.writeFileSync(path.join(tdir, 'r.md'), md);
    const tl = bench.tally(tdir);
    assert.strictEqual(tl.engine.m2.debug.allPass, 1);
    assert.strictEqual(tl.engine.m2.debug.delivered, 1);
    assert.strictEqual(tl.engine.m2.method.runs, 1);
    assert.strictEqual(tl.engine.m2.engine.runs, 0);
    fs.rmSync(tdir, { recursive: true, force: true });
  } finally {
    fs.rmSync(process.env.ECCODE_BENCH_CACHE, { recursive: true, force: true });
    for (const [k, v] of [['ECCODE_BENCH_CACHE', saved.cache], ['ECCODE_TEST_BENCH_FLAG', saved.flag]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of [origin, suite]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('bench warns when the temporary directory is too long for Unix-socket tests', () => {
  assert.strictEqual(bench.tmpdirWarning('/tmp'), null);
  assert.match(bench.tmpdirWarning(`/tmp/${'x'.repeat(120)}`), /AF_UNIX path too long[\s\S]*Set TMPDIR to a short directory/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tmpdir-'));
  const long = path.join(dir, 'x'.repeat(70));
  fs.mkdirSync(long);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'eccode.js'), 'bench', '--suite', path.join(__dirname, '..', 'bench', 'suites', 'engine'), '--tasks', 'search-case', '--variant', 'without', '--agent', 'node -e ""'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: long, TMP: long, TEMP: long } });
  assert.match(r.stderr, /bench: WARNING: the temporary directory is \d+ characters long/);
  fs.rmSync(dir, { recursive: true, force: true });
});
