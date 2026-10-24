'use strict';
// Benchmark harness: scripted agents stand in for a model, so the tests prove
// the measurements (hidden checks, lines, dependencies, tests) discriminate
// between a lean solution and a bloated or symptom-patched one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const bench = require('../lib/bench');

const GOOD_RELATIVE = `
function formatRelative(thenMs, nowMs) {
  const diff = nowMs - thenMs;
  const abs = Math.abs(diff);
  if (abs < 60000) return 'just now';
  const units = [[86400000, 'day'], [3600000, 'hour'], [60000, 'minute']];
  const [ms, unit] = units.find(([m]) => abs >= m);
  const n = Math.floor(abs / ms);
  return diff > 0 ? \`\${plural(n, unit)} ago\` : \`in \${plural(n, unit)}\`;
}
`;

function agentScript(body) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-agent-')), 'agent.js');
  fs.writeFileSync(file, `'use strict';\nconst fs = require('fs');\n${body}\n`);
  return `${process.execPath} ${JSON.stringify(file)}`;
}

// Solves relative-time the lean way: reuses plural(), adds a test, no deps.
const leanAgent = agentScript(`
let src = fs.readFileSync('src/format.js', 'utf8');
src = src.replace("module.exports = { plural, formatDate };", ${JSON.stringify(GOOD_RELATIVE.trim() + '\n\nmodule.exports = { plural, formatDate, formatRelative };')});
fs.writeFileSync('src/format.js', src);
fs.appendFileSync('src/format.test.js', "\\ntest('formatRelative', () => {\\n  assert.strictEqual(require('./format').formatRelative(0, 30000), 'just now');\\n});\\n");
`);

// Solves it too, but installs a library, duplicates the pluralizer and ships no test.
const bloatAgent = agentScript(`
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies = { 'humanize-duration': '^3.32.0' };
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
let src = fs.readFileSync('src/format.js', 'utf8');
const impl = ${JSON.stringify(GOOD_RELATIVE.replace(/plural\(/g, 'pluralWord(').trim())};
const extra = "function pluralWord(n, unit) {\\n  if (n === 1) return '1 ' + unit;\\n  return n + ' ' + unit + 's';\\n}\\n\\n// TODO: switch to humanize-duration once bundling is sorted\\nconst OPTIONS = { largest: 1, round: true, spacer: ' ' };\\n\\n" + impl;
src = src.replace('module.exports = { plural, formatDate };', extra + '\\n\\nmodule.exports = { plural, formatDate, formatRelative, OPTIONS };');
fs.writeFileSync('src/format.js', src);
`);

// "Fixes" the pagination bug in the caller instead of the shared function.
const symptomAgent = agentScript(`
let t = fs.readFileSync('src/tickets.js', 'utf8');
t = t.replace('return paginate(TICKETS, page, size);', 'return paginate(TICKETS, page, size + 1).slice(0, size);');
fs.writeFileSync('src/tickets.js', t);
`);

test('lean vs bloated solutions measure differently; both pass the functional hidden check', () => {
  const task = bench.listTasks(bench.DEFAULT_SUITE).find((t) => t.id === 'relative-time');
  const good = bench.runOnce(task, { agentCmd: leanAgent, variant: 'with' });
  const bloat = bench.runOnce(task, { agentCmd: bloatAgent, variant: 'without' });
  assert.deepStrictEqual([good.hiddenPassed, good.hiddenTotal], [2, 2], JSON.stringify(good.checks));
  assert.deepStrictEqual(good.newDeps, []);
  assert.strictEqual(good.testFilesChanged, 1);
  assert.ok(good.testLinesAdded > 0 && good.testLinesAdded < good.linesAdded, `test lines ${good.testLinesAdded} of ${good.linesAdded}`);
  assert.strictEqual(bloat.hiddenPassed, 1, 'functional check passes, no-new-deps check fails');
  assert.deepStrictEqual(bloat.newDeps, ['humanize-duration']);
  assert.strictEqual(bloat.testFilesChanged, 0);
  assert.strictEqual(bloat.testLinesAdded, 0);
  assert.ok(bloat.linesAdded > good.linesAdded, `bloat ${bloat.linesAdded} > lean ${good.linesAdded}`);
});

test('the root-cause hidden check rejects a caller-side patch', () => {
  const task = bench.listTasks(bench.DEFAULT_SUITE).find((t) => t.id === 'fix-last-page');
  const r = bench.runOnce(task, { agentCmd: symptomAgent, variant: 'without' });
  const rootCause = r.checks.find((c) => c.command.includes('root-cause'));
  assert.strictEqual(rootCause.passed, false);
  assert.match(rootCause.tail, /off-by-one is still in src\/paginate\.js/); // the shared bug survives a caller-side patch
});

test('the report pairs variants per task and keeps raw runs visible', () => {
  const task = bench.listTasks(bench.DEFAULT_SUITE).find((t) => t.id === 'relative-time');
  const records = [
    bench.runOnce(task, { agentCmd: leanAgent, variant: 'with' }),
    bench.runOnce(task, { agentCmd: bloatAgent, variant: 'without' }),
  ];
  const md = bench.report(records, { agentCmd: 'scripted' });
  assert.match(md, /\| relative-time \| without \| 1 \| 1\/2 \|/);
  assert.match(md, /\| relative-time \| with \| 1 \| 2\/2 \|/);
  assert.match(md, /\*\*paired Δ\*\*/);
  assert.match(md, /humanize-duration/);
  assert.match(md, /## Failed hidden checks/);
  assert.match(md, /demonstration, not a statistic/);
  // Test lines are reported apart from code lines, per run and per task.
  assert.match(md, /\| Agent exit \| Lines added in tests \|/);
  assert.match(md, /Median code lines added \(tests excluded\)/);
  const withRun = records[0];
  assert.match(md, new RegExp(`\\| relative-time \\| with \\| 2/2 \\| \\+${withRun.linesAdded}/−${withRun.linesRemoved} \\|[^\\n]*\\| ${withRun.testLinesAdded} \\|`));
});

test('the permutation test is exact: identical groups give p=1, separated groups the minimum p', () => {
  const sep = bench.permutationTest([10, 11, 12, 10, 11], [40, 44, 45, 42, 41]);
  assert.strictEqual(sep.splits, 252);
  assert.ok(sep.p <= 2 / 252 + 1e-9, `expected the minimal exact p, got ${sep.p}`);
  const same = bench.permutationTest([20, 21, 22], [20, 21, 22]);
  assert.strictEqual(same.p, 1);
  assert.strictEqual(bench.permutationTest([], [1]), null);
});

test('the with-variant prompt embeds the lean skill; the sandbox never holds the hidden checks during the run', () => {
  assert.match(bench.leanPrompt(), /smallest option that fully solves|Lean change/i);
  const task = bench.listTasks(bench.DEFAULT_SUITE).find((t) => t.id === 'csv-sum');
  const probeAgent = agentScript(`
if (fs.existsSync('.bench-hidden')) fs.writeFileSync('LEAKED', 'saw hidden checks');
const prompt = fs.readFileSync('PROMPT.md', 'utf8');
fs.writeFileSync('prompt-had-skill.txt', String(/lean/i.test(prompt)));
fs.appendFileSync('src/report.py', '\\n\\ndef sum_column(text, name):\\n    total = 0.0\\n    for row in parse_rows(text):\\n        try:\\n            total += float(row[name])\\n        except (KeyError, ValueError):\\n            pass\\n    return total\\n');
`);
  const r = bench.runOnce(task, { agentCmd: probeAgent, variant: 'with', keep: true });
  try {
    assert.ok(!fs.existsSync(path.join(r.sandbox, 'LEAKED')), 'hidden checks were visible to the agent');
    assert.strictEqual(fs.readFileSync(path.join(r.sandbox, 'prompt-had-skill.txt'), 'utf8'), 'true');
    assert.strictEqual(r.hiddenPassed >= 1, true, JSON.stringify(r.checks));
  } finally {
    fs.rmSync(r.sandbox, { recursive: true, force: true });
  }
});

test('tally recomputes headline numbers from recorded report files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tally-'));
  const report = (rows) => [
    '# ECCode paired benchmark', '', 'Agent command: `x`.', '',
    '| Task | Variant | n | Hidden checks | Median lines added | Runs adding a dependency | Runs changing a test | Median seconds |',
    '|---|---|---|---|---|---|---|---|',
    '| t | without | 2 | 4/4 | 10 | 0/2 | 0/2 | 5 |',
    '| t | **paired Δ** |  |  | -2 (exact permutation p=0.100 over 20 splits) |  |  |  |', '',
    '## Raw runs', '',
    '| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit |',
    '|---|---|---|---|---|---|---|---|',
    ...rows, '',
    '## Appendix', '', '| t | 1,2,3 | 4,5,6 | 0.5 |',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'a.md'), report([
    '| t | without | 2/2 | +10/−0 | — | 0 | 5 | 0 |',
    '| t | with | 1/2 | +8/−0 | lodash | 1 | 6 | 0 |',
  ]));
  // CRLF file with an agent failure; appendix rows must not count as runs
  fs.writeFileSync(path.join(dir, 'b.md'), report(['| t | with | 2/2 | +9/−1 | — | 1 | 7 | 1 |']).replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(dir, 'notes.md'), '# No raw runs section\n');
  const t = bench.tally(dir);
  assert.deepStrictEqual(t.total, { files: 2, runs: 3, hiddenPassed: 5, hiddenTotal: 6, depRuns: 1, agentFailures: 1, pairedSmaller: 1, pairedLarger: 0, pairedEqual: 0 }); // signs come from raw runs: only a.md has both variants; summary cells are ignored
  assert.strictEqual(t.perFile.length, 2);
  assert.deepStrictEqual(t.perFile[0], { file: 'a.md', model: 'unknown', runs: 2, hiddenPassed: 3, hiddenTotal: 4, depRuns: 1, agentFailures: 0 });
  assert.strictEqual(t.byModel.unknown.codeStratified, null, 'older reports record no test lines, so no tests-excluded figure is invented');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tally reports effects per model, and with tests excluded where reports record test lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tally-'));
  const file = (model, rows, header = '| Task | Variant | Hidden | Lines +/− | New deps | Test files | Seconds | Agent exit | Lines added in tests |') => [
    '# ECCode paired benchmark', '', `Agent command: \`claude -p --model ${model}\`.`, '', '## Raw runs', '', header, '|---|', ...rows, '',
  ].join('\n');
  // Model A shrinks diffs; model B grows them, entirely in test lines.
  fs.writeFileSync(path.join(dir, 'a.md'), file('alpha', [
    '| t | without | 1/1 | +20/−0 | — | 1 | 5 | 0 | 5 |', '| t | without | 1/1 | +22/−0 | — | 1 | 5 | 0 | 5 |',
    '| t | with | 1/1 | +10/−0 | — | 1 | 5 | 0 | 5 |', '| t | with | 1/1 | +12/−0 | — | 1 | 5 | 0 | 5 |',
  ]));
  fs.writeFileSync(path.join(dir, 'b.md'), file('beta', [
    '| t | without | 1/1 | +10/−0 | — | 0 | 5 | 0 | 0 |', '| t | without | 1/1 | +12/−0 | — | 0 | 5 | 0 | 0 |',
    '| t | with | 1/1 | +20/−0 | — | 1 | 5 | 0 | 10 |', '| t | with | 1/1 | +22/−0 | — | 1 | 5 | 0 | 10 |',
  ]));
  const t = bench.tally(dir);
  assert.deepStrictEqual(Object.keys(t.byModel), ['alpha', 'beta']);
  assert.strictEqual(t.byModel.alpha.stratified.delta, -10);
  assert.strictEqual(t.byModel.beta.stratified.delta, 10);
  assert.strictEqual(t.byModel.beta.codeStratified.delta, 0, 'with tests excluded, beta wrote the same code');
  assert.deepStrictEqual(t.byModel.beta.testsWith, { wrote: 2, runs: 2 });
  assert.deepStrictEqual(t.byModel.beta.testsWithout, { wrote: 0, runs: 2 });
  assert.strictEqual(t.stratified.delta, 0, 'the pooled figure hides both effects, which is why tally prints per model');
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'eccode.js'), 'bench', 'tally', '--dir', dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir } });
  assert.match(out.stdout, /beta: 4 paired-variant runs; mean with-without = 10\.00 lines/);
  assert.match(out.stdout, /tests excluded \(4 runs that record test lines\): 0\.00 lines/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the report header grades its own sample size', () => {
  const rec = (task, variant, lines) => ({ task, variant, hiddenPassed: 2, hiddenTotal: 2, linesAdded: lines, linesRemoved: 0, newDeps: [], testFilesChanged: 1, durationMs: 1000, agentExit: 0, filesChanged: 1, checks: [] });
  const small = bench.report([rec('t', 'without', 10), rec('t', 'with', 8)], { agentCmd: 'x' });
  assert.match(small, /demonstration, not a statistic/);
  const many = [];
  for (let i = 0; i < 10; i++) { many.push(rec('t', 'without', 10 + i)); many.push(rec('t', 'with', 8 + i)); }
  const big = bench.report(many, { agentCmd: 'x' });
  assert.match(big, /n >= 10 times per task\. The exact permutation test enumerates every split/);
  assert.doesNotMatch(big, /demonstration, not a statistic/);
});

test('stratified permutation: within-batch shuffles, batch effects cancel, seeded and reproducible', () => {
  const rows = (stratum, variant, xs) => xs.map((lines) => ({ stratum, variant, lines }));
  // A consistent within-stratum effect across four strata is detected ...
  const effect = [
    ...rows('a|t1', 'without', [20, 22, 21, 23, 20]), ...rows('a|t1', 'with', [15, 16, 14, 17, 15]),
    ...rows('b|t2', 'without', [40, 42, 41, 43, 40]), ...rows('b|t2', 'with', [35, 36, 34, 37, 35]),
    ...rows('c|t3', 'without', [12, 11, 13, 12, 11]), ...rows('c|t3', 'with', [8, 7, 9, 8, 7]),
    ...rows('d|t4', 'without', [30, 31, 29, 32, 30]), ...rows('d|t4', 'with', [25, 26, 24, 27, 25]),
  ];
  const sig = bench.stratifiedTest(effect, { resamples: 2000 });
  assert.ok(sig.p < 0.01, `expected small p, got ${sig.p}`);
  assert.ok(sig.delta < -4 && sig.delta > -6, `delta ${sig.delta}`);
  // ... while strata with wildly different baselines but NO within-stratum
  // effect stay null: batch differences alone cannot manufacture significance.
  const baselineOnly = [
    ...rows('big|t', 'without', [100, 104, 98, 102]), ...rows('big|t', 'with', [101, 99, 103, 102]),
    ...rows('small|t', 'without', [10, 12, 9, 11]), ...rows('small|t', 'with', [11, 10, 12, 9]),
  ];
  const nul = bench.stratifiedTest(baselineOnly, { resamples: 2000 });
  assert.ok(nul.p > 0.1, `expected large p for baseline-only differences, got ${nul.p}`);
  // Seeded: the same input yields the same p, so a published figure reproduces.
  assert.strictEqual(bench.stratifiedTest(effect, { resamples: 2000 }).p, sig.p);
  // A stratum missing one variant is excluded rather than guessed at.
  assert.strictEqual(bench.stratifiedTest(rows('x|t', 'with', [1, 2, 3]), {}), null);
});

test('permutation test falls back to seeded Monte Carlo above the exact cap', () => {
  const a = Array.from({ length: 25 }, (_, i) => 35 + (i % 5)); // clearly separated groups
  const b = Array.from({ length: 25 }, (_, i) => 46 + (i % 5));
  const r = bench.permutationTest(a, b);
  assert.strictEqual(r.monteCarlo, true);
  assert.strictEqual(r.splits, 100000);
  assert.ok(r.p < 0.001, `expected tiny p for separated groups, got ${r.p}`);
  assert.strictEqual(bench.permutationTest(a, b).p, r.p); // seeded: reproducible
  const same = bench.permutationTest(a, a.slice());
  assert.ok(same.p > 0.9, `identical groups should be null-ish, got ${same.p}`);
  // Small samples keep the exact path, unchanged.
  const exact = bench.permutationTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  assert.strictEqual(exact.splits, 252);
  assert.ok(!exact.monteCarlo);
});

test('report header names the test it actually used, and floors read as upper bounds', () => {
  const rec = (variant, lines) => ({ task: 't', variant, hiddenPassed: 1, hiddenTotal: 1, linesAdded: lines, linesRemoved: 0, newDeps: [], testFilesChanged: 1, durationMs: 1000, agentExit: 0, filesChanged: 1, checks: [] });
  const big = [];
  for (let i = 0; i < 25; i++) big.push(rec('without', 40 + (i % 5)), rec('with', 20 + (i % 5)));
  const md = bench.report(big, { agentCmd: 'x' });
  assert.doesNotMatch(md, /so the p-values are exact/); // n=25 uses Monte Carlo, so "exact" would be false
  assert.match(md, /seeded Monte Carlo permutation test/);
  assert.match(md, /Monte Carlo permutation p≤/); // fully separated: no resample as extreme
  const ten = [];
  for (let i = 0; i < 10; i++) ten.push(rec('without', 10 + i), rec('with', 5 + i));
  assert.match(bench.report(ten, { agentCmd: 'x' }), /so the p-values are exact/); // C(20,10) splits: enumerable
});

test('follow-up suite: every task fails on its fixture, passes with its reference, and catches an added dependency', () => {
  const has = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
  const need = { 'py-median': has('pytest', ['--version']), 'go-truncate': has('go', ['version']) };
  const suite = path.join(__dirname, '..', 'bench', 'suites', 'followup');
  const tasks = bench.listTasks(suite);
  assert.deepStrictEqual(tasks.map((t) => t.id).sort(), ['go-truncate', 'parse-duration', 'py-median', 'top-words']);
  const addDep = {
    'top-words': "const f='package.json',p=JSON.parse(require('fs').readFileSync(f));p.dependencies={lodash:'^4'};require('fs').writeFileSync(f,JSON.stringify(p))",
    'parse-duration': "const f='package.json',p=JSON.parse(require('fs').readFileSync(f));p.dependencies={ms:'^2'};require('fs').writeFileSync(f,JSON.stringify(p))",
    'py-median': "const f='pyproject.toml',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('dependencies = []','dependencies = [\"numpy\"]'))",
    'go-truncate': "require('fs').appendFileSync('go.mod','\\nrequire golang.org/x/text v0.14.0\\n')",
  };
  for (const t of tasks) {
    if (need[t.id] === false && !process.env.ECCODE_REQUIRE_TRACERS) continue; // toolchain absent on this runner
    const ref = path.join(__dirname, 'bench-reference', `${t.id}.js`);
    const noop = bench.runOnce(t, { agentCmd: 'node -e ""', variant: 'without' });
    assert.strictEqual(noop.checks[0].passed, false, `${t.id}: the functional check must fail on the untouched fixture`);
    const good = bench.runOnce(t, { agentCmd: `node "${ref}"`, variant: 'with' });
    assert.deepStrictEqual([good.hiddenPassed, good.hiddenTotal], [2, 2], `${t.id}: ${JSON.stringify(good.checks)}`);
    assert.ok(good.testLinesAdded > 0 && good.testLinesAdded < good.linesAdded, `${t.id}: test lines counted apart`);
    const dep = bench.runOnce(t, { agentCmd: `node "${ref}" && node -e "${addDep[t.id].replace(/"/g, '\\"')}"`, variant: 'with' });
    assert.strictEqual(dep.checks[1].passed, false, `${t.id}: the no-new-deps check must catch an added dependency`);
  }
});

test('engine suite: every task fails untouched, passes with its good reference, and its careless reference passes the visible tests but fails a hidden regression check', () => {
  const has = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
  const pytest = has('pytest', ['--version']);
  const suite = path.join(__dirname, '..', 'bench', 'suites', 'engine');
  const tasks = bench.listTasks(suite);
  assert.deepStrictEqual(tasks.map((t) => t.id).sort(), ['extract-pricing', 'search-case', 'stock-reorder', 'utc-month']);
  const visible = { 'search-case': 'npm test', 'extract-pricing': 'npm test', 'stock-reorder': 'pytest -q', 'utc-month': 'pytest -q' };
  for (const t of tasks) {
    if (visible[t.id].startsWith('pytest') && !pytest && !process.env.ECCODE_REQUIRE_TRACERS) continue;
    const ids = bench.hiddenChecksOf(t).map((c) => c.id);
    assert.ok(ids.includes('feature') && ids.includes('no-new-deps') && ids.length === 3, `${t.id}: ${ids}`);
    const ref = (kind) => path.join(__dirname, 'bench-reference', 'engine', `${t.id}.${kind}.js`);
    const noop = bench.runOnce(t, { agentCmd: 'node -e ""', variant: 'without' });
    assert.strictEqual(noop.checks.find((c) => c.id === 'feature').passed, false, `${t.id}: the feature check must fail on the untouched fixture`);
    const good = bench.runOnce(t, { agentCmd: `node "${ref('good')}" && ${visible[t.id]}`, variant: 'without' });
    assert.strictEqual(good.agentExit, 0, `${t.id}: the good reference passes the visible tests`);
    assert.deepStrictEqual([good.hiddenPassed, good.hiddenTotal], [3, 3], `${t.id}: ${JSON.stringify(good.checks)}`);
    const careless = bench.runOnce(t, { agentCmd: `node "${ref('careless')}" && ${visible[t.id]}`, variant: 'without' });
    assert.strictEqual(careless.agentExit, 0, `${t.id}: the careless reference passes the visible tests (the trap is invisible to them)`);
    const failed = careless.checks.filter((c) => !c.passed).map((c) => c.id);
    assert.ok(failed.some((id) => id !== 'feature' && id !== 'no-new-deps'), `${t.id}: the careless change must fail a regression check, failed: ${failed}`);
  }
});

test('engine variant: the toolkit is installed and committed first, the record is read back, usage is parsed, and tooling never counts as the change', () => {
  const suite = path.join(__dirname, '..', 'bench', 'suites', 'engine');
  const t = bench.listTasks(suite).find((x) => x.id === 'search-case');
  const ref = path.join(__dirname, 'bench-reference', 'engine');
  const r = bench.runOnce(t, { agentCmd: `node "${path.join(ref, 'fake-engine-agent.js')}" "${path.join(ref, 'search-case.good.js')}" "npm test"`, variant: 'engine', keep: true });
  try {
    assert.strictEqual(r.agentExit, 0, JSON.stringify(r.checks));
    assert.deepStrictEqual([r.hiddenPassed, r.hiddenTotal], [3, 3]);
    assert.deepStrictEqual({ ...r.engine }, { initialized: true, delivered: true, auditOk: true, reviews: 2, changesRequested: 0, runsRecorded: 1, tokensReported: 1234, toolkitChanged: false, agents: 'inherit', track: 'quick' });
    assert.match(fs.readFileSync(path.join(r.sandbox, '.claude', 'agents', 'technical-reviewer.md'), 'utf8'), /^model: inherit$/m, 'same model throughout: the process is compared, not a model mix');
    assert.deepStrictEqual(r.usage, { answer: null, costUsd: 0.4321, tokens: 1365, outputTokens: 55, turns: 12, subagents: 4 });
    assert.ok(r.linesAdded > 0 && r.linesAdded < 30, `only the change counts, not .claude/ or .eccode/: ${r.linesAdded}`);
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: r.sandbox, encoding: 'utf8' });
    assert.match(log, /eccode toolkit\nfixture/);
    const md = bench.report([r, { ...r, variant: 'without', engine: undefined, usage: null, hiddenPassed: 2, checks: r.checks.map((c, i) => ({ ...c, passed: i !== 1 })) }], { agentCmd: 'x --model m1' });
    assert.match(md, /## Engine vs without/);
    assert.match(md, /\| search-case \| 0\/1 → 1\/1 \| Fisher 1\.000 \| regression 1; none \| — → 1365 \|/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-tally-'));
    fs.writeFileSync(path.join(dir, 'e.md'), md);
    const tl = bench.tally(dir);
    assert.deepStrictEqual(tl.engine.m1.engine, { runs: 1, allPass: 1, medianTokens: 1365, medianCostUsd: 0.4321, medianSeconds: Math.round(r.durationMs / 1000), delivered: 1, auditOk: 1 });
    assert.deepStrictEqual(tl.engine.m1.without, { runs: 1, allPass: 0, medianTokens: null, medianCostUsd: null, medianSeconds: Math.round(r.durationMs / 1000), delivered: 0, auditOk: 0 });
    assert.strictEqual(tl.stratified, null, 'engine rows never enter the lean-skill strata');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    fs.rmSync(r.sandbox, { recursive: true, force: true });
  }
});

test('usageOf reads the agent result line (json or stream-json) and nothing else', () => {
  assert.strictEqual(bench.usageOf('plain text output'), null);
  assert.strictEqual(bench.usageOf('{"type":"assistant"}\n'), null);
  const line = JSON.stringify({ type: 'result', result: 'Delivered.', total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } });
  assert.deepStrictEqual(bench.usageOf(`{"type":"system"}\n${line}\n`), { answer: 'Delivered.', costUsd: 0.01, tokens: 18, outputTokens: 4, turns: 2, subagents: null });
});

test('bench --save keeps every finished run on disk, and bench report rebuilds the report from them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-save-'));
  const save = path.join(dir, 'runs.jsonl');
  const cli = path.join(__dirname, '..', 'bin', 'eccode.js');
  const suite = path.join(__dirname, '..', 'bench', 'suites', 'engine');
  let r = spawnSync(process.execPath, [cli, 'bench', '--suite', suite, '--tasks', 'search-case', '--variant', 'without', '--runs', '2', '--agent', 'node -e ""', '--save', save], { encoding: 'utf8', cwd: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = fs.readFileSync(save, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2, 'one line per finished run');
  r = spawnSync(process.execPath, [cli, 'bench', 'report', save, '--agent', 'x --model m', '--out', path.join(dir, 'r.md')], { encoding: 'utf8', cwd: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'r.md'), 'utf8'), /\| search-case \| without \| 2\/3 \| \+0\/−0 \|/, 'the untouched fixture fails only its feature check');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Mealie pilot: run under a Claude Code session, every benchmark session
// inherited its session id, so the items of a chain (one sandbox) appended to
// one transcript file. Each agent starts as its own session.
test('the agent does not inherit the operator session\'s Claude Code identity', () => {
  const inherited = {
    CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_REMOTE_SESSION_ID: 'parent', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_PID: '1',
    CLAUDE_AFTER_LAST_COMPACT: '1', CLAUDE_CODE_MESSAGING_SOCKET: '/s', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ATTENDED: '1',
    // the launching session's own settings: effort, background subagents, spawn depth, compaction, debug output
    CLAUDE_EFFORT: 'xhigh', CLAUDE_AUTO_BACKGROUND_TASKS: 'true', CLAUDE_CODE_BG_TASKS_REPORT_RUNNING: '0', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50', CLAUDE_CODE_DIAGNOSTICS_FILE: '/d', CLAUDE_CODE_DEBUG: '1',
  };
  const env = bench.agentEnv({ ...inherited, ANTHROPIC_BASE_URL: 'https://api', PATH: '/bin', NODE_TEST_CONTEXT: 'child' });
  for (const k of Object.keys(inherited)) assert.ok(!(k in env), k);
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://api', 'what the agent needs to reach the API stays');
  assert.strictEqual(env.PATH, '/bin');
  assert.ok(!('NODE_TEST_CONTEXT' in env));
});

// Final review: a denylist missed the launcher's extra directories, plugin and
// skill sync, remote-session handles and entrypoint. Only authentication and
// the model provider pass; every other Claude Code variable is the launcher's.
test('the agent keeps only the Claude Code variables that authenticate it or pick its provider', () => {
  const launcher = {
    CLAUDE_ADDITIONAL_DIRECTORIES: '/mnt/user-data', CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1', CLAUDE_CODE_SYNC_PLUGINS: '1', CLAUDE_CODE_SYNC_SKILLS: '1',
    CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SDK_URL: 'https://x', CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/t', CLAUDE_CODE_TEE_SDK_STDOUT: 'true',
    CLAUDE_CODE_ENTRYPOINT: 'remote_desktop', CLAUDE_CODE_SOME_FUTURE_SETTING: '1',
  };
  const auth = { CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', CLAUDE_CODE_CLIENT_CERT: '/cert' };
  const env = bench.agentEnv({ ...launcher, ...auth, ANTHROPIC_API_KEY: 'k', ECCODE_BENCH_VARIANT: 'engine' });
  for (const k of Object.keys(launcher)) assert.ok(!(k in env), k);
  for (const [k, v] of Object.entries(auth)) assert.strictEqual(env[k], v, k);
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'k');
  assert.strictEqual(env.ECCODE_BENCH_VARIANT, 'engine');
});

// Mealie pilot, after-fix check: processes an agent left running kept writing
// into the sandbox, removing it failed (ENOTEMPTY) and the run's record was lost.
test('an agent\'s leftover processes are stopped when it exits, and the run is kept', { skip: process.platform === 'win32' && 'process groups are POSIX' }, () => {
  const task = bench.listTasks(path.join(__dirname, '..', 'bench', 'suites', 'followup')).find((t) => t.id === 'top-words');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-linger-'));
  const beat = path.join(tmp, 'beat');
  // The writer outlives the run it must be stopped with, but never by more than a
  // minute: if the harness fails to stop it, it must not fill the disk (it did once).
  fs.writeFileSync(path.join(tmp, 'writer.js'), `const fs = require('fs'); let i = 0;\nsetInterval(() => { fs.writeFileSync('junk' + (i++) + '.txt', 'x'); fs.appendFileSync(${JSON.stringify(beat)}, '.'); }, 5);\nsetTimeout(() => process.exit(0), 60000);\n`);
  fs.writeFileSync(path.join(tmp, 'agent.js'), `require('child_process').spawn(process.execPath, [${JSON.stringify(path.join(tmp, 'writer.js'))}], { stdio: 'ignore' }).unref();\n`);
  const r = bench.runOnce(task, { agentCmd: `node "${path.join(tmp, 'agent.js')}"`, variant: 'without' });
  assert.strictEqual(r.task, 'top-words', 'the run is recorded');
  const size = () => (fs.existsSync(beat) ? fs.statSync(beat).size : 0);
  const a = size();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  assert.strictEqual(size(), a, 'the leftover writer was stopped');
  fs.rmSync(tmp, { recursive: true, force: true });
});
