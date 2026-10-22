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
