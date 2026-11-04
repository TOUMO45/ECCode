'use strict';
// The wrapped operations: the same arguments and results as the frozen gate and task functions, with the
// Greenfield-Senior rules run first. On a record without gf.project.initialized every function is a straight
// call to the frozen one. The frozen module is called through its exports object (gates.submit, not a
// destructured copy), so a test can interpose on it.
//
// What this gives: prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all
// profiles (audit.js). The plain `eccode` CLI is outside it (L-GF-1).
const fs = require('fs');
const path = require('path');
const gates = require('../gates');
const tasks = require('../tasks');
const { newId } = require('../util');
const C = require('./constants');
const events = require('./events');
const bundle = require('./bundle');
const snapshots = require('./snapshots');
const { project } = require('./projection');
const { ruleError } = require('./errors');

const GATES = Object.keys(C.GATE_STAGES);
const ENGINE = 'gf-engine';

function isEnabled(store) {
  return store.isInitialized() && project(store.readEvents()).initialized !== null;
}

const gfState = (store) => project(store.readEvents());

function gateStart(store, config, gateId, actor, opts) {
  if (isEnabled(store) && String(gateId).startsWith('phase:')) {
    const gf = gfState(store);
    const problems = [];
    if (!gf.seal) problems.push({ rule: 'GF-SEAL-1', message: `gate ${gateId} cannot start: G1 is not sealed (approving the plan gate seals it)` });
    else if (!gf.estimate.original) problems.push({ rule: 'GF-EST-1', message: `gate ${gateId} cannot start: no estimate is registered` });
    if (problems.length) throw ruleError(problems);
  }
  return gates.startGate(store, config, gateId, actor, opts);
}

function gateSubmit(store, config, gateId, actor, opts = {}) {
  const { artifacts = [], respondsTo, notes } = opts;
  if (!isEnabled(store) || !GATES.includes(gateId)) return gates.submit(store, config, gateId, actor, opts);
  const { problems, registrations } = bundle.validateGate(store.root, gateId, artifacts, store.state(), config);
  if (problems.length) throw ruleError(problems);
  const result = gates.submit(store, config, gateId, actor, { artifacts, respondsTo, notes });
  const submitted = new Map(result.event.data.artifacts.map((a) => [a.path, a.sha256]));
  const changed = registrations.flatMap((r) => r.files).filter((f) => submitted.get(f.path) !== f.sha256);
  if (changed.length) {
    throw ruleError([{ rule: 'GF-ART-1', message: `${changed.map((f) => f.path).join(', ')} changed between validation and the committed submission ${result.event.data.submissionId}; nothing was registered. Resubmit.` }]);
  }
  for (const r of registrations) {
    events.commit(store, 'gf.artifact.registered', actor, { stage: r.stage, gate: gateId, submissionId: result.event.data.submissionId, files: r.files, validator: { name: r.stage, version: 1 } });
  }
  return result;
}

/** GF-ART-1: a submission is approved only when every stage of its gate was registered at exactly its artifact hashes. */
function registrationProblems(store, gateId, sub) {
  const gf = gfState(store);
  const out = [];
  for (const stage of C.GATE_STAGES[gateId]) {
    const reg = gf.registrations.find((r) => r.submissionId === sub.id && r.stage === stage);
    if (!reg) { out.push({ rule: 'GF-ART-1', message: `submission ${sub.id} of ${gateId} has no registered ${stage} artifacts (it did not pass through the Greenfield-Senior submit)` }); continue; }
    for (const f of reg.files) {
      const a = sub.artifacts.find((x) => x.path === f.path);
      if (!a || a.sha256 !== f.sha256) out.push({ rule: 'GF-ART-1', message: `registered ${f.path} differs from submission ${sub.id}` });
    }
  }
  return out;
}

/** The base state as it will be once `sub` is the approved plan submission, to validate and seal against. */
function asApproved(state, sub) {
  return { ...state, gates: { ...state.gates, plan: { ...state.gates.plan, status: 'approved', approvedSubmission: sub.id } } };
}

function gateReview(store, config, gateId, reviewer, review) {
  if (!isEnabled(store) || !GATES.includes(gateId)) return gates.recordReview(store, config, gateId, reviewer, review);
  if (review && review.decision === 'approve') {
    const state = store.state();
    const g = state.gates[gateId];
    const sub = g && g.submissions[g.submissions.length - 1];
    if (sub) {
      const problems = registrationProblems(store, gateId, sub);
      if (gateId === 'plan' && !problems.length) {
        const found = bundle.validateApproved(store.root, asApproved(state, sub), config).problems;
        if (found.length) problems.push({ rule: 'GF-SEAL-1', message: 'G1 cannot be sealed on this approval' }, ...found);
      }
      if (problems.length) throw ruleError(problems);
    }
  }
  const result = gates.recordReview(store, config, gateId, reviewer, review);
  if (gateId === 'plan' && store.state().gates.plan.status === 'approved' && !gfState(store).seal) seal(store, config);
  return result;
}

/** Register the estimate, then seal the contracts: both are facts about the approved plan bundle. */
function seal(store, config) {
  const state = store.state();
  const plan = state.gates.plan;
  const checked = bundle.validateApproved(store.root, state, config).problems;
  if (checked.length) throw ruleError([{ rule: 'GF-SEAL-1', message: 'G1 cannot be sealed' }, ...checked]);
  const hashes = bundle.approvedHashes(state);
  for (const [p, h] of Object.entries(hashes)) {
    if (p.startsWith('contracts/') && snapshots.write(store.root, p, h) !== h) throw ruleError([{ rule: 'GF-SEAL-1', message: `${p} changed while G1 was being sealed` }]);
  }
  const estPath = Object.keys(hashes).find((p) => path.posix.basename(p) === 'estimates.json');
  const est = JSON.parse(fs.readFileSync(path.join(store.root, estPath), 'utf8').replace(/^﻿/, ''));
  const registered = events.commit(store, 'gf.estimate.registered', ENGINE, {
    id: newId('est'), planSubmissionId: plan.approvedSubmission, sha256: hashes[estPath], label: est.label, basis: est.basis, groups: est.groups,
  });
  return events.commit(store, 'gf.g1.sealed', ENGINE, {
    contractsHash: bundle.contractsHashOf(hashes), hashes, planSubmissionId: plan.approvedSubmission, estimateSeq: registered.event.seq,
  });
}

function taskClaim(store, config, taskId, actor, opts) {
  if (isEnabled(store) && !gfState(store).seal) {
    throw ruleError([{ rule: 'GF-SEAL-1', message: `task ${taskId} cannot be claimed: G1 is not sealed (the plan gate approval seals it)` }]);
  }
  return tasks.claim(store, config, taskId, actor, opts);
}

module.exports = { isEnabled, gfState, gateStart, gateSubmit, gateReview, taskClaim, seal, registrationProblems };
