'use strict';
// Rebuilds the fixture projects behind live sessions 9-17 (docs/live/README.md).
// Each record is prepared up to the point where the session's agent takes over;
// the steps between sessions that no session's agent plays (reviewer roles)
// are the `approve-phase` command below.
//
//   node docs/live/fixtures/build.js all <out-dir>        all fixtures (JVM ones need javac; Kotlin needs $ECCODE_KOTLINC)
//   node docs/live/fixtures/build.js refactor-ok <out-dir> the accepted-refactor fixture (session 17)
//   node docs/live/fixtures/build.js approve-phase <fixture-dir> <evidence-id>
//   node docs/live/fixtures/build.js problem-solving <out-dir>  fixtures for sessions 19-21
//
// Fixtures install with `--profile guard`: these sessions test engine rules,
// so Bash stays available to the agent.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../../..');
const h = require(path.join(ROOT, 'tests/helpers'));
const gates = require(path.join(ROOT, 'lib/gates'));
const works = require(path.join(ROOT, 'lib/works'));
const evidence = require(path.join(ROOT, 'lib/evidence'));
const { init, openProject } = require(path.join(ROOT, 'lib/project'));
const { install } = require(path.join(ROOT, 'lib/install'));

const SHOP = {
  'package.json': JSON.stringify({ name: 'shop', version: '1.0.0', scripts: { test: 'node --test' } }),
  'src/util.js': 'function money(c) { return `$${(c / 100).toFixed(2)}`; }\nfunction clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }\nmodule.exports = { money, clamp };\n',
  'src/cart.js': "const { money, clamp } = require('./util');\nfunction lineTotal(i) { return money(clamp(i.qty, 1, 99) * i.cents); }\nmodule.exports = { lineTotal };\n",
  'tests/cart.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { lineTotal } = require('../src/cart');\ntest('line total', () => assert.strictEqual(lineTotal({ qty: 2, cents: 150 }), '$3.00'));\n",
};

// Each language fixture loads its target through a name built at runtime,
// which the static index cannot resolve.
const LANGS = {
  'lang-python': { 'jobs/task.py': 'VALUE = 7\n', 'jobs/loader.py': "import importlib\nmod = importlib.import_module('.'.join(['jobs', 'task']))\nassert mod.VALUE == 7\n", 'jobs/__init__.py': '' },
  'lang-ruby': { 'lib/plugin.rb': "module Plugin; NAME = 'plugin'; end\n", 'app/main.rb': "name = %w[plu gin].join\nrequire_relative \"../lib/#{name}\"\nabort 'bad' unless Plugin::NAME == 'plugin'\n" },
  'lang-php': { 'lib/Plugin.php': "<?php\nclass Plugin { public function name() { return 'plugin'; } }\n", 'app/main.php': "<?php\nspl_autoload_register(function ($c) { require __DIR__ . '/../lib/' . $c . '.php'; });\n$cls = 'Plu' . 'gin';\n$p = new $cls();\nif ($p->name() !== 'plugin') { exit(1); }\n" },
  'lang-java': { 'src/main/java/app/Plugin.java': 'package app;\npublic class Plugin { public String name() { return "plugin"; } }\n', 'src/main/java/app/Main.java': 'package app;\npublic class Main {\n  public static void main(String[] a) throws Exception {\n    Object p = Class.forName(String.join("", "app.Plu", "gin")).getDeclaredConstructor().newInstance();\n    if (!"plugin".equals(p.getClass().getMethod("name").invoke(p))) System.exit(1);\n  }\n}\n' },
  'lang-kotlin': { 'src/main/kotlin/app/Plugin.kt': 'package app\nclass Plugin { fun name() = "plugin" }\n', 'src/main/kotlin/app/Main.kt': 'package app\nfun main() {\n    val p = Class.forName(listOf("app.Plu", "gin").joinToString("")).getDeclaredConstructor().newInstance()\n    if (p.javaClass.getMethod("name").invoke(p) != "plugin") kotlin.system.exitProcess(1)\n}\n' },
};

function repo(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  const git = (...a) => execFileSync('git', a, { cwd: dir });
  git('init', '-q');
  install({ target: dir, scope: 'project', profile: 'guard' });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  init(dir, { name: path.basename(dir), idea: `live session fixture ${path.basename(dir)}` });
  return dir;
}

const PLAN = { phases: [{ id: 'core', name: 'Core', goal: 'Tidy helpers without changing behavior', acceptanceCriteria: ['npm test green'] }], tasks: [h.task('tidy', 'backend-engineer', ['src/**', 'tests/**'])] };

// A refactor work item (behavior check "npm test") with its plan approved and
// phase:core started. The planned verification command of task tidy is the
// helpers' default, node -e "process.exit(0)".
function refactorFixture(dir) {
  repo(dir, SHOP);
  works.abandonWork(openProject(dir).store, 'user', 'replaced by the refactor work item');
  const c0 = openProject(dir);
  works.startWork(c0.store, c0.config, 'orchestrator', { track: 'refactor', title: 'tidy pricing helpers', behavior: 'npm test' });
  const ctx = openProject(dir);
  gates.startGate(ctx.store, ctx.config, 'plan', 'orchestrator');
  h.write(dir, '.eccode/artifacts/plan.json', JSON.stringify(PLAN, null, 2));
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', h.approval([['artifact:.eccode/artifacts/plan.json']]));
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
}

// Between sessions: delivery-lead submits the phase, technical-reviewer runs
// the tests itself (a different command from the declared behavior check, so
// the refactor rule sees only the agents' runs) and approves; verification starts.
function approvePhase(dir, evId) {
  const ctx = openProject(dir);
  if (ctx.store.state().gates['phase:core'].status === 'in_progress') gates.submit(ctx.store, ctx.config, 'phase:core', 'delivery-lead', {});
  const rev = evidence.runCommand(ctx.store, 'technical-reviewer', { label: 'review-check', command: 'node --test', gate: 'phase:core' });
  gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', h.approval([[`ev:${evId}`, `ev:${rev.id}`, 'artifact:src/util.js']]));
  h.write(dir, '.eccode/artifacts/verify.md', '# Verification\n\nBehavior check `npm test` for the pricing-helper refactor.\n');
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
}

// Sessions 19-21 (bugs, mutate, fix verify): plain records, no plan, Bash available.
const SHOP_PKG = JSON.stringify({ name: 'shop', version: '1.0.0', scripts: { test: 'node --test' } });
const TEST_HEAD = "const test = require('node:test');\nconst assert = require('node:assert');\n";
function problemSolving(target) {
  // 19: a reported bug in the base commit (the loop skips the first item).
  repo(path.join(target, 'bugfix'), {
    'package.json': SHOP_PKG,
    'src/cart.js': 'function total(items) {\n  let sum = 0;\n  for (let i = 1; i < items.length; i++) sum += items[i];\n  return sum;\n}\nmodule.exports = { total };\n',
    'tests/cart.test.js': `${TEST_HEAD}const { total } = require('../src/cart');\ntest('empty cart', () => assert.strictEqual(total([]), 0));\n`,
    'BUG.md': '# Bug report\n\nCustomers report that the order total is too low: an order with items priced 1, 2 and 3 shows 5 instead of 6.\n',
  });
  // 20: new pricing code with a test that only covers typical values (uncommitted, as a change in progress).
  const m = repo(path.join(target, 'mutate'), { 'package.json': SHOP_PKG, 'src/price.js': 'module.exports = {};\n' });
  fs.writeFileSync(path.join(m, 'src/price.js'), 'function price(qty) {\n  if (qty > 10) return qty * 9;\n  return qty * 10;\n}\nfunction shipping(total, member) {\n  if (total >= 50 || member) return 0;\n  return 5;\n}\nmodule.exports = { price, shipping };\n');
  fs.mkdirSync(path.join(m, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(m, 'tests/price.test.js'), `${TEST_HEAD}const { price, shipping } = require('../src/price');\ntest('typical orders', () => {\n  assert.strictEqual(price(5), 50);\n  assert.strictEqual(price(20), 180);\n  assert.strictEqual(shipping(100, false), 0);\n  assert.strictEqual(shipping(10, false), 5);\n});\n`);
  // 21: a change with planted slips, for review (uncommitted).
  const b = repo(path.join(target, 'bugs-review'), { 'package.json': SHOP_PKG, 'src/report.js': 'module.exports = {};\n' });
  fs.writeFileSync(path.join(b, 'src/report.js'), "async function save(row) { return row; }\nfunction summarize(rows) {\n  const total = rows.reduce((a, r) => a + r.amount, 0) / rows.length;\n  if (total === NaN) return 0;\n  rows.forEach(async (r) => { await save(r); });\n  debugger;\n  return total;\n}\nfunction label(x) {\n  if (typeof x === 'strng') return x;\n  return String(x);\n}\nmodule.exports = { summarize, label };\n");
  fs.mkdirSync(path.join(b, 'app'), { recursive: true });
  fs.writeFileSync(path.join(b, 'app/tally.py'), 'def add(item, bucket=[]):\n    bucket.append(item)\n    return bucket\n\n\ndef is_single(count):\n    if count is 1:\n        return True\n    return False\n');
  fs.mkdirSync(path.join(b, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(b, 'tests/report.test.js'), `${TEST_HEAD}const { label } = require('../src/report');\ntest.only('label', () => assert.strictEqual(label(1), '1'));\n`);
}

const [cmd, target, arg] = process.argv.slice(2);
if (!target) throw new Error('usage: build.js all|refactor-ok <out-dir> | approve-phase <fixture-dir> <evidence-id>');
if (cmd === 'all') {
  for (const [name, files] of Object.entries(LANGS)) repo(path.join(target, name), files);
  const noTool = { ...process.env, JAVA_TOOL_OPTIONS: '' };
  execFileSync('javac', ['-d', 'build/classes', 'src/main/java/app/Main.java', 'src/main/java/app/Plugin.java'], { cwd: path.join(target, 'lang-java'), env: noTool });
  if (process.env.ECCODE_KOTLINC) execFileSync(process.env.ECCODE_KOTLINC, ['src/main/kotlin/app/Main.kt', 'src/main/kotlin/app/Plugin.kt', '-include-runtime', '-d', 'app.jar'], { cwd: path.join(target, 'lang-kotlin'), env: noTool, stdio: 'ignore' });
  // Migrations: an applied migration in the base commit; task db owns migrations/** and src/**.
  const mig = repo(path.join(target, 'migrations'), { ...SHOP, 'migrations/001_init.sql': 'CREATE TABLE carts (id INTEGER PRIMARY KEY, total INTEGER);\n' });
  const ctx = { dir: mig, ...openProject(mig) };
  const plan = { phases: [{ id: 'core', name: 'Core', goal: 'Schema work', acceptanceCriteria: ['schema migrates'] }], tasks: [h.task('db', 'backend-engineer', ['migrations/**', 'src/**'])] };
  h.approveThroughPlan(ctx, plan);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  refactorFixture(path.join(target, 'refactor'));
  repo(path.join(target, 'cbm'), SHOP);
} else if (cmd === 'refactor-ok') {
  refactorFixture(path.join(target, 'refactor-ok'));
} else if (cmd === 'problem-solving') {
  problemSolving(target);
} else if (cmd === 'approve-phase') {
  approvePhase(target, arg);
} else {
  throw new Error(`unknown command ${cmd}`);
}
