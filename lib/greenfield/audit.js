'use strict';
// `gf audit`: log replay. Every rule the managed path enforces at write time is re-evaluated here as an
// invariant over the whole record, so a violation committed through ANY path (the plain `eccode` CLI, a hand
// edit, a forged event) is reported in every profile. Read-only. The frozen half (`store.audit()` plus
// `delivery.unreviewedChanges`, which is what `eccode audit` runs) is included and must also be clean.
const delivery = require('../delivery');
const C = require('./constants');
const bundle = require('./bundle');
const contracts = require('./contracts');
const { project } = require('./projection');

const GATES = Object.keys(C.GATE_STAGES);
const GROUP_NAMES = new Set([...Object.keys(C.GROUPS), 'orchestrator']);

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
  for (const u of gf.unknown) E('GF-AUD-1', `unknown event type ${u.type}`, u.seq);
  for (const i of gf.invalid) E('GF-AUD-1', `${i.type} is malformed: ${i.errors.join('; ')}`, i.seq);
  if (!gf.initialized) { E('GF-AUD-2', 'gf events exist but no valid gf.project.initialized'); return { ok: false, enabled: true, errors, base }; }
  for (const x of gf.extraInits) E('GF-AUD-2', 'a second gf.project.initialized', x.seq);
  const firstGf = log.find((e) => String(e.type).startsWith('gf.'));
  if (firstGf && firstGf.seq !== gf.initialized.seq) E('GF-AUD-2', 'gf.project.initialized is not the first gf event', firstGf.seq);

  // GF-ART-1: every submission of a document gate was registered, stage by stage, at its committed hashes.
  for (const g of GATES) {
    for (const sub of (state.gates[g] && state.gates[g].submissions) || []) {
      for (const stage of C.GATE_STAGES[g]) {
        const reg = gf.registrations.find((r) => r.submissionId === sub.id && r.stage === stage);
        if (!reg) { E('GF-ART-1', `submission ${sub.id} of ${g} has no registered ${stage} artifacts (it was not submitted through the Greenfield-Senior path)`); continue; }
        for (const f of reg.files) {
          const a = sub.artifacts.find((x) => x.path === f.path);
          if (!a || a.sha256 !== f.sha256) E('GF-ART-1', `the registration of ${f.path} does not match submission ${sub.id}`, reg.seq);
        }
      }
    }
  }

  // The artifact rules, re-run on the approved bundles at their approved hashes (registrations are not trusted).
  for (const p of bundle.validateApproved(store.root, state, config).problems) E(p.rule, p.message);

  // GF-ORD-1: nothing was claimed or started in a phase before G1 was sealed.
  const sealSeq = gf.seal ? gf.seal.seq : Infinity;
  for (const ev of log) {
    if (ev.seq < sealSeq && (ev.type === 'task.claimed' || (ev.type === 'gate.started' && String(ev.data.gate).startsWith('phase:')))) {
      E('GF-ORD-1', `${ev.type} ${ev.data.task || ev.data.gate} at seq ${ev.seq} happened before G1 was sealed`, ev.seq);
    }
  }

  // GF-SEAL-1 and GF-EST-1.
  const plan = state.gates.plan;
  if (plan && plan.status === 'approved' && !gf.seal) E('GF-SEAL-1', 'the plan gate is approved but G1 was never sealed');
  if (gf.seal && !(plan && plan.status === 'approved')) E('GF-SEAL-1', 'G1 is sealed but the plan gate is not approved', gf.seal.seq);
  for (const x of gf.extraSeals) E('GF-SEAL-1', 'a second gf.g1.sealed', x.seq);
  if (gf.seal && plan && plan.status === 'approved') {
    const hashes = bundle.approvedHashes(state);
    const keys = new Set([...Object.keys(hashes), ...Object.keys(gf.seal.hashes)]);
    const off = [...keys].filter((k) => hashes[k] !== gf.seal.hashes[k]);
    if (off.length) E('GF-SEAL-1', `the seal's hashes differ from the approved submissions for ${off.slice(0, 5).join(', ')}${off.length > 5 ? ` (+${off.length - 5})` : ''}`, gf.seal.seq);
    else if (gf.seal.contractsHash !== bundle.contractsHashOf(hashes)) E('GF-SEAL-1', 'contractsHash does not match the sealed files', gf.seal.seq);
    if (gf.seal.planSubmissionId !== plan.approvedSubmission) E('GF-SEAL-1', `the seal names plan submission ${gf.seal.planSubmissionId}, but ${plan.approvedSubmission} was approved`, gf.seal.seq);
    if (!gf.estimate.original || gf.seal.estimateSeq !== gf.estimate.original.seq) E('GF-SEAL-1', 'the seal does not cite the registered estimate', gf.seal.seq);
  }
  for (const x of gf.extraEstimates) E('GF-EST-1', 'a second gf.estimate.registered', x.seq);
  if (gf.seal && gf.estimate.original && gf.estimate.original.seq > gf.seal.seq) E('GF-EST-1', 'the estimate was registered after the seal', gf.estimate.original.seq);
  for (const x of gf.estimate.original ? [] : gf.estimate.revisions) E('GF-EST-1', 'an estimate revision without a registered estimate', x.seq);

  // GF-FRZ-2: the contract files still have the bytes they were sealed (or last amended) with.
  for (const d of contracts.drift(store.root, gf)) E(d.rule, d.message);
  for (const d of contracts.snapshotProblems(store.root, gf)) E(d.rule, d.message);

  // GF-FRZ-5: requests and amendments are well-formed, in order, by reviewers, and the hash chain is unbroken.
  for (const d of contracts.chainProblems(gf, config)) E(d.rule, d.message, d.seq);
  for (const d of contracts.amendedProblems(store.root, gf)) E(d.rule, d.message);

  // GF-MSG-1/2: messages come from the actor's own group, to real groups; an amendment request goes to api.
  for (const m of gf.messages) {
    if (C.groupOf(m.actor) !== m.from) E('GF-MSG-1', `message ${m.id} claims to be from ${m.from}, but ${m.actor} is in ${C.groupOf(m.actor) || 'no group'}`, m.seq);
    for (const t of m.to) if (!GROUP_NAMES.has(t)) E('GF-MSG-1', `message ${m.id} is addressed to unknown group ${t}`, m.seq);
    if (m.kind === 'amendment-request' && !m.to.includes('api')) E('GF-MSG-2', `message ${m.id} is an amendment request not addressed to the api group`, m.seq);
  }

  const seen = new Set();
  const unique = errors.filter((e) => { const k = `${e.rule}|${e.seq || ''}|${e.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ok: unique.length === 0 && base.ok, enabled: true, errors: unique, base };
}

module.exports = { run };
