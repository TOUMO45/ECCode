'use strict';
// The public surface of the layer and its hook into the MCP server (lib/mcp.js): `extendTools` replaces the four
// gate and claim tools with handlers that run the Greenfield-Senior rules when the record is a Greenfield-Senior
// project (and call the original handler, unchanged, when it is not) and appends the gf_* tools.
const gates = require('../gates');
const C = require('./constants');
const wrap = require('./wrap');
const bundle = require('./bundle');
const messages = require('./messages');
const contracts = require('./contracts');
const estimate = require('./estimate');
const audit = require('./audit');
const ownershipOps = require('./ownership-ops');
const pin = require('./pin');
const { ruleError } = require('./errors');
const { project } = require('./projection');
const { initProject } = require('./init');
const { EccodeError } = require('../util');

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = { type: 'object' };

function status(store) {
  if (!wrap.isEnabled(store)) return { enabled: false };
  const gf = project(store.readEvents());
  return {
    enabled: true,
    stackProfile: gf.stackProfile,
    stages: C.GATE_STAGES,
    registered: [...new Set(gf.registrations.map((r) => r.stage))],
    sealed: Boolean(gf.seal),
    contractsHash: gf.seal ? gf.seal.contractsHash : null,
    estimateRegistered: Boolean(gf.estimate.original),
    estimateRevisions: gf.estimate.revisions.length,
    requests: gf.requests.length,
    amendments: gf.amendments.length,
    ownershipAmendments: gf.ownershipAmendments.length,
    messages: gf.messages.length,
  };
}

function validateDryRun(store, config, { gate, artifacts }) {
  if (!C.GATE_STAGES[gate]) throw new EccodeError('UNKNOWN_GATE', `gf_validate checks the document gates: ${Object.keys(C.GATE_STAGES).join(', ')}`);
  const r = bundle.validateGate(store.root, gate, artifacts || [], store.state(), config);
  return { ok: r.problems.length === 0, problems: r.problems, stages: r.registrations.map((x) => x.stage) };
}

function gfTools() {
  return [
    { name: 'gf_status', description: 'Greenfield-Senior state: whether the layer is on, which G1 stages are registered, whether G1 is sealed, the estimate, amendments, messages.', schema: {}, handler: (a, c) => status(c.store) },
    { name: 'gf_validate', description: 'Dry run of the G1 rules on the artifacts you are about to submit to architecture, design or plan: returns the rule ids and reasons, writes nothing. Run it before gate_submit.', schema: { gate: str, artifacts: strArr }, required: ['gate', 'artifacts'], handler: (a, c) => validateDryRun(c.store, c.config, a) },
    { name: 'gf_message_send', description: 'Send a hash-chained message from your group to others (kinds: question, answer, amendment-request, blocker, decision, handoff). The only channel between groups. An amendment-request goes to api.', schema: { to: strArr, kind: str, subject: str, body: str, refs: strArr, inReplyTo: str }, required: ['to', 'kind', 'subject', 'body'], handler: (a, c) => messages.send(c.store, c.config, c.actor, a) },
    { name: 'gf_message_list', description: 'Recorded messages, optionally filtered by from (group), to (group) and kind.', schema: { from: str, to: str, kind: str }, handler: (a, c) => messages.list(c.store, a) },
    { name: 'gf_amend_request', description: 'Ask for a change to a sealed contract file, citing your amendment-request message to the api group. After the seal only.', schema: { contract: str, reason: str, message: str, proposed: str }, required: ['contract', 'reason', 'message', 'proposed'], handler: (a, c) => contracts.requestAmendment(c.store, c.config, c.actor, a) },
    { name: 'gf_amend_apply', description: 'Reviewer: record that the contract file now has new, valid bytes, with a reason (30 characters or more). Moves the contract hash chain; classifies the change; refuses an invalid file.', schema: { request: str, reason: str }, required: ['request', 'reason'], handler: (a, c) => contracts.applyAmendment(c.store, c.config, c.actor, a) },
    { name: 'gf_estimate_revise', description: 'Delivery lead or orchestrator: record a revised estimate beside the registered original (the original is what is scored).', schema: { reason: str, groups: obj }, required: ['reason', 'groups'], handler: (a, c) => estimate.revise(c.store, c.config, c.actor, a) },
    { name: 'gf_seal', description: 'Retry sealing G1 after the plan gate was approved but the seal failed (a contract was touched in between, for example). Registers the estimate and seals the contracts; refused if the plan gate is not approved, if the bundle no longer validates, or if G1 is already sealed.', schema: {}, handler: (a, c) => { const r = wrap.seal(c.store, c.config); return { sealed: true, contractsHash: r.event.data.contractsHash, estimateSeq: r.event.data.estimateSeq }; } },
    { name: 'gf_ownership_show', description: 'The ownership map in force: each group with its roles, globs and denied globs, after the reviewer amendments. Read-only.', schema: {}, handler: (a, c) => ownershipOps.describe(c.store, c.config) },
    { name: 'gf_ownership_amend', description: 'Reviewer: change one group\'s globs, with a reason (30 characters or more) and the id of a recorded message that asked for it. Refused if the result is not disjoint, takes a reserved path, or strands a pending task.', schema: { group: str, to: strArr, reason: str, message: str, from: strArr }, required: ['group', 'to', 'reason', 'message'], handler: (a, c) => ownershipOps.amend(c.store, c.config, c.actor, a).event.data },
    { name: 'gf_attribute', description: 'Tree attribution (GF-OWN-4): every path changed since a base commit must be owned by a group that completed a task declaring it. Read-only.', schema: { base: str }, required: ['base'], handler: (a, c) => ownershipOps.attribute(c.store, a.base) },
    { name: 'gf_config_pin', description: 'Orchestrator or user: pin the hashes of .eccode/behavior.json, guards.json and security.json (the guard configuration) under a scope, with a reason. A change after the pin is reported by the audit; group roles cannot write these files.', schema: { scope: str, reason: str }, required: ['scope', 'reason'], handler: (a, c) => pin.pin(c.store, c.config, c.actor, a).event.data },
    { name: 'gf_audit', description: 'Replay the record and check every Greenfield-Senior rule as an invariant, next to the frozen audit. Read-only.', schema: {}, handler: (a, c) => audit.run(c.store, c.config) },
  ];
}

/** Replace gate_start, gate_submit, gate_review and task_claim; append the gf_* tools. */
function extendTools(tools) {
  const original = new Map(tools.map((t) => [t.name, t]));
  const around = (name, managed) => ({ ...original.get(name), handler: (a, c) => (wrap.isEnabled(c.store) ? managed(a, c) : original.get(name).handler(a, c)) });
  const replaced = new Map([
    ['gate_start', around('gate_start', (a, c) => (wrap.gateStart(c.store, c.config, a.gate, c.actor, { reviewers: a.reviewers }), `Gate ${a.gate} started.`))],
    ['gate_submit', around('gate_submit', (a, c) => wrap.gateSubmit(c.store, c.config, a.gate, c.actor, { artifacts: a.artifacts || [], respondsTo: a.respondsTo, notes: a.notes }).event.data)],
    ['gate_review', around('gate_review', (a, c) => {
      const { event } = wrap.gateReview(c.store, c.config, a.gate, c.actor, a.review);
      gates.archiveReview(c.store, event.data.reviewId, a.review);
      return { reviewId: event.data.reviewId, gateStatus: c.store.state().gates[a.gate].status };
    })],
    ['task_rescope', { ...original.get('task_rescope'), handler: (a, c) => {
      if (wrap.isEnabled(c.store)) { const p = ownershipOps.rescopeProblems(c.store, a.task, a.files); if (p.length) throw ruleError(p); }
      return original.get('task_rescope').handler(a, c);
    } }],
    ['task_complete', { ...original.get('task_complete'), handler: (a, c) => {
      if (wrap.isEnabled(c.store)) { const p = ownershipOps.completionCheck(c.store, c.actor, a.handoff); if (p.length) throw ruleError(p); }
      return original.get('task_complete').handler(a, c);
    } }],
    ['task_claim', around('task_claim', (a, c) => ({ ...wrap.taskClaim(c.store, c.config, a.task, c.actor, { runId: a.runId }).event.data, lessons: require('../memory/draft').lessonsForTask(c.store, c.config, a.task) }))],
  ]);
  return [...tools.map((t) => replaced.get(t.name) || t), ...gfTools()];
}

module.exports = { extendTools, gfTools, status, initProject, wrap, bundle, messages, contracts, estimate, audit, ownership: ownershipOps, pin };
