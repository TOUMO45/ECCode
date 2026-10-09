'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { loadConfig } = require('../lib/config');
const { initRepo, tmpProject, write, approveThroughPlan, samplePlan, task, passCheck, handoffFor, approval, expectCode } = require('./helpers');

test('plan validation catches cycles, unknown deps/owners and backwards phase deps', () => {
  const config = loadConfig(require('os').tmpdir());
  const plan = {
    phases: [
      { id: 'one', name: 'One', goal: 'first phase goal', acceptanceCriteria: ['phase ok'] },
      { id: 'two', name: 'Two', goal: 'second phase goal', acceptanceCriteria: ['phase ok'] },
    ],
    tasks: [
      task('a', 'backend-engineer', ['a/**'], ['b'], 'one'),
      task('b', 'backend-engineer', ['b/**'], ['a'], 'one'),
      task('c', 'wizard', ['c/**'], ['nope'], 'two'),
      task('d', 'backend-engineer', ['d/**'], ['e'], 'one'),
      task('e', 'backend-engineer', ['e/**'], [], 'two'),
    ],
  };
  const errors = tasks.validatePlan(plan, config).join('\n');
  assert.match(errors, /cycle/);
  assert.match(errors, /unknown dependency nope/);
  assert.match(errors, /owner wizard/);
  assert.match(errors, /depends on e from a later phase/);
  assert.deepStrictEqual(tasks.validatePlan(samplePlan(), config), []);
});

test('the plan gate refuses an invalid plan artifact', () => {
  const ctx = tmpProject();
  const bad = samplePlan();
  bad.tasks[0].dependencies = ['ghost'];
  assert.throws(() => approveThroughPlan(ctx, bad), (e) => e.code === 'INVALID_PLAN');
});

test('claims enforce ownership, dependencies, concurrency and file-overlap rules', () => {
  const ctx = tmpProject({ configOverrides: { limits: { maxConcurrency: 1 } } });
  const plan = samplePlan();
  plan.tasks.push(task('api2', 'backend-engineer', ['src/server/routes/**']));
  approveThroughPlan(ctx, plan);
  const { store, config } = ctx;
  expectCode(() => tasks.claim(store, config, 'api', 'backend-engineer'), 'GATE_BLOCKED'); // phase not started
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  expectCode(() => tasks.claim(store, config, 'api', 'frontend-engineer'), 'OWNERSHIP');
  expectCode(() => tasks.claim(store, config, 'tests', 'test-engineer'), 'DEPENDENCY_PENDING');
  tasks.claim(store, config, 'api', 'backend-engineer');
  expectCode(() => tasks.claim(store, config, 'ui', 'frontend-engineer'), 'CONCURRENCY_LIMIT');

  const ctx2 = tmpProject({ configOverrides: { limits: { maxConcurrency: 3 } } });
  approveThroughPlan(ctx2, plan);
  gates.startGate(ctx2.store, ctx2.config, 'phase:core', 'orchestrator');
  tasks.claim(ctx2.store, ctx2.config, 'api', 'backend-engineer');
  const err = expectCode(() => tasks.claim(ctx2.store, ctx2.config, 'api2', 'backend-engineer'), 'OWNERSHIP_CONFLICT');
  assert.match(err.message, /overlap with active task api/);
  tasks.claim(ctx2.store, ctx2.config, 'ui', 'frontend-engineer'); // disjoint files: parallel OK
  const ready = tasks.readyTasks(ctx2.store.state(), ctx2.config).map((t) => t.id);
  assert.ok(!ready.includes('api2'));
});

test('task completion requires a valid handoff, fresh passing evidence and in-scope files', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  const early = passCheck(store, 'backend-engineer', 'pre-claim check');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = 1;\n');
  write(dir, 'README.md', 'changed outside ownership\n');

  const failing = evidence.runCommand(store, 'backend-engineer', { label: 'failing', command: 'node -e "process.exit(3)"' });
  let err = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [early.id, failing.id], ['src/server/app.js'])), 'INVALID_HANDOFF');
  assert.match(err.message, /passing check/);

  const ok = passCheck(store, 'backend-engineer');
  err = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ok.id], ['src/server/app.js', 'README.md'])), 'INVALID_HANDOFF');
  assert.match(err.message, /outside task ownership/);

  err = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ok.id], ['src/server/ghost.js'])), 'INVALID_HANDOFF');
  assert.match(err.message, /unchanged since claim/);

  const incomplete = handoffFor('api', 'backend-engineer', [ok.id], ['src/server/app.js']);
  delete incomplete.nextAction;
  expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', incomplete), 'INVALID_HANDOFF');

  expectCode(() => tasks.complete(store, config, 'api', 'frontend-engineer', handoffFor('api', 'frontend-engineer', [ok.id], ['src/server/app.js'])), 'OWNERSHIP');
  // Leaving README.md out of the handoff does not hide it: git shows it changed during the claim.
  err = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ok.id], ['src/server/app.js'])), 'INVALID_HANDOFF');
  assert.match(err.message, /no task declares.*README\.md/);
  require('fs').rmSync(require('path').join(dir, 'README.md'));
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ok.id], ['src/server/app.js']));
  const t = store.state().tasks.api;
  assert.strictEqual(t.status, 'done');
  assert.deepStrictEqual(t.filesChanged, ['src/server/app.js']);
});

test('phase approval needs a check executed by the reviewer after submission; implementers cannot review', () => {
  const ctx = tmpProject({ configOverrides: { roles: { phase: { authors: ['delivery-lead', 'backend-engineer', 'frontend-engineer', 'test-engineer'], reviewers: ['technical-reviewer', 'backend-engineer'] } } } });
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    const ev = passCheck(store, owner);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [ev.id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const sub = store.state().gates['phase:core'].submissions[0];
  assert.deepStrictEqual(sub.artifacts.map((a) => a.path).sort(), ['src/server/a.js', 'src/web/b.js', 'tests/c.test.js']);

  // Implementer listed as reviewer in config is still refused (authored work in the phase).
  const selfCheck = passCheck(store, 'backend-engineer');
  let err = expectCode(() => gates.recordReview(store, config, 'phase:core', 'backend-engineer', approval([[`ev:${selfCheck.id}`]])), 'REVIEW_REJECTED');
  assert.match(err.message, /authored work/);

  // Reviewer citing only the implementer's evidence is refused.
  const implEv = Object.values(store.state().evidence).find((e) => e.recordedBy === 'test-engineer');
  err = expectCode(() => gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${implEv.id}`]])), 'REVIEW_REJECTED');
  assert.match(err.message, /executed by the reviewer/);

  const own = passCheck(store, 'technical-reviewer', 'reviewer reran tests');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${own.id}`, 'artifact:src/server/a.js']]));
  assert.strictEqual(store.state().gates['phase:core'].status, 'approved');
});

test('failed tasks are retried up to the limit, then escalate to the user', () => {
  const ctx = tmpProject({ configOverrides: { limits: { maxTaskRetries: 1 } } });
  approveThroughPlan(ctx);
  const { store, config } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  tasks.fail(store, config, 'api', 'backend-engineer', 'tests failing: port in use');
  assert.strictEqual(store.state().tasks.api.status, 'pending');
  tasks.claim(store, config, 'api', 'backend-engineer');
  tasks.fail(store, config, 'api', 'backend-engineer', 'tests still failing');
  const t = store.state().tasks.api;
  assert.strictEqual(t.status, 'escalated');
  assert.match(t.escalation.recovery, /Ask the user/);
  expectCode(() => tasks.claim(store, config, 'api', 'backend-engineer'), 'INVALID_TRANSITION');
  expectCode(() => tasks.reset(store, 'api', 'orchestrator', 'try again'), 'USER_AUTH_REQUIRED');
  tasks.reset(store, 'api', 'user', 'User re-scoped the task to drop the websocket requirement');
  assert.strictEqual(store.state().tasks.api.status, 'pending');
  tasks.claim(store, config, 'api', 'backend-engineer');
});

test('budget limits block new work', () => {
  const ctx = tmpProject({ configOverrides: { limits: { maxCostUsd: 1 } } });
  const runs = require('../lib/runs');
  const id = runs.startRun(ctx.store, ctx.config, 'product-architect', { gate: 'architecture' });
  runs.endRun(ctx.store, ctx.config, id, 'orchestrator', { costUsd: 1.5, tokens: 1000 });
  const err = expectCode(() => gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator'), 'BUDGET_EXCEEDED');
  assert.match(err.details.recovery, /user's explicit authorization/);
  expectCode(() => runs.startRun(ctx.store, ctx.config, 'product-architect'), 'BUDGET_EXCEEDED');
});

test('scope checks work when the project is a subdirectory of a larger git repo', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const { init } = require('../lib/project');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'));
  initRepo(repo);
  const dir = path.join(repo, 'examples', 'app');
  fs.mkdirSync(dir, { recursive: true });
  const store = init(dir, { name: 'Sub', idea: 'project nested in a monorepo' });
  const ctx = { dir, store, config: loadConfig(dir) };
  approveThroughPlan(ctx);
  write(dir, 'src/server/app.js', 'module.exports = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'baseline'], { cwd: repo });
  gates.startGate(store, ctx.config, 'phase:core', 'orchestrator');
  tasks.claim(store, ctx.config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = 2;\n'); // tracked file modified
  const ev = passCheck(store, 'backend-engineer');
  tasks.complete(store, ctx.config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/app.js']));
  assert.strictEqual(store.state().tasks.api.status, 'done');
});

test('tasks cannot modify records or approved artifacts under .eccode/ (only .eccode/drafts/)', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = 3;\n');
  write(dir, '.eccode/artifacts/spec.md', '# tampered approved spec\n');
  write(dir, '.eccode/drafts/handoff.json', '{}\n');
  const ev = passCheck(store, 'backend-engineer');
  const err = expectCode(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/app.js', '.eccode/artifacts/spec.md'])), 'INVALID_HANDOFF');
  assert.match(err.message, /outside task ownership.*\.eccode\/artifacts\/spec\.md/);
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [ev.id], ['src/server/app.js', '.eccode/drafts/handoff.json']));
});
