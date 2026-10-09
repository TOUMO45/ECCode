'use strict';
// Hotfix tasks: a scoped change to files an approved gate already covers,
// re-reviewed in its own phase gate before delivery (closes the gap that
// forced two TriageDesk fixes into later call sites: RISK-10, RISK-11).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { deliver, unreviewedChanges } = require('../lib/delivery');
const { nextAction } = require('../lib/status');
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor, approval, expectCode } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'eccode.js');

function completePhase(ctx, { started = false } = {}) {
  const { store, config, dir } = ctx;
  if (!started) gates.startGate(store, config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(store, config, id, owner);
    write(dir, file, `// ${id}\n`);
    const ev = passCheck(store, owner);
    tasks.complete(store, config, id, owner, handoffFor(id, owner, [ev.id], [file]));
  }
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  const ev = passCheck(store, 'technical-reviewer');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${ev.id}`]]));
}

function hotfixTask(overrides = {}) {
  return {
    id: 'hf-schema-400',
    title: 'Return 400 on unknown schema keyword',
    owner: 'backend-engineer',
    files: ['src/server/a.js'],
    acceptanceCriteria: ['unknown keyword answered with 400'],
    verification: { method: 'rerun server tests', command: 'true' },
    ...overrides,
  };
}

test('hotfix: approved-phase files can be changed under a new, independently reviewed phase gate; delivery re-pins the hashes', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  completePhase(ctx);
  const { store, config, dir } = ctx;

  // Editing an approved file without a hotfix blocks delivery and fails audit.
  fs.appendFileSync(path.join(dir, 'src/server/a.js'), '// fix\n');
  assert.strictEqual(unreviewedChanges(store.state(), dir)[0].problem, 'modified after approval');

  const { event } = tasks.addHotfix(store, config, 'orchestrator', { task: hotfixTask(), of: 'phase:core', reason: 'RISK-10: schema keyword rejected with 500 at the live API' });
  assert.strictEqual(event.data.gate, 'phase:hotfix-1');
  assert.strictEqual(event.data.after, 'phase:core');
  let st = store.state();
  assert.deepStrictEqual(st.gateOrder, ['architecture', 'design', 'plan', 'phase:core', 'phase:hotfix-1', 'verification']);
  assert.strictEqual(st.tasks['hf-schema-400'].status, 'pending');
  assert.deepStrictEqual(st.tasks['hf-schema-400'].hotfix, { of: 'phase:core', reason: 'RISK-10: schema keyword rejected with 500 at the live API' });
  assert.strictEqual(nextAction(st, config).gate, 'phase:hotfix-1');
  expectCode(() => gates.startGate(store, config, 'verification', 'orchestrator'), 'GATE_BLOCKED'); // hotfix precedes verification

  // The hotfix runs like any task: claim, change inside ownership, handoff, phase review by a non-author.
  gates.startGate(store, config, 'phase:hotfix-1', 'orchestrator');
  tasks.claim(store, config, 'hf-schema-400', 'backend-engineer');
  const ev = passCheck(store, 'backend-engineer');
  tasks.complete(store, config, 'hf-schema-400', 'backend-engineer', handoffFor('hf-schema-400', 'backend-engineer', [ev.id], ['src/server/a.js']));
  gates.submit(store, config, 'phase:hotfix-1', 'delivery-lead');
  st = store.state();
  assert.deepStrictEqual(st.gates['phase:hotfix-1'].submissions[0].artifacts.map((a) => a.path), ['src/server/a.js']);
  // The approved-at-core version is superseded by the version under review: a warning, not an unreviewed edit.
  const pending = unreviewedChanges(st, dir);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].pending, 'phase:hotfix-1');
  const own = passCheck(store, 'security-reviewer', 'reviewer reran the suite');
  gates.recordReview(store, config, 'phase:hotfix-1', 'security-reviewer', approval([[`ev:${own.id}`, 'artifact:src/server/a.js']]));
  assert.deepStrictEqual(unreviewedChanges(store.state(), dir), []);

  // Verification and delivery proceed; the report lists the hotfix.
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green after hotfix.\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'] });
  const full = passCheck(store, 'technical-reviewer', 'full suite rerun');
  gates.recordReview(store, config, 'verification', 'technical-reviewer', approval([[`ev:${full.id}`, 'artifact:.eccode/artifacts/verification.md']]));
  const res = deliver(store, 'delivery-lead');
  const report = fs.readFileSync(path.join(dir, res.report), 'utf8');
  assert.match(report, /## Hotfixes/);
  assert.match(report, /\| hf-schema-400 \| phase:core \| RISK-10: schema keyword .* \| phase:hotfix-1 \| security-reviewer \|/);
  assert.strictEqual(store.audit().ok, true);
});

test('hotfix: refused by the engine for wrong actors, unapproved targets, record paths, overlapping claims and after verification approval', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  const add = (actor, opts) => tasks.addHotfix(store, config, actor, { task: hotfixTask(), of: 'plan', reason: 'A reason long enough', ...opts });

  expectCode(() => add('backend-engineer'), 'ROLE_NOT_ALLOWED');
  expectCode(() => add('orchestrator', { reason: 'short' }), 'INVALID_INPUT');
  expectCode(() => add('orchestrator', { of: 'phase:core' }), 'INVALID_TRANSITION'); // core not approved: normal rework path
  expectCode(() => add('orchestrator', { of: 'nope' }), 'UNKNOWN_GATE');
  let err = expectCode(() => add('orchestrator', { task: hotfixTask({ owner: 'technical-reviewer' }) }), 'INVALID_INPUT');
  assert.match(err.message, /not a phase author/);
  err = expectCode(() => add('orchestrator', { task: hotfixTask({ files: ['.eccode/**'] }) }), 'INVALID_INPUT');
  assert.match(err.message, /would cover the ECCode record/);
  err = expectCode(() => add('orchestrator', { task: hotfixTask({ id: 'api' }) }), 'INVALID_INPUT');
  assert.match(err.message, /already exists/);
  err = expectCode(() => add('orchestrator', { task: hotfixTask({ verification: undefined }) }), 'INVALID_INPUT');
  assert.match(err.message, /task\.verification: is required/);

  // Overlap with an active claim is refused until that task finishes.
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  err = expectCode(() => add('orchestrator', { task: hotfixTask({ files: ['src/server/routes/**'] }) }), 'INVALID_INPUT');
  assert.match(err.message, /overlap with active task api/);
  tasks.fail(store, config, 'api', 'backend-engineer', 'abandon for the test');

  // Verification approved: the build is verified, so a hotfix is refused.
  completePhase(ctx, { started: true });
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/verification.md', '# Verification\nok\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md'] });
  const ev = passCheck(store, 'security-reviewer');
  gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${ev.id}`]]));
  err = expectCode(() => add('orchestrator', { of: 'phase:core' }), 'INVALID_TRANSITION');
  assert.match(err.message, /Verification is already approved/);
});

test('hotfix: several fixes can share an open hotfix phase, and the hotfix gate is inserted after the last approved gate', () => {
  const ctx = tmpProject();
  const plan = require('./helpers').samplePlan();
  plan.phases.push({ id: 'ui-phase', name: 'UI phase', goal: 'Second phase for ordering', acceptanceCriteria: ['ui ok'] });
  plan.tasks.push(require('./helpers').task('ui2', 'frontend-engineer', ['src/web2/**'], [], 'ui-phase'));
  approveThroughPlan(ctx, plan);
  completePhase(ctx);
  const { store, config } = ctx;
  gates.startGate(store, config, 'phase:ui-phase', 'orchestrator'); // second phase in progress, not approved
  tasks.addHotfix(store, config, 'delivery-lead', { task: hotfixTask(), of: 'phase:core', reason: 'finding PH1-3 from a later review' });
  tasks.addHotfix(store, config, 'delivery-lead', { task: hotfixTask({ id: 'hf-2', files: ['tests/c.test.js'] }), of: 'phase:core', reason: 'finding PH1-4 from a later review', phase: 'hotfix-1' });
  const st = store.state();
  assert.deepStrictEqual(st.gateOrder, ['architecture', 'design', 'plan', 'phase:core', 'phase:hotfix-1', 'phase:ui-phase', 'verification']);
  assert.strictEqual(st.tasks['hf-2'].phase, 'hotfix-1');
  assert.strictEqual(st.plan.phases.filter((p) => p.id.startsWith('hotfix-')).length, 1);
  expectCode(() => tasks.addHotfix(store, config, 'delivery-lead', { task: hotfixTask({ id: 'hf-3' }), of: 'phase:core', reason: 'another finding here', phase: 'hotfix-9' }), 'UNKNOWN_GATE');
  // Replay equals snapshot after the new event type.
  assert.strictEqual(store.audit().ok, true);
});

test('hotfix: CLI wiring (--file resolves against --root) and plan validation refuses record-covering ownership globs', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  completePhase(ctx);
  write(ctx.dir, '.eccode/drafts/hotfix.json', JSON.stringify(hotfixTask()));
  const res = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'task', 'hotfix', '--file', '.eccode/drafts/hotfix.json', '--for', 'phase:core', '--reason', 'RISK-11: exec in package.json', '--actor', 'orchestrator'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /Hotfix task hf-schema-400 added to phase:hotfix-1/);
  const missing = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'task', 'hotfix', '--file', 'nope.json', '--for', 'phase:core', '--reason', 'RISK-11: exec in package.json', '--actor', 'orchestrator'], { encoding: 'utf8' });
  assert.strictEqual(missing.status, 2);
  assert.match(missing.stderr, /\[NOT_FOUND\] File not found: nope.json/);

  const { loadConfig } = require('../lib/config');
  const plan = require('./helpers').samplePlan();
  plan.tasks[0].files = ['.eccode/**'];
  plan.tasks[1].files = ['.eccode/artifacts/verification/**']; // artifacts may be owned
  const errors = tasks.validatePlan(plan, loadConfig(ctx.dir));
  assert.strictEqual(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /task api: ownership glob \.eccode\/\*\* would cover the ECCode record/);
  assert.ok(tasks.touchesRecord('**'));
  assert.ok(tasks.touchesRecord('.eccode/evidence/*.log'));
  assert.ok(!tasks.touchesRecord('.eccode/drafts/**'));
  assert.ok(!tasks.touchesRecord('src/**'));
});
