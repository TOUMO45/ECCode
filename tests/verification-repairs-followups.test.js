'use strict';
// Low findings of the independent review of the engine repairs
// (docs/evidence/verification-0.3.0/engine-repairs-review/REVIEW.md, L1 and L3).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { tmpProject, write, coverage, ARCH_MD, samplePlan } = require('./helpers');

test('L3: verification.cwd with surrounding blanks or backslashes is refused by plan validation, forward-slash forms pass', () => {
  const ctx = tmpProject();
  const planWith = (cwd) => {
    const plan = samplePlan();
    plan.tasks[0].verification = { ...(plan.tasks[0].verification || { method: 'tests', command: 'node -e "process.exit(0)"' }), cwd };
    return plan;
  };
  for (const [cwd, re] of [[' src/server ', /blanks/], ['src\\server', /forward slashes/], ['src\\..\\x', /forward slashes/], ['/abs', /absolute/], ['../x', /inside the project/]]) {
    const errors = tasks.validatePlan(planWith(cwd), ctx.config);
    assert.ok(errors.some((e) => re.test(e)), `${JSON.stringify(cwd)} should be refused, got ${JSON.stringify(errors)}`);
  }
  for (const cwd of ['src/server', './src/server/', 'src']) {
    const errors = tasks.validatePlan(planWith(cwd), ctx.config).filter((e) => /verification\.cwd/.test(e));
    assert.deepStrictEqual(errors, [], `${cwd} should be accepted`);
  }
});

test('L1: the changed-artifact refusal names the pinned digest and does not assume the file was committed', () => {
  const ctx = tmpProject();
  const { dir, store, config } = ctx;
  gates.startGate(store, config, 'architecture', 'orchestrator');
  const rel = write(dir, '.eccode/artifacts/architecture/brief.md', ARCH_MD);
  gates.submit(store, config, 'architecture', 'product-architect', { artifacts: [rel] });
  gates.recordReview(store, config, 'architecture', 'architecture-reviewer', coverage(ctx, 'architecture', [`artifact:${rel}#Acceptance Criteria`]));
  const pinned = store.state().gates.architecture.submissions[0].artifacts[0].sha256;
  fs.appendFileSync(path.join(dir, rel), '\n- AC2 something new\n');
  gates.startGate(store, config, 'design', 'orchestrator');
  assert.throws(() => gates.requiredCriteria(store.state(), config, dir, 'design'), (err) => {
    assert.strictEqual(err.code, 'APPROVED_ARTIFACT_CHANGED');
    assert.ok(err.message.includes(pinned), 'the full pinned sha256 is named');
    assert.match(err.message, /if the file was committed/, 'the git hint is conditional');
    assert.match(err.message, /otherwise from your own copy/);
    return true;
  });
});
