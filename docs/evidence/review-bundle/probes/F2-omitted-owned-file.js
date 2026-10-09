'use strict';
const REPO = require('path').resolve(__dirname, '../../../..');
// Probe F2-omitted-owned-file: a task owning src/** changes two files but the
// handoff declares only one. Older claim: the undeclared file inside ownership
// was exempt from the unaccounted-change check, never pinned by the phase
// submission, and so invisible to delivery.unreviewedChanges after approval.
//
// Step A: does completion with the omitted file succeed?
//   - refused  -> weakness closed; run a CONTROL path (declare both files) to
//                 show the omitted file is now pinned and a later edit blocks delivery.
//   - succeeds -> weakness open; continue: approve phase, edit omitted file,
//                 unreviewedChanges + deliver.

const fs = require('fs');
const path = require('path');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const delivery = require(REPO + '/lib/delivery');
const { tmpProject, write, approval, approveThroughPlan, task, passCheck, handoffFor } = require(REPO + '/tests/helpers');

const out = { probe: 'F2-omitted-owned-file', steps: [] };
const step = (name, data) => { out.steps.push({ step: name, ...data }); console.error(`[${name}]`, JSON.stringify(data)); };
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };

const plan = {
  phases: [{ id: 'core', name: 'Core', goal: 'Build the core service', acceptanceCriteria: ['server responds'] }],
  tasks: [task('impl', 'backend-engineer', ['src/**'])],
};

const ctx = tmpProject();
const { dir, store, config } = ctx;
try {
  approveThroughPlan(ctx, plan);
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'impl', 'backend-engineer');
  const claim = store.state().tasks.impl.claim;
  step('claim', { baseCommit: !!claim.baseCommit, dirtyAtClaim: claim.dirtyAtClaim });

  write(dir, 'src/listed.js', 'module.exports = "listed";\n');
  write(dir, 'src/omitted.js', 'module.exports = "omitted v1";\n');
  const ev = passCheck(store, 'backend-engineer');

  // ---- Step A: complete declaring only src/listed.js
  const a = attempt(() => tasks.complete(store, config, 'impl', 'backend-engineer', handoffFor('impl', 'backend-engineer', [ev.id], ['src/listed.js'])));
  step('A.complete-omitting-owned-file', a.ok ? { ok: true, filesChanged: store.state().tasks.impl.filesChanged } : { ok: false, code: a.code, message: a.message });

  const approvePhase = () => {
    gates.submit(store, config, 'phase:core', 'delivery-lead');
    const sub = store.state().gates['phase:core'].submissions.slice(-1)[0];
    const rev = passCheck(store, 'technical-reviewer', 'reviewer reran checks');
    gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${rev.id}`]]));
    return { pinned: sub.artifacts.map((x) => x.path).sort(), status: store.state().gates['phase:core'].status };
  };
  const verifyAndDeliver = () => {
    gates.startGate(store, config, 'verification', 'orchestrator');
    write(dir, '.eccode/artifacts/verification.md', '# Verification\nAll suites green.\n');
    gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/verification.md'] });
    const sev = passCheck(store, 'security-reviewer');
    gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${sev.id}`]]));
    return delivery.deliver(store, 'delivery-lead');
  };

  if (a.ok) {
    // ---- Weakness path: the omitted file was accepted silently.
    step('B.phase-approved', approvePhase());
    write(dir, 'src/omitted.js', 'module.exports = "omitted v2 (edited after approval)";\n');
    const unreviewed = delivery.unreviewedChanges(store.state(), dir);
    step('C.unreviewedChanges-after-editing-omitted', { entries: unreviewed });
    const d = attempt(verifyAndDeliver);
    step('D.deliver', d.ok ? { ok: true, report: d.value.report } : { ok: false, code: d.code, message: d.message });
    out.reproduces = !unreviewed.some((c) => c.path === 'src/omitted.js') && d.ok;
  } else {
    // ---- Control path: declare both files, then show the later edit is caught.
    const both = attempt(() => tasks.complete(store, config, 'impl', 'backend-engineer', handoffFor('impl', 'backend-engineer', [ev.id], ['src/listed.js', 'src/omitted.js'])));
    step('control.complete-declaring-both', both.ok ? { ok: true, filesChanged: store.state().tasks.impl.filesChanged } : { ok: false, code: both.code, message: both.message });
    step('control.phase-approved', approvePhase());
    write(dir, 'src/omitted.js', 'module.exports = "omitted v2 (edited after approval)";\n');
    const unreviewed = delivery.unreviewedChanges(store.state(), dir);
    step('control.unreviewedChanges-after-editing-omitted', { entries: unreviewed });
    const d = attempt(verifyAndDeliver);
    step('control.deliver', d.ok ? { ok: true, report: d.value.report } : { ok: false, code: d.code, message: d.message });
    out.reproduces = false;
    out.refusal = { code: a.code, message: a.message };
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
out.decisionPoint = 'lib/tasks.js:330-334 complete() — "files changed inside your ownership that the handoff does not declare"';
console.log(JSON.stringify(out));
