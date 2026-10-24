'use strict';
// The one-step path: `eccode quick "<request>"` takes a repository to a quick
// work item whose single task is ready to claim, with the verification command
// and ownership read from the repository, and the rest of the path printed in
// order. `handoff draft` fills the handoff fields the record already knows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Store } = require('../lib/store');
const { write, expectCode } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');

function repo({ pkg = { name: 'shop', scripts: { test: 'node --test' } } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-quick-'));
  if (pkg) write(dir, 'package.json', JSON.stringify(pkg));
  write(dir, 'src/price.js', 'module.exports = { price: (n) => n * 10 };\n');
  write(dir, 'tests/price.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst { price } = require('../src/price');\ntest('price', () => assert.strictEqual(price(2), 20));\n");
  write(dir, 'README.md', '# shop\n');
  write(dir, '.github/workflows/ci.yml', 'on: push\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

const cli = (dir, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ROOT: dir, ECCODE_ACTOR: '' } });

test('quick on a repository with no record: one command to a claimable task, defaults read from the repository', () => {
  const dir = repo();
  const r = cli(dir, ['quick', 'Add a bulk discount to price', '--actor', 'orchestrator']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const st = new Store(dir).state();
  assert.strictEqual(st.work.track, 'quick');
  assert.strictEqual(st.work.title, 'Add a bulk discount to price');
  assert.deepStrictEqual(st.gateOrder, ['phase:change', 'verification']);
  assert.strictEqual(st.gates['phase:change'].status, 'in_progress', 'the phase gate is started, so the owner can claim at once');
  const t = st.tasks.change;
  assert.strictEqual(t.owner, 'backend-engineer');
  assert.strictEqual(t.verification.command, 'npm test', 'the project test script');
  assert.deepStrictEqual(t.files, ['src/**', 'tests/**', 'README.md', 'package.json'], 'tracked top-level directories and root files; dot directories excluded');
  for (const role of ['backend-engineer', 'delivery-lead', 'technical-reviewer']) assert.match(r.stdout, new RegExp(role));
  assert.match(r.stdout, /task claim change --actor backend-engineer/);
  assert.match(r.stdout, /deliver --actor delivery-lead/);
  const claim = cli(dir, ['task', 'claim', 'change', '--actor', 'backend-engineer']);
  assert.strictEqual(claim.status, 0, claim.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quick refuses while a work item is active, takes explicit options, and needs a command it cannot detect', () => {
  const dir = repo({ pkg: null });
  let r = cli(dir, ['quick', 'Fix the rounding', '--actor', 'orchestrator']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /--command/, 'no test command detected: say what to pass');
  assert.ok(!fs.existsSync(path.join(dir, '.eccode')), 'nothing is created when the command is refused');
  r = cli(dir, ['quick', 'Fix the rounding', '--actor', 'orchestrator', '--command', 'node --test', '--owner', 'test-engineer', '--files', 'src/**,tests/**']);
  assert.strictEqual(r.status, 0, r.stderr);
  const t = new Store(dir).state().tasks.change;
  assert.strictEqual(t.owner, 'test-engineer');
  assert.deepStrictEqual(t.files, ['src/**', 'tests/**']);
  r = cli(dir, ['quick', 'Another change now', '--actor', 'orchestrator', '--command', 'node --test']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /WORK_ACTIVE|still active/);
  expectCode(() => require('../lib/quick').start(dir, 'backend-engineer', { request: 'Fix it now', command: 'true' }), 'ROLE_NOT_ALLOWED');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('init --track quick without its task is refused (it used to create a record with no task to claim)', () => {
  const dir = repo();
  const r = cli(dir, ['init', '--name', 'shop', '--idea', 'small change', '--track', 'quick']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /eccode quick/);
  assert.ok(!fs.existsSync(path.join(dir, '.eccode', 'events.jsonl')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the printed path delivers: claim, change, evidence, drafted handoff, phase review, verification, delivery', () => {
  const dir = repo();
  const ok = (args) => {
    const r = cli(dir, args);
    assert.strictEqual(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  ok(['quick', 'Add a bulk discount to price', '--actor', 'orchestrator']);
  ok(['task', 'claim', 'change', '--actor', 'backend-engineer']);
  write(dir, 'src/price.js', 'module.exports = { price: (n) => (n >= 10 ? n * 9 : n * 10) };\n');
  write(dir, 'tests/price.test.js', fs.readFileSync(path.join(dir, 'tests/price.test.js'), 'utf8') + "test('bulk', () => assert.strictEqual(price(10), 90));\n");
  const own = JSON.parse(ok(['evidence', 'run', '--actor', 'backend-engineer', '--label', 'verify', '--task', 'change', '--json', '--', 'npm', 'test']));
  ok(['evidence', 'run', '--actor', 'test-engineer', '--label', 'someone else', '--json', '--', 'npm', 'test']); // later, but not the owner's
  let r = cli(dir, ['handoff', 'draft', '--task', 'change', '--actor', 'backend-engineer', '--out', 'src/handoff.json']);
  assert.notStrictEqual(r.status, 0, 'a draft goes to the shared draft area, never into owned code');
  assert.match(ok(['handoff', 'draft', '--task', 'change', '--actor', 'backend-engineer', '--out', '.eccode/drafts/handoff-change.json']), /fill in the TODO fields/);
  const draftFile = path.join(dir, '.eccode/drafts/handoff-change.json');
  const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  assert.deepStrictEqual(JSON.parse(ok(['handoff', 'draft', '--task', 'change', '--actor', 'backend-engineer'])), draft, 'stdout and --out carry the same draft');
  assert.deepStrictEqual(draft.filesChanged.sort(), ['src/price.js', 'tests/price.test.js']);
  assert.deepStrictEqual(draft.evidence, [`ev:${own.id}`], 'the owner\'s own passing run of the planned command, never another role\'s');
  assert.strictEqual(draft.task, 'change');
  assert.match(draft.completedWork, /^TODO:/);
  r = cli(dir, ['task', 'complete', 'change', '--actor', 'backend-engineer', '--handoff', '.eccode/drafts/handoff-change.json']);
  assert.notStrictEqual(r.status, 0, 'a draft with its TODO placeholders is not a handoff');
  assert.match(r.stderr, /fill in context, completedWork/);
  draft.completedWork = 'price() gives 10% off from 10 units; a test covers the boundary.';
  draft.context = 'Bulk discount requested; price is used by the cart and the invoice.';
  fs.writeFileSync(draftFile, JSON.stringify(draft));
  ok(['task', 'complete', 'change', '--actor', 'backend-engineer', '--handoff', '.eccode/drafts/handoff-change.json']);
  ok(['gate', 'submit', 'phase:change', '--actor', 'backend-engineer']);
  const ev = JSON.parse(ok(['evidence', 'run', '--actor', 'technical-reviewer', '--label', 'review', '--gate', 'phase:change', '--json', '--', 'npm', 'test']));
  const review = { decision: 'approve', summary: 'The discount and its boundary test pass under the reviewer run.', criteria: [{ id: 'C1', description: 'the change works and its verification command passes', met: true, evidence: [`ev:${ev.id}`] }], findings: [] };
  write(dir, '.eccode/reviews/drafts/old-round.json', '{}');
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(dir, '.eccode/reviews/drafts/old-round.json'), hourAgo, hourAgo); // written before this submission
  write(dir, '.eccode/reviews/drafts/phase-change.json', JSON.stringify(review));
  // A reviewer that wrote its review but never ran gate review: status names the draft and the command.
  assert.doesNotMatch(ok(['status', '--brief']), /old-round/, 'a draft from before the latest submission is not this round\'s');
  assert.match(ok(['status', '--brief']), /never recorded \(\.eccode\/reviews\/drafts\/phase-change\.json\): dispatch its reviewer again to run eccode gate review phase:change --actor <reviewer> --file \.eccode\/reviews\/drafts\/phase-change\.json/);
  ok(['gate', 'review', 'phase:change', '--actor', 'technical-reviewer', '--file', '.eccode/reviews/drafts/phase-change.json']);
  assert.doesNotMatch(ok(['status', '--brief']), /never recorded/);
  ok(['gate', 'start', 'verification', '--actor', 'orchestrator']);
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nnpm test passes with the discount.\n');
  ok(['gate', 'submit', 'verification', '--actor', 'delivery-lead', '--artifact', '.eccode/artifacts/verification.md']);
  const ev2 = JSON.parse(ok(['evidence', 'run', '--actor', 'security-reviewer', '--label', 'final', '--gate', 'verification', '--json', '--', 'npm', 'test']));
  write(dir, '.eccode/reviews/verify.json', JSON.stringify({ ...review, criteria: [{ ...review.criteria[0], evidence: [`ev:${ev2.id}`, 'artifact:.eccode/artifacts/verification.md'] }] }));
  ok(['gate', 'review', 'verification', '--actor', 'security-reviewer', '--file', '.eccode/reviews/verify.json']);
  ok(['deliver', '--actor', 'delivery-lead']);
  assert.strictEqual(new Store(dir).state().work.status, 'delivered');
  assert.strictEqual(new Store(dir).audit().ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a typo in --files is refused before it can strand the owner; a new directory is not a typo', () => {
  const dir = repo();
  let r = cli(dir, ['quick', 'Move pricing out of the cart', '--actor', 'orchestrator', '--files', 'src/**,test/**']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /test\/\*\*: there is no test\/ here; did you mean tests\/\?/);
  assert.ok(!fs.existsSync(path.join(dir, '.eccode', 'events.jsonl')), 'nothing is created');
  r = cli(dir, ['quick', 'Add a pricing module', '--actor', 'orchestrator', '--files', 'src/**,src/pricing/**,lib/**,tests/**']);
  assert.strictEqual(r.status, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ownership that missed a file is corrected: release the task, rescope it, claim again', () => {
  const dir = repo();
  const ok = (args) => {
    const r = cli(dir, args);
    assert.strictEqual(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  ok(['quick', 'Add a bulk discount to price', '--actor', 'orchestrator', '--files', 'src/**']);
  ok(['task', 'claim', 'change', '--actor', 'backend-engineer']);
  let r = cli(dir, ['task', 'rescope', 'change', '--files', 'src/**,tests/**', '--actor', 'orchestrator', '--reason', 'the test file is outside the ownership']);
  assert.notStrictEqual(r.status, 0, 'a claimed task is released first');
  assert.match(r.stderr, /release it first/);
  ok(['task', 'fail', 'change', '--actor', 'orchestrator', '--reason', 'ownership misses tests/']);
  r = cli(dir, ['task', 'rescope', 'change', '--files', 'src/**,tests/**', '--actor', 'backend-engineer', '--reason', 'the test file is outside the ownership']);
  assert.notStrictEqual(r.status, 0, 'the owner cannot widen its own ownership');
  r = cli(dir, ['task', 'rescope', 'change', '--files', 'src/**,tests/**', '--actor', 'orchestrator', '--reason', 'short']);
  assert.notStrictEqual(r.status, 0, 'a reason is required');
  ok(['task', 'rescope', 'change', '--files', 'src/**,tests/**', '--actor', 'orchestrator', '--reason', 'the test file is outside the ownership']);
  const t = new Store(dir).state().tasks.change;
  assert.deepStrictEqual(t.files, ['src/**', 'tests/**']);
  assert.deepStrictEqual(t.history.find((h) => h.event === 'rescoped').from, ['src/**']);
  ok(['task', 'claim', 'change', '--actor', 'backend-engineer']);
  assert.strictEqual(new Store(dir).audit().ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('on a reviewed plan only the user changes ownership', () => {
  const ctx = require('./helpers').tmpProject();
  require('./helpers').approveThroughPlan(ctx);
  expectCode(() => require('../lib/tasks').rescope(ctx.store, ctx.config, 'api', 'orchestrator', { files: 'src/**', reason: 'widen the api task please' }), 'ROLE_NOT_ALLOWED');
  require('../lib/tasks').rescope(ctx.store, ctx.config, 'api', 'user', { files: 'src/server/**,src/shared/**', reason: 'the api task needs the shared types' });
  assert.deepStrictEqual(ctx.store.state().tasks.api.files, ['src/server/**', 'src/shared/**']);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('a test run\'s caches are not changes: __pycache__, .pytest_cache, pickled grammar caches and node_modules never need review', () => {
  const dir = repo();
  const { gitChangedFiles } = require('../lib/project');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  write(dir, 'inventory/__pycache__/models.cpython-313.pyc', 'x');
  write(dir, '.pytest_cache/v/cache/lastfailed', '{}');
  write(dir, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
  write(dir, 'tools/gen.pyc', 'x');
  write(dir, 'blib2to3/Grammar3.8.20.final.0.pickle', 'x'); // black's grammar cache, written by its first test run
  write(dir, 'src/new.js', 'module.exports = 2;\n');
  assert.deepStrictEqual(gitChangedFiles(dir, base), ['src/new.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Pilot after-fix run of mealie-07-quick: with the frontend detected as a Node
// sub-project, a backend change was pinned to `cd frontend && pnpm test`.
test('the detected check is the one for the owned files: a sub-project only when every file is in it', () => {
  const { pickTestCheck } = require('../lib/quick');
  const checks = [
    { id: 'node-test', kind: 'test', available: true, dir: 'frontend', command: 'cd frontend && pnpm test' },
    { id: 'node-lint', kind: 'lint', available: true, dir: 'frontend', command: 'cd frontend && pnpm lint' },
    { id: 'pytest', kind: 'test', available: true, command: 'pytest -q' },
  ];
  assert.strictEqual(pickTestCheck(checks, ['mealie/schema/recipe/recipe_ingredient.py', 'tests/unit_tests/**']).command, 'pytest -q');
  assert.strictEqual(pickTestCheck(checks, ['frontend/components/**', 'frontend/lib/x.ts']).command, 'cd frontend && pnpm test');
  assert.strictEqual(pickTestCheck(checks, ['frontend/**', 'mealie/**']).command, 'pytest -q', 'a change across both: the root project');
  assert.strictEqual(pickTestCheck(checks, []).command, 'pytest -q', 'no files: the root project');
  assert.strictEqual(pickTestCheck([checks[0]], ['mealie/x.py']).command, 'cd frontend && pnpm test', 'the only test check is still offered');
  assert.strictEqual(pickTestCheck([{ ...checks[2], available: false }], ['x.py']), null);
});

// Pilot after-fix runs: the orchestrator ended its turn while a background
// engineer was still working; the headless session then stopped the engineer.
test('every orchestrating playbook says to wait for a dispatched agent before ending the turn', () => {
  for (const f of ['commands/quick.md', 'commands/debug.md', 'skills/orchestrate/SKILL.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(text, /never end your turn while a dispatched agent is still working/i, f);
    assert.match(text, /run_in_background: false/, `${f}: dispatch in the foreground (the Agent tool starts agents in the background by default in headless sessions)`);
  }
});

// Mealie pilot, b1 and b2 item 2: the plan pinned the code task to tests
// whose fixtures a later, dependent task updated, so neither could finish.
test('plans pin each task to a check that can pass once that task alone is done', () => {
  for (const f of ['agents/delivery-lead.md', 'agents/technical-reviewer.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(text, /can pass once that task alone is done/i, f);
  }
});

// Pilot after-fix checks of the MCP item: the whole Mealie suite, the only
// command MCP could pin, outran evidence_run's limit. MCP may narrow the
// detected check to named test paths, never to a free-form command.
test('the detected check narrows to named test paths only', () => {
  const { narrowCheck } = require('../lib/quick');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-narrow-'));
  write(dir, 'tests/unit/test_food.py', 'def test_x():\n    pass\n');
  write(dir, 'frontend/lib/a.test.ts', '');
  const py = { id: 'pytest', kind: 'test', available: true, command: 'pytest -q' };
  assert.strictEqual(narrowCheck(dir, py, ['tests/unit/test_food.py', 'tests/unit/test_food.py::test_x[a-1]']), 'pytest -q tests/unit/test_food.py tests/unit/test_food.py::test_x[a-1]');
  assert.strictEqual(narrowCheck(dir, py, ['tests/unit']), 'pytest -q tests/unit', 'a directory');
  const npm = { id: 'node-test', kind: 'test', available: true, command: 'npm test', script: 'node --test' };
  write(dir, 'tests/unit/a.test.js', '');
  assert.strictEqual(narrowCheck(dir, npm, ['tests/unit/a.test.js']), 'npm test -- tests/unit/a.test.js');
  // Pilot: `node --test <directory>` fails on Node 21 and later ("Cannot find
  // module"), so a check narrowed to a directory could never pass.
  expectCode(() => narrowCheck(dir, npm, ['tests/unit']), 'INVALID_INPUT', 'node --test takes files, not a directory');
  expectCode(() => narrowCheck(dir, { ...npm, command: 'node --test', script: undefined }, ['tests/unit']), 'INVALID_INPUT');
  const front = { id: 'node-test', kind: 'test', available: true, dir: 'frontend', command: 'cd frontend && pnpm test', script: 'vitest' };
  assert.strictEqual(narrowCheck(dir, front, ['frontend/lib/a.test.ts']), 'cd frontend && pnpm test lib/a.test.ts', 'paths relative to the sub-project');
  for (const bad of ['tests/unit; rm -rf /', '$(id)', 'tests/unit && x', '"tests/unit"', '../outside.py', '/etc/passwd', 'tests/missing.py', 'tests/unit|tee x']) {
    expectCode(() => narrowCheck(dir, py, [bad]), 'INVALID_INPUT');
  }
  expectCode(() => narrowCheck(dir, front, ['tests/unit']), 'INVALID_INPUT', 'outside the sub-project');
  expectCode(() => narrowCheck(dir, { ...npm, script: 'make check' }, ['tests/unit']), 'INVALID_INPUT', 'a script that may not take paths');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'commands', 'quick.md'), 'utf8'), /pass those test paths as `tests`/, 'the playbook says how to narrow over MCP');
  fs.rmSync(dir, { recursive: true, force: true });
});
