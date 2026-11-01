'use strict';
// Phase 3 gate-level narrowing (owner directive, 2026-11-01):
//   - Staged verification: a task iterates on impact-scoped checks, but the
//     claim of done must cite a passing run of the task's pinned FULL
//     verification command. A claim whose only cited passing run is scoped is
//     refused (lib/tasks.js complete()).
//   - Review discipline (code gates — phase and verification): a
//     changes_requested finding must cite an executed failing check or a
//     specific file:line; an uncited rejection is refused. On an impact-routed
//     low-risk task, after the configured bound the reviewer must approve or
//     escalate, not reject again (lib/gates.js checkReview()).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const evidence = require('../lib/evidence');
const { loadConfig } = require('../lib/config');
const { tmpProject, write, approveThroughPlan, passCheck, handoffFor, expectCode } = require('./helpers');

function runTask(ctx, id, owner, file, content = `// ${id}\n`) {
  tasks.claim(ctx.store, ctx.config, id, owner);
  write(ctx.dir, file, content);
  const ev = passCheck(ctx.store, owner);
  tasks.complete(ctx.store, ctx.config, id, owner, handoffFor(id, owner, [ev.id], [file]));
}

// ---------------------------------------------------------------------------
// Staged verification (lib/tasks.js complete)
// ---------------------------------------------------------------------------

test('staged verification: a claim citing only a scoped run is refused; the pinned full command completes it', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config, dir } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/app.js', 'module.exports = 1;\n');

  // NEGATIVE: a passing but scoped run (a different command from the pinned
  // one) does not satisfy the claim.
  const scoped = evidence.runCommand(store, 'backend-engineer', { label: 'scoped-subset', command: 'node -e "0"' });
  let err = expectCode(
    () => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [scoped.id], ['src/server/app.js'])),
    'INVALID_HANDOFF',
  );
  assert.match(err.message, /staged verification/);
  assert.match(err.message, /scoped/);

  // BYPASS: a trivially-passing command cannot stand in for the pinned run.
  const trivial = evidence.runCommand(store, 'backend-engineer', { label: 'trivial', command: 'true' });
  err = expectCode(
    () => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [scoped.id, trivial.id], ['src/server/app.js'])),
    'INVALID_HANDOFF',
  );
  assert.match(err.message, /staged verification/);

  // POSITIVE: the pinned full command passing (scoped runs may also be cited).
  const full = passCheck(store, 'backend-engineer'); // runs the task's pinned command
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [scoped.id, full.id], ['src/server/app.js']));
  assert.strictEqual(store.state().tasks.api.status, 'done');
});

// ---------------------------------------------------------------------------
// Review discipline — uncited rejection (lib/gates.js checkReview)
// ---------------------------------------------------------------------------

function changesRequested(id, detail, evidenceRefs) {
  return {
    decision: 'changes_requested',
    summary: 'A problem was found in the submitted code during review.',
    criteria: [{ id: 'C1', description: 'the code is correct', met: false, evidence: [] }],
    findings: [{ id, severity: 'blocking', title: 'Defect in the change', detail, recommendation: 'Fix it.', ...(evidenceRefs ? { evidence: evidenceRefs } : {}) }],
  };
}

test('review discipline: a code gate refuses an uncited rejection, accepts a file:line or a failed check', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  runTask(ctx, 'api', 'backend-engineer', 'src/server/a.js');
  runTask(ctx, 'ui', 'frontend-engineer', 'src/web/b.js');
  runTask(ctx, 'tests', 'test-engineer', 'tests/c.test.js');
  gates.submit(store, config, 'phase:core', 'delivery-lead');

  // NEGATIVE: a blocking finding that cites neither a file:line nor a failed check.
  const uncited = changesRequested('F1', 'The change looks wrong and probably breaks something.');
  const err = expectCode(() => gates.recordReview(store, config, 'phase:core', 'technical-reviewer', uncited), 'REVIEW_REJECTED');
  assert.match(err.message, /uncited rejection/);
  assert.strictEqual(store.state().gates['phase:core'].status, 'submitted', 'a refused review does not apply the decision');

  // POSITIVE (file:line): the same finding located in the code is accepted.
  const located = changesRequested('F1', 'The handler forgets to await the write (src/server/a.js:1).');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', located);
  assert.strictEqual(store.state().gates['phase:core'].status, 'changes_requested');
});

test('review discipline: a failed check cited as evidence is a valid rejection on a code gate', () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  const { store, config } = ctx;
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  runTask(ctx, 'api', 'backend-engineer', 'src/server/a.js');
  runTask(ctx, 'ui', 'frontend-engineer', 'src/web/b.js');
  runTask(ctx, 'tests', 'test-engineer', 'tests/c.test.js');
  gates.submit(store, config, 'phase:core', 'delivery-lead');

  // POSITIVE (failed check): a finding that cites an executed failing command.
  const failed = evidence.runCommand(store, 'technical-reviewer', { label: 'repro', command: 'node -e "process.exit(1)"' });
  const cited = changesRequested('F1', 'The acceptance check does not pass.', [`ev:${failed.id}`]);
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', cited);
  assert.strictEqual(store.state().gates['phase:core'].status, 'changes_requested');
});

// ---------------------------------------------------------------------------
// Review discipline — bounded rounds on a low-risk task (quick track → required=[])
// ---------------------------------------------------------------------------

function quickLowRiskSubmittedPhase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-rd-quick-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  write(dir, 'src/x.js', 'module.exports = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
  require('../lib/quick').start(dir, 'orchestrator', {
    request: 'Tweak the exported number in x',
    command: 'node -e "process.exit(0)"',
    owner: 'backend-engineer',
    files: 'src/**',
  });
  // Lean checks are off for this fixture: it changes code without a test on
  // purpose (tests/lean.test.js covers lean). Keep maxRejectionsBeforeDecision
  // at its default of 1.
  const cfgFile = path.join(dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.lean = { ...cfg.lean, level: 'off' };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const store = new (require('../lib/store').Store)(dir);
  const config = loadConfig(dir);
  const ctx = { dir, store, config };
  // Record the guard routing: the quick track skips every guard, so required=[]
  // — this is the low-risk signal the bounded-rounds rule keys on.
  require('../lib/guards').route(store, config, 'orchestrator');
  assert.deepStrictEqual(store.state().guards.routing.required, [], 'quick track routes to no guards (low-risk)');
  tasks.claim(store, config, 'change', 'backend-engineer');
  write(dir, 'src/x.js', 'module.exports = 2;\n');
  const ev = passCheck(store, 'backend-engineer');
  tasks.complete(store, config, 'change', 'backend-engineer', handoffFor('change', 'backend-engineer', [ev.id], ['src/x.js']));
  gates.submit(store, config, 'phase:change', 'delivery-lead');
  return ctx;
}

test('review discipline: a low-risk code task cannot be rejected past the bound — approve or escalate', () => {
  const ctx = quickLowRiskSubmittedPhase();
  const { store, config, dir } = ctx;
  assert.strictEqual(config.review.maxRejectionsBeforeDecision, 1);

  const located = (id) => changesRequested(id, 'Off-by-one in the exported value (src/x.js:1).');
  // First rejection: well-cited, allowed.
  gates.recordReview(store, config, 'phase:change', 'technical-reviewer', located('F1'));
  assert.strictEqual(store.state().gates['phase:change'].iterations, 1);

  // Resubmit so the gate can be reviewed again.
  const g = store.state().gates['phase:change'];
  gates.submit(store, config, 'phase:change', 'delivery-lead', { respondsTo: g.reviews[g.reviews.length - 1] });

  // Second rejection on the low-risk task after the bound: refused.
  const err = expectCode(() => gates.recordReview(store, config, 'phase:change', 'technical-reviewer', located('F2')), 'REVIEW_REJECTED');
  assert.match(err.message, /approve or escalate/);

  fs.rmSync(dir, { recursive: true, force: true });
});
