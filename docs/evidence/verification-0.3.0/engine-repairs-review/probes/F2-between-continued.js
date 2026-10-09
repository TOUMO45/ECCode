'use strict';
// Independent review of the engine repairs: the verifier's F2.between chain (REPORT.md NEW-3), re-run against
// the repaired engine. The original probe's verify() calls recordReview directly and crashes on the refusal;
// here the review is wrapped in attempt(), and the legitimate flow (the file listed in the verification
// submission) is driven through delivery.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO, attempt, report, git, commitAll, cleanup } = require('./_lib');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const delivery = require(REPO + '/lib/delivery');
const { tmpProject, write, coverage, approveThroughPlan, passCheck, handoffFor } = require(REPO + '/tests/helpers');

const BIN = path.join(REPO, 'bin/eccode.js');
const PHASE = [['api', 'backend-engineer', 'src/server/a.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']];
const DELIV = ['.eccode/artifacts/verification.md', 'src/server/a.js', 'src/web/b.js', 'tests/c.test.js'];

function completePhase(ctx) {
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  for (const [id, owner, file] of PHASE) {
    tasks.claim(ctx.store, ctx.config, id, owner);
    write(ctx.dir, file, `// ${id}\n`);
    tasks.complete(ctx.store, ctx.config, id, owner, handoffFor(id, owner, [passCheck(ctx.store, owner).id], [file]));
  }
  gates.submit(ctx.store, ctx.config, 'phase:core', 'delivery-lead');
  gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', coverage(ctx, 'phase:core', [`ev:${passCheck(ctx.store, 'technical-reviewer').id}`]));
}
const deliver = (ctx) => attempt(() => delivery.deliver(ctx.store, 'delivery-lead', { config: ctx.config }));

const { step, finish } = report('F2-between-continued (review of the repairs)');
const dirs = [];
try {
  const ctx = tmpProject();
  dirs.push(ctx.dir);
  commitAll(ctx.dir, 'base');
  approveThroughPlan(ctx);
  completePhase(ctx);
  commitAll(ctx.dir, 'phase work');
  write(ctx.dir, 'src/server/backdoor.js', 'module.exports = "never reviewed";\n');
  commitAll(ctx.dir, 'added between the phase approval and the verification submission');
  step('F2.between.beforeVerification', 'unreviewedChanges before the verification gate is approved', 'documented', { ok: true, value: delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config) });
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: DELIV }); // the three reviewed files only
  let sev = passCheck(ctx.store, 'security-reviewer');
  const r = attempt(() => gates.recordReview(ctx.store, ctx.config, 'verification', 'security-reviewer', coverage(ctx, 'verification', [`ev:${sev.id}`])));
  step('F2.between.verificationApproval', 'verification approval while src/server/backdoor.js is committed and listed by no gate', 'refused:REVIEW_REJECTED', r);
  step('F2.between.reasonNamesFile', 'the refusal names the file and the gate it postdates', 'documented', { ok: /src\/server\/backdoor\.js added after approval \(phase:core\)/.test(r.message || ''), value: (r.details || {}).reasons });
  step('F2.between.afterRefusal', 'unreviewedChanges after the refused approval (still reported)', 'documented', { ok: true, value: delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config) });
  step('F2.between.deliver', 'delivery with the file committed and reviewed by no gate', 'refused:DELIVERY_BLOCKED', deliver(ctx));
  const auditBlocked = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'audit'], { encoding: 'utf8' });
  step('F2.between.auditBlocked', 'eccode audit exit while the file is unreviewed (2 = unreviewed changes)', 'documented', { ok: auditBlocked.status !== 0, exit: auditBlocked.status, value: auditBlocked.stdout.trim().split('\n').slice(0, 3) });

  // The legitimate path: the delivery-lead lists the file; the approval pins it.
  step('F2.between.listSubmit', 'verification resubmitted WITH src/server/backdoor.js', 'ok', attempt(() => gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: [...DELIV, 'src/server/backdoor.js'] })));
  sev = passCheck(ctx.store, 'security-reviewer');
  step('F2.between.listApproval', 'verification approval once the file is listed (overblocking check)', 'ok', attempt(() => gates.recordReview(ctx.store, ctx.config, 'verification', 'security-reviewer', coverage(ctx, 'verification', [`ev:${sev.id}`]))));
  step('F2.between.afterApproval', 'unreviewedChanges after the approval', 'documented', { ok: true, value: delivery.unreviewedChanges(ctx.store.state(), ctx.dir, ctx.config) });
  const d = deliver(ctx);
  step('F2.between.deliverListed', 'delivery once the file was reviewed', 'ok', d);
  const audit = spawnSync(process.execPath, [BIN, '--root', ctx.dir, 'audit'], { encoding: 'utf8' });
  step('F2.between.audit', 'eccode audit after that delivery', 'ok', { ok: audit.status === 0, exit: audit.status, value: audit.stdout.trim().split('\n')[0] });
  const pinned = new Set(ctx.store.state().gateOrder.flatMap((g) => { const gate = ctx.store.state().gates[g]; const s = gate.submissions.find((x) => x.id === gate.approvedSubmission); return s ? s.artifacts.map((a) => a.path) : []; }));
  step('F2.between.pinned', 'is backdoor.js pinned by an approved submission now?', 'documented', { ok: pinned.has('src/server/backdoor.js'), value: { pinned: pinned.has('src/server/backdoor.js'), releaseCommit: ctx.store.state().delivery.commit, inTree: git(ctx.dir, 'ls-tree', '--name-only', 'HEAD', 'src/server/').split('\n') } });
} finally {
  cleanup(...dirs);
}
finish();
