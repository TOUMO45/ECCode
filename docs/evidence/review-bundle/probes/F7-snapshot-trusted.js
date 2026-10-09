'use strict';
const REPO = require('path').resolve(__dirname, '../../../..');
// Probe F7-snapshot-trusted: does Store.state() trust a content-forged snapshot
// whose seq/lastHash still match the log's last event, and does that forged
// state let the next gate start (and be committed on top of the forgery)?
//
// Steps:
//   1. tmpProject() -> fresh project, architecture gate is 'pending'.
//   2. Edit .eccode/state.json: gates.architecture.status = 'approved' (seq/lastHash untouched).
//   3. Compare store.state() vs store.rebuild() for the architecture gate.
//   4. gates.startGate(store, config, 'design', 'orchestrator')  (needs architecture approved).
//   5. If accepted, keep going: submit + approve the design gate on the forged base.
//   6. store.audit() after the fact; state() vs rebuild() again; what rebuildSnapshot() leaves behind.

const fs = require('fs');
const path = require('path');

const gates = require(REPO + '/lib/gates');
const { Store } = require(REPO + '/lib/store');
const { tmpProject, write, approval, DESIGN_MD } = require(REPO + '/tests/helpers');

const out = { probe: 'F7-snapshot-trusted', steps: [] };
function step(name, data) {
  out.steps.push({ step: name, ...data });
}
function attempt(fn) {
  try {
    const r = fn();
    return { ok: true, result: r };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

const ctx = tmpProject();
const { dir, store, config } = ctx;
const stateFile = path.join(dir, '.eccode', 'state.json');

try {
  // --- baseline ---------------------------------------------------------
  const before = store.state();
  step('baseline', {
    seq: before.seq,
    archStatus: before.gates.architecture.status,
    designStatus: before.gates.design.status,
    auditOk: store.audit().ok,
  });

  // --- forge the snapshot content only ----------------------------------
  const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const forgedSeq = snap.seq;
  const forgedHash = snap.lastHash;
  snap.gates.architecture.status = 'approved';
  fs.writeFileSync(stateFile, JSON.stringify(snap, null, 2) + '\n');

  const afterForgeState = store.state();
  const afterForgeRebuild = store.rebuild();
  const auditAfterForge = store.audit();
  step('after_forge', {
    snapshotSeqKept: afterForgeState.seq === forgedSeq && afterForgeState.lastHash === forgedHash,
    'state().gates.architecture.status': afterForgeState.gates.architecture.status,
    'rebuild().gates.architecture.status': afterForgeRebuild.gates.architecture.status,
    stateTrustsForgedSnapshot: afterForgeState.gates.architecture.status === 'approved',
    auditOk: auditAfterForge.ok,
    auditErrors: auditAfterForge.errors,
  });

  // --- the transition that needs architecture approved ------------------
  const startDesign = attempt(() => gates.startGate(store, config, 'design', 'orchestrator'));
  step('startGate_design', {
    accepted: startDesign.ok,
    code: startDesign.code,
    message: startDesign.message,
    committedEvent: startDesign.ok ? { seq: startDesign.result.event.seq, type: startDesign.result.event.type, data: startDesign.result.event.data } : null,
  });

  let designSubmit = null;
  let designReview = null;
  if (startDesign.ok) {
    // Keep driving the design gate on the forged base to show how far it goes.
    write(dir, '.eccode/artifacts/spec.md', DESIGN_MD);
    designSubmit = attempt(() => gates.submit(store, config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] }));
    step('submit_design', { accepted: designSubmit.ok, code: designSubmit.code, message: designSubmit.message });
    if (designSubmit.ok) {
      designReview = attempt(() => gates.recordReview(store, config, 'design', 'technical-reviewer', approval([['artifact:.eccode/artifacts/spec.md']])));
      step('approve_design', { accepted: designReview.ok, code: designReview.code, message: designReview.message });
    }
  }

  // --- what the record says now -----------------------------------------
  const stNow = store.state();
  const rbNow = store.rebuild();
  const auditNow = store.audit();
  const events = store.readEvents();
  step('after_mutations', {
    logEventTypes: events.map((e) => `${e.seq}:${e.type}${e.data && e.data.gate ? '(' + e.data.gate + ')' : ''}`),
    'state().gates.architecture.status': stNow.gates.architecture.status,
    'rebuild().gates.architecture.status': rbNow.gates.architecture.status,
    'state().gates.design.status': stNow.gates.design.status,
    'rebuild().gates.design.status': rbNow.gates.design.status,
    snapshotMatchesLogHead: stNow.seq === events[events.length - 1].seq && stNow.lastHash === events[events.length - 1].hash,
    auditOk: auditNow.ok,
    auditErrors: auditNow.errors,
    hashChainErrors: auditNow.errors.filter((e) => !/diverges from a replay/.test(e)),
  });

  // --- what rebuild leaves behind: is the forged transition laundered? ----
  let rebuilt = attempt(() => store.rebuildSnapshot());
  const auditAfterRebuild = store.audit();
  const stAfterRebuild = new Store(dir).state();
  step('after_rebuildSnapshot', {
    rebuildOk: rebuilt.ok,
    code: rebuilt.code,
    auditOk: auditAfterRebuild.ok,
    auditErrors: auditAfterRebuild.errors,
    'state().gates.architecture.status': stAfterRebuild.gates.architecture.status,
    'state().gates.design.status': stAfterRebuild.gates.design.status,
    designApprovedWhileArchitecturePending:
      stAfterRebuild.gates.architecture.status !== 'approved' && stAfterRebuild.gates.design.status === 'approved',
  });

  const forgedAccepted = startDesign.ok;
  out.reproduces = Boolean(afterForgeState.gates.architecture.status === 'approved' && forgedAccepted);
  out.decisionPoint = REPO + '/lib/store.js:110 Store.state() -- `if (snap && last && snap.seq === last.seq && snap.lastHash === last.hash) return snap;` returns the snapshot without comparing it to a replay; commit() at store.js:146 feeds that snapshot to the gate check (gates.js:51 startGate predecessor check)';
  out.summary = forgedAccepted
    ? 'Forged snapshot (architecture.status=approved, seq/lastHash intact) is returned by state(); startGate(design) passed the predecessor check and was committed on top of it; audit only reports snapshot/replay divergence afterwards.'
    : `Engine refused the design gate: ${startDesign.code} ${startDesign.message}`;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  reproduces: out.reproduces,
  probe: out.probe,
  decisionPoint: out.decisionPoint,
  startGateDesign: out.steps.find((s) => s.step === 'startGate_design'),
  afterForge: out.steps.find((s) => s.step === 'after_forge'),
  afterMutations: out.steps.find((s) => s.step === 'after_mutations'),
  afterRebuild: out.steps.find((s) => s.step === 'after_rebuildSnapshot'),
}));
