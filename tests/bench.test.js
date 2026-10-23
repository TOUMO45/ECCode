'use strict';
// Benchmark harness: scripted agents stand in for a model, so the tests prove
// the measurements (hidden checks, lines, dependencies, tests) discriminate
// between a lean solution and a bloated or symptom-patched one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
  assert.strictEqual(bloat.hiddenPassed, 1, 'functional check passes, no-new-deps check fails');
  assert.deepStrictEqual(bloat.newDeps, ['humanize-duration']);
  assert.strictEqual(bloat.testFilesChanged, 0);
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
  assert.deepStrictEqual(t.total, { files: 2, runs: 3, hiddenPassed: 5, hiddenTotal: 6, depRuns: 1, agentFailures: 1, pairedSmaller: 2, pairedLarger: 0, pairedEqual: 0 });
  assert.strictEqual(t.perFile.length, 2);
  assert.deepStrictEqual(t.perFile[0], { file: 'a.md', runs: 2, hiddenPassed: 3, hiddenTotal: 4, depRuns: 1, agentFailures: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the report header grades its own sample size', () => {
  const rec = (task, variant, lines) => ({ task, variant, hiddenPassed: 2, hiddenTotal: 2, linesAdded: lines, linesRemoved: 0, newDeps: [], testFilesChanged: 1, durationMs: 1000, agentExit: 0, filesChanged: 1, checks: [] });
  const small = bench.report([rec('t', 'without', 10), rec('t', 'with', 8)], { agentCmd: 'x' });
  assert.match(small, /demonstration, not a statistic/);
  const many = [];
  for (let i = 0; i < 10; i++) { many.push(rec('t', 'without', 10 + i)); many.push(rec('t', 'with', 8 + i)); }
  const big = bench.report(many, { agentCmd: 'x' });
  assert.match(big, /n >= 10 times per task; the exact permutation test enumerates every split/);
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
