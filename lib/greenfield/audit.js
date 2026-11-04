'use strict';
// `gf audit`: log replay. Every rule the managed path enforces at write time is re-evaluated here as an
// invariant over the whole record, so a violation committed through ANY path (the plain `eccode` CLI, a hand
// edit, a forged event) is reported in every profile. Read-only, and it never throws: a defect it cannot
// evaluate is itself an error (GF-AUD-1). The frozen half (`store.audit()` plus `delivery.unreviewedChanges`,
// which is what `eccode audit` runs) is included and must also be clean.
const fs = require('fs');
const path = require('path');
const delivery = require('../delivery');
const C = require('./constants');
const bundle = require('./bundle');
const contracts = require('./contracts');
const history = require('./history');
const { canonical } = require('./jsonschema');
const { project } = require('./projection');

const GATES = Object.keys(C.GATE_STAGES);
const GROUP_NAMES = new Set([...Object.keys(C.GROUPS), 'orchestrator']);

function readJsonFile(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
}

function run(store, config) {
  const log = store.readEvents();
  const state = store.state();
  const errors = [];
  const E = (rule, message, seq) => errors.push(seq === undefined ? { rule, message } : { rule, seq, message });

  const baseAudit = store.audit();
  const unreviewed = delivery.unreviewedChanges(state, store.root);
  const base = { ok: baseAudit.errors.length === 0 && unreviewed.length === 0, errors: baseAudit.errors, unreviewed };
  const hasGf = log.some((e) => String(e.type).startsWith('gf.'));
  if (!hasGf) return { ok: base.ok, enabled: false, errors, base };

  const gf = project(log);
  try {
    for (const u of gf.unknown) E('GF-AUD-1', `unknown event type ${u.type}`, u.seq);
    for (const i of gf.invalid) E('GF-AUD-1', `${i.type} is malformed: ${i.errors.join('; ')}`, i.seq);
    if (!gf.initialized) { E('GF-AUD-2', 'gf events exist but no valid gf.project.initialized'); return { ok: false, enabled: true, errors, base }; }
    for (const x of gf.extraInits) E('GF-AUD-2', 'a second gf.project.initialized', x.seq);
    const firstGf = log.find((e) => String(e.type).startsWith('gf.'));
    if (firstGf && firstGf.seq !== gf.initialized.seq) E('GF-AUD-2', 'gf.project.initialized is not the first gf event', firstGf.seq);

    // GF-ART-1: every APPROVED document-gate submission was registered, stage by stage, at its committed hashes.
    // (A submission that was never approved needs no registration: the wrapped review refuses to approve it, and a
    // reviewer may always ask for changes.)
    for (const g of GATES) {
      const gate = state.gates[g];
      if (!gate) continue;
      const approved = new Set(gate.approvedSubmission ? [gate.approvedSubmission] : []);
      for (const rid of gate.reviews || []) {
        const rv = state.reviews[rid];
        if (rv && rv.decision === 'approve') approved.add(rv.submissionId);
      }
      for (const sub of gate.submissions || []) {
        if (!approved.has(sub.id)) continue;
        for (const stage of C.GATE_STAGES[g]) {
          const reg = gf.registrations.find((r) => r.submissionId === sub.id && r.stage === stage);
          if (!reg) { E('GF-ART-1', `submission ${sub.id} of ${g} was approved with no registered ${stage} artifacts (it was not submitted through the Greenfield-Senior path)`); continue; }
          for (const f of reg.files) {
            const a = sub.artifacts.find((x) => x.path === f.path);
            if (!a || a.sha256 !== f.sha256) E('GF-ART-1', `the registration of ${f.path} does not match submission ${sub.id}`, reg.seq);
          }
        }
      }
    }

    // The artifact rules, re-run on the approved bundles at their approved hashes, each gate against the record
    // as it stood at ITS approval (registrations are not trusted).
    try {
      for (const p of bundle.validateApproved(store.root, state, config, { stateFor: (g) => history.stateAtApproval(log, state, g) }).problems) E(p.rule, p.message);
    } catch (e) {
      E('GF-AUD-1', `the approved bundles could not be validated: ${e && e.message ? e.message : e}`);
    }

    // GF-WBS-1: the engine's tasks are the validated plan.json (the frozen plan gate imports the FIRST .json it is given).
    if (state.plan && state.plan.source) {
      const src = String(state.plan.source);
      if (path.posix.basename(src) !== 'plan.json') E('GF-WBS-1', `the engine imported its tasks from ${src}, not from plan.json: the tasks are not the validated plan`);
      else {
        const approvedHash = bundle.approvedHashes(state)[src];
        if (approvedHash && contracts.fileHash(store.root, src) === approvedHash) {
          const ids = ((readJsonFile(path.join(store.root, src)).tasks) || []).map((t) => t.id).sort();
          const have = Object.keys(state.tasks).sort();
          if (JSON.stringify(ids) !== JSON.stringify(have)) E('GF-WBS-1', `the engine's tasks (${have.join(', ')}) differ from the approved plan.json (${ids.join(', ')})`);
        }
      }
    }

    // GF-THR-1: the design gate was reviewed by the technical AND the security reviewer.
    const design = state.gates.design;
    if (design && design.status === 'approved') {
      const named = design.reviewers || [];
      const unnamed = C.DESIGN_REVIEWERS.filter((r) => !named.includes(r));
      if (unnamed.length) E('GF-THR-1', `the design gate was started without naming ${unnamed.join(', ')} as reviewer(s): the threat model was not reviewed by the security reviewer`);
      else {
        const approvers = new Set((design.reviews || []).map((id) => state.reviews[id]).filter((rv) => rv && rv.decision === 'approve' && rv.submissionId === design.approvedSubmission).map((rv) => rv.reviewer));
        const lacking = C.DESIGN_REVIEWERS.filter((r) => !approvers.has(r));
        if (lacking.length) E('GF-THR-1', `the approved design submission has no approval from ${lacking.join(', ')}`);
      }
    }

    // GF-ORD-1: nothing was claimed or started in a phase before G1 was sealed.
    const sealSeq = gf.seal ? gf.seal.seq : Infinity;
    for (const ev of log) {
      if (ev.seq < sealSeq && (ev.type === 'task.claimed' || (ev.type === 'gate.started' && String(ev.data.gate).startsWith('phase:')))) {
        E('GF-ORD-1', `${ev.type} ${ev.data.task || ev.data.gate} at seq ${ev.seq} happened before G1 was sealed`, ev.seq);
      }
    }

    // GF-SEAL-1.
    const plan = state.gates.plan;
    const approvedPlan = Boolean(plan && plan.status === 'approved');
    const hashes = bundle.approvedHashes(state);
    if (approvedPlan && !gf.seal) E('GF-SEAL-1', 'the plan gate is approved but G1 was never sealed');
    if (gf.seal && !approvedPlan) E('GF-SEAL-1', 'G1 is sealed but the plan gate is not approved', gf.seal.seq);
    for (const x of gf.extraSeals) E('GF-SEAL-1', 'a second gf.g1.sealed', x.seq);
    if (gf.seal && approvedPlan) {
      const keys = new Set([...Object.keys(hashes), ...Object.keys(gf.seal.hashes)]);
      const off = [...keys].filter((k) => hashes[k] !== gf.seal.hashes[k]);
      if (off.length) E('GF-SEAL-1', `the seal's hashes differ from the approved submissions for ${off.slice(0, 5).join(', ')}${off.length > 5 ? ` (+${off.length - 5})` : ''}`, gf.seal.seq);
      else if (gf.seal.contractsHash !== bundle.contractsHashOf(hashes)) E('GF-SEAL-1', 'contractsHash does not match the sealed files', gf.seal.seq);
      if (gf.seal.planSubmissionId !== plan.approvedSubmission) E('GF-SEAL-1', `the seal names plan submission ${gf.seal.planSubmissionId}, but ${plan.approvedSubmission} was approved`, gf.seal.seq);
      if (!gf.estimate.original || gf.seal.estimateSeq !== gf.estimate.original.seq) E('GF-SEAL-1', 'the seal does not cite the registered estimate', gf.seal.seq);
    }

    // GF-EST-1: one estimate, the approved plan's own, registered before the seal; revisions beside it.
    const est = gf.estimate.original;
    for (const x of gf.extraEstimates) E('GF-EST-1', 'a second gf.estimate.registered', x.seq);
    if (gf.seal && est && est.seq > gf.seal.seq) E('GF-EST-1', 'the estimate was registered after the seal', est.seq);
    if (est && approvedPlan) {
      if (est.planSubmissionId !== plan.approvedSubmission) E('GF-EST-1', `the registered estimate's planSubmissionId ${est.planSubmissionId} is not the approved plan submission ${plan.approvedSubmission}`, est.seq);
      const estPath = Object.keys(hashes).find((p) => path.posix.basename(p) === 'estimates.json');
      if (!estPath || hashes[estPath] !== est.sha256) E('GF-EST-1', "the registered estimate's sha256 is not the approved estimates.json", est.seq);
      if (estPath && contracts.fileHash(store.root, estPath) === hashes[estPath]) {
        const doc = readJsonFile(path.join(store.root, estPath));
        if (canonical(doc.groups) !== canonical(est.groups) || doc.label !== est.label || doc.basis !== est.basis) E('GF-EST-1', "the registered estimate's groups, label or basis differ from the approved estimates.json", est.seq);
      }
    }
    for (const rev of gf.estimate.revisions) {
      if (!est) E('GF-EST-1', 'an estimate revision without a registered estimate', rev.seq);
      else if (rev.of !== est.id) E('GF-EST-1', `estimate revision ${rev.id} revises ${rev.of}, which is not the registered estimate`, rev.seq);
      if (!C.ESTIMATE_REVISERS.includes(rev.actor)) E('GF-EST-1', `estimate revision ${rev.id} was recorded by ${rev.actor}, who may not revise (${C.ESTIMATE_REVISERS.join(', ')} may)`, rev.seq);
    }

    // GF-FRZ-2 and GF-FRZ-5: the contract files, their snapshots, the requests and the amendment chain.
    for (const d of contracts.drift(store.root, gf)) E(d.rule, d.message);
    for (const d of contracts.snapshotProblems(store.root, gf)) E(d.rule, d.message);
    for (const d of contracts.chainProblems(gf, config)) E(d.rule, d.message, d.seq);
    for (const d of contracts.classificationProblems(store.root, gf)) E(d.rule, d.message, d.seq);
    for (const d of contracts.amendedProblems(store.root, gf)) E(d.rule, d.message);

    // GF-MSG-1/2: messages come from the actor's own group, to real groups, replying to earlier messages; an amendment request goes to api.
    for (const m of gf.messages) {
      if (C.groupOf(m.actor) !== m.from) E('GF-MSG-1', `message ${m.id} claims to be from ${m.from}, but ${m.actor} is in ${C.groupOf(m.actor) || 'no group'}`, m.seq);
      for (const t of m.to) if (!GROUP_NAMES.has(t)) E('GF-MSG-1', `message ${m.id} is addressed to unknown group ${t}`, m.seq);
      if (m.kind === 'amendment-request' && !m.to.includes('api')) E('GF-MSG-2', `message ${m.id} is an amendment request not addressed to the api group`, m.seq);
      if (m.inReplyTo && !gf.messages.some((x) => x.id === m.inReplyTo && x.seq < m.seq)) E('GF-MSG-1', `message ${m.id}: inReplyTo ${m.inReplyTo} is not an earlier recorded message`, m.seq);
    }
  } catch (e) {
    E('GF-AUD-1', `the audit could not complete: ${e && e.message ? e.message : e}`);
  }

  const seen = new Set();
  const unique = errors.filter((e) => { const k = `${e.rule}|${e.seq || ''}|${e.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ok: unique.length === 0 && base.ok, enabled: true, errors: unique, base };
}

module.exports = { run };
