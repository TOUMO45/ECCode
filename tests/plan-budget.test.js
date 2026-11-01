'use strict';
// Large-change planning (Phase 3, Part D): a task over the file or line budget
// is refused until split or waived; an integration checkpoint is due after
// every N completed tasks; a rescope cites the contract it changes, and a
// contract changed twice opens a blocking ambiguity. Bypass tests forge the
// raw events.
const test = require('node:test');
const assert = require('node:assert');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const pb = require('../lib/plan-budget');
const design = require('../lib/design');
const { tmpProject, write, approval, task, passCheck, handoffFor, expectCode, approveThroughPlan, releasePlan } = require('./helpers');

function fullPlan() {
  return { phases: [{ id: 'core', name: 'Core', goal: 'build the core service', acceptanceCriteria: ['the server responds'] }],
    tasks: [task('big', 'backend-engineer', ['src/**']), task('small', 'backend-engineer', ['docs/**'], ['big'])] };
}

test('a task over the file budget is refused at completion, and the orchestrator may waive it with a reason', () => {
  const ctx = tmpProject({ configOverrides: { plan: { maxFilesPerTask: 2, maxLinesPerTask: 150, checkpointEvery: 3 } }, beforeInit: (d) => {} });
  const { dir, store, config } = ctx;
  approveThroughPlan(ctx, fullPlan());
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'big', 'backend-engineer');
  for (const f of ['src/a.js', 'src/b.js', 'src/c.js']) write(dir, f, `// ${f}\n`);
  const handoff = handoffFor('big', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/a.js', 'src/b.js', 'src/c.js']);
  const err = expectCode(() => tasks.complete(store, config, 'big', 'backend-engineer', handoff), 'INVALID_HANDOFF');
  assert.match(err.message, /task big changes 3 files, over the budget of 2/);
  expectCode(() => pb.waiveBudget(store, 'backend-engineer', 'too short', { task: 'big', reason: 'x' }), 'ROLE_NOT_ALLOWED');
  expectCode(() => pb.waiveBudget(store, config, 'orchestrator', { task: 'big', reason: 'short' }), 'INVALID_INPUT');
  pb.waiveBudget(store, config, 'orchestrator', { task: 'big', reason: 'the three files are one atomic schema-and-route change' });
  tasks.complete(store, config, 'big', 'backend-engineer', handoff);
  assert.strictEqual(store.state().tasks.big.status, 'done');
  assert.ok(store.audit().ok);
});

test('an integration checkpoint is due after every N completed tasks before the next claim', () => {
  const ctx = tmpProject({ configOverrides: { plan: { maxFilesPerTask: 3, maxLinesPerTask: 150, checkpointEvery: 2 } } });
  const { dir, store, config } = ctx;
  const plan = { phases: [{ id: 'core', name: 'Core', goal: 'build the core service', acceptanceCriteria: ['the server responds'] }],
    tasks: ['t1', 't2', 't3', 't4'].map((id, i) => task(id, 'backend-engineer', [`src/${id}/**`], i ? [`t${i}`] : [])) };
  approveThroughPlan(ctx, plan);
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  const run = (id) => { tasks.claim(store, config, id, 'backend-engineer'); write(dir, `src/${id}/f.js`, '// x\n'); tasks.complete(store, config, id, 'backend-engineer', handoffFor(id, 'backend-engineer', [passCheck(store, 'backend-engineer').id], [`src/${id}/f.js`])); };
  run('t1');
  run('t2');
  // Two done, checkpointEvery 2: the next claim is refused until a checkpoint passes.
  assert.match(expectCode(() => tasks.claim(store, config, 't3', 'backend-engineer'), 'CHECKPOINT_DUE').message, /integration checkpoint is due/);
  // A checkpoint citing a non-passing check is refused.
  expectCode(() => pb.checkpoint(store, config, 'orchestrator', { evidence: ['ev:nope'] }), 'EVIDENCE_REQUIRED');
  const ev = passCheck(store, 'backend-engineer').id;
  const cp = pb.checkpoint(store, config, 'orchestrator', { evidence: [`ev:${ev}`] });
  assert.strictEqual(cp.afterTasks, 2);
  run('t3');
  assert.strictEqual(store.state().tasks.t3.status, 'done');
});

test('plan contracts: declared before implementation; a rescope cites the contract it changes; a contract changed twice opens a blocking ambiguity', () => {
  const ctx = tmpProject({ beforeInit: (d) => {} });
  const { dir, store, config } = ctx;
  // Contracts are declared before any claim.
  expectCode(() => pb.contracts(store, config, 'backend-engineer', [{ id: 'items-api', kind: 'api', text: 'GET /items returns a paged list' }]), 'ROLE_NOT_ALLOWED');
  pb.contracts(store, config, 'technical-designer', [{ id: 'items-api', kind: 'api', text: 'GET /items returns a paged list of items' }, { id: 'store-schema', kind: 'schema', text: 'items table has id, name, price' }]);
  approveThroughPlan(ctx, fullPlan());
  // A contract after work started is refused.
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'big', 'backend-engineer');
  assert.match(expectCode(() => pb.contracts(store, config, 'technical-designer', [{ id: 'x', kind: 'api', text: 'another contract entirely' }]), 'CONTRACT_AFTER_WORK').message, /Implementation has started/);
  tasks.fail(store, config, 'big', 'backend-engineer', 'releasing to rescope');
  // A rescope must cite a contract (the plan declared some); an unknown one is refused.
  assert.match(expectCode(() => tasks.rescope(store, config, 'big', 'user', { files: 'src/items/**', reason: 'narrow the ownership to items' }), 'CONTRACT_CITE_REQUIRED').message, /cites the one it changes/);
  expectCode(() => tasks.rescope(store, config, 'big', 'user', { files: 'src/items/**', reason: 'narrow the ownership', contract: 'no-such' }), 'CONTRACT_CITE_REQUIRED');
  tasks.rescope(store, config, 'big', 'user', { files: 'src/items/**', reason: 'the items API shape moved', contract: 'items-api' });
  assert.strictEqual(store.state().design.ambiguities.length, 0, 'one change does not open an ambiguity');
  // The second change of the same contract opens a blocking ambiguity (the task is still pending after a rescope).
  tasks.rescope(store, config, 'big', 'user', { files: 'src/items2/**', reason: 'the items API shape moved again', contract: 'items-api' });
  const q = store.state().design.ambiguities.flatMap((a) => a.questions).find((x) => x.id === 'contract-items-api');
  assert.ok(q && q.blocking, 'a blocking ambiguity is open for the twice-changed contract');
  // "none" is accepted when a rescope changes no contract.
  tasks.rescope(store, config, 'small', 'user', { files: 'docs/items/**', reason: 'a documentation-only move', contract: 'none' });
});

test('the budget and checkpoint rules do not apply to the quick track', () => {
  const { loadConfig } = require('../lib/config');
  const ctx = tmpProject();
  const config = loadConfig(ctx.dir);
  const quickState = { work: { track: 'quick', status: 'active' }, tasks: {}, planning: { contracts: [], checkpoints: [], budgetWaivers: [] } };
  assert.strictEqual(pb.budgetProblem(quickState, config, { id: 'x', lean: { linesAdded: 999, linesRemoved: 0 } }, { filesChanged: ['a', 'b', 'c', 'd', 'e'] }, []), null);
  assert.strictEqual(pb.checkpointProblem(quickState, config), null);
  // On a feature track the same oversized change is refused.
  const featState = { ...quickState, work: { track: 'feature', status: 'active' } };
  assert.match(pb.budgetProblem(featState, config, { id: 'x', lean: { linesAdded: 999, linesRemoved: 0 } }, { filesChanged: ['a', 'b', 'c', 'd', 'e'] }, []), /over the budget/);
});

test('the CLI and MCP expose plan contracts, checkpoint and task waive-budget', () => {
  const tools = require('../lib/mcp').tools().map((t) => t.name);
  for (const n of ['plan_contracts', 'plan_checkpoint', 'task_waive_budget', 'plan_show']) assert.ok(tools.includes(n), n);
});
