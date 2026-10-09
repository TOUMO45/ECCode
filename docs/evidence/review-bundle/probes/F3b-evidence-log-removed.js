'use strict';
const REPO = require('path').resolve(__dirname, '../../../..');
// Probe F3b: does command evidence stay citable after its log file
// (.eccode/evidence/<id>.log) is deleted or rewritten?
// Variants: A = log deleted, B = log overwritten with bytes claiming failure.
// Each variant is exercised through resolveRef, tasks.complete (implementer
// handoff) and gates.recordReview (reviewer phase approval).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const evidence = require(REPO + '/lib/evidence');
const gates = require(REPO + '/lib/gates');
const tasks = require(REPO + '/lib/tasks');
const { tmpProject, write, approveThroughPlan, approval, passCheck, handoffFor } = require(REPO + '/tests/helpers');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ALTERED = '$ node -e "process.exit(1)"\n# cwd: .\n# exit: 1\nFAIL: 3 tests failed\n';

function attempt(fn) {
  try {
    const value = fn();
    return { accepted: true, value };
  } catch (err) {
    return { accepted: false, code: err.code, message: err.message };
  }
}

function logState(dir, ev) {
  const abs = path.join(dir, ev.log);
  if (!fs.existsSync(abs)) return { exists: false };
  const bytes = fs.readFileSync(abs, 'utf8');
  return { exists: true, sha256OnDisk: sha(bytes), recordedLogSha256: ev.logSha256, firstLine: bytes.split('\n').slice(0, 3).join(' | ') };
}

const result = { probe: 'F3b-evidence-log-removed', variants: {} };
const ctx = tmpProject();
const { dir, store, config } = ctx;
try {
  approveThroughPlan(ctx);
  gates.startGate(store, config, 'phase:core', 'orchestrator');

  // ---- Variant A: implementer evidence, log DELETED ----
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server/a.js', '// api\n');
  const evA = passCheck(store, 'backend-engineer', 'api checks');
  const logA = path.join(dir, evA.log);
  const beforeA = fs.existsSync(logA);
  fs.rmSync(logA);
  const resolveA = evidence.resolveRef(store.state(), dir, `ev:${evA.id}`);
  const completeA = attempt(() => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [evA.id], ['src/server/a.js'])));
  result.variants.A_log_deleted_implementer = {
    evidenceId: evA.id, logExistedBeforeDelete: beforeA, logAfter: logState(dir, evA),
    resolveRef: resolveA.ok ? { ok: true, status: resolveA.evidence.status } : { ok: false, reason: resolveA.reason },
    taskComplete: completeA.accepted ? { accepted: true, taskStatus: store.state().tasks.api.status } : completeA,
  };

  // ---- Variant B: implementer evidence, log OVERWRITTEN with failure bytes ----
  tasks.claim(store, config, 'ui', 'frontend-engineer');
  write(dir, 'src/web/b.js', '// ui\n');
  const evB = passCheck(store, 'frontend-engineer', 'ui checks');
  fs.writeFileSync(path.join(dir, evB.log), ALTERED);
  const resolveB = evidence.resolveRef(store.state(), dir, `ev:${evB.id}`);
  const completeB = attempt(() => tasks.complete(store, config, 'ui', 'frontend-engineer', handoffFor('ui', 'frontend-engineer', [evB.id], ['src/web/b.js'])));
  result.variants.B_log_altered_implementer = {
    evidenceId: evB.id, logAfter: logState(dir, evB),
    hashMismatch: sha(ALTERED) !== evB.logSha256,
    resolveRef: resolveB.ok ? { ok: true, status: resolveB.evidence.status } : { ok: false, reason: resolveB.reason },
    taskComplete: completeB.accepted ? { accepted: true, taskStatus: store.state().tasks.ui.status } : completeB,
  };

  // Finish the remaining task so the phase can be submitted (clean evidence).
  tasks.claim(store, config, 'tests', 'test-engineer');
  write(dir, 'tests/c.test.js', '// tests\n');
  tasks.complete(store, config, 'tests', 'test-engineer', handoffFor('tests', 'test-engineer', [passCheck(store, 'test-engineer').id], ['tests/c.test.js']));
  const submitted = attempt(() => gates.submit(store, config, 'phase:core', 'delivery-lead'));
  result.phaseSubmitted = submitted.accepted ? true : submitted;

  // ---- Variant C: reviewer's own checks, one log DELETED and one ALTERED, both cited in the approval ----
  const evR1 = passCheck(store, 'technical-reviewer', 'reviewer reran tests');
  const evR2 = passCheck(store, 'technical-reviewer', 'reviewer reran lint');
  fs.rmSync(path.join(dir, evR1.log));
  fs.writeFileSync(path.join(dir, evR2.log), ALTERED);
  const resolveR1 = evidence.resolveRef(store.state(), dir, `ev:${evR1.id}`);
  const resolveR2 = evidence.resolveRef(store.state(), dir, `ev:${evR2.id}`);
  const review = attempt(() => gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${evR1.id}`], [`ev:${evR2.id}`, `ev:${evA.id}`, `ev:${evB.id}`]])));
  result.variants.C_reviewer_approval = {
    deletedLogEvidence: evR1.id, alteredLogEvidence: evR2.id,
    resolveRefDeleted: resolveR1.ok ? { ok: true } : { ok: false, reason: resolveR1.reason },
    resolveRefAltered: resolveR2.ok ? { ok: true } : { ok: false, reason: resolveR2.reason },
    recordReview: review.accepted ? { accepted: true, gateStatus: store.state().gates['phase:core'].status } : review,
  };

  const acceptedEverywhere =
    resolveA.ok && resolveB.ok && completeA.accepted && completeB.accepted && resolveR1.ok && resolveR2.ok && review.accepted;
  result.reproduces = acceptedEverywhere;
  result.decisionPoint = REPO + '/lib/evidence.js:125-137 resolveRef (ev: branch only re-hashes when ev.kind === "file"; command evidence returns ok once own(state.evidence, id) exists)';
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
