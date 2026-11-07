'use strict';
// The gf.* events: schemas validated before anything touches the log, committed through the frozen store so
// they join its hash chain, and rebuilt into GF state by a pure projection that the frozen reducer never sees.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpProject } = require('./helpers');
const C = require('../lib/greenfield/constants');
const events = require('../lib/greenfield/events');
const { project } = require('../lib/greenfield/projection');

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const groupsEntry = { minutes: { low: 30, high: 60 }, tokens: { low: 100000, high: 300000 }, tasks: 2 };
const BASIS = 'Judgment ranges from the compute ledger precedent, not measurements.';

const VALID = {
  'gf.project.initialized': { stackProfile: 'python-fastapi-sqlalchemy-sqlite', schemaVersion: 1, groups: C.GROUPS },
  'gf.artifact.registered': { stage: 'prd', gate: 'architecture', submissionId: 'sub-1', files: [{ path: '.eccode/artifacts/prd.json', sha256: SHA }], validator: { name: 'prd', version: 1 } },
  'gf.estimate.registered': { id: 'est-1', planSubmissionId: 'sub-3', sha256: SHA, label: 'agent-estimate-uncalibrated', basis: BASIS, groups: { backend: groupsEntry } },
  'gf.estimate.revised': { id: 'est-2', of: 'est-1', reason: 'the contract grew by two operations', groups: { backend: groupsEntry } },
  'gf.g1.sealed': { contractsHash: SHA, hashes: { 'contracts/openapi.json': SHA2 }, planSubmissionId: 'sub-3', estimateSeq: 5 },
  'gf.message': { id: 'msg-1', from: 'frontend', to: ['api'], kind: 'question', subject: 'pagination', body: 'Does listTasks paginate?', refs: [] },
  'gf.contract.amendment.requested': { id: 'req-1', contract: 'contracts/openapi.json', reason: 'the client needs a field the contract lacks', message: 'msg-1', proposed: 'add due to Task' },
  'gf.contract.amended': { id: 'am-1', request: 'req-1', contract: 'contracts/openapi.json', fromSha: SHA, toSha: SHA2, reason: 'approved: the field is needed by AC-4 and is additive', classification: 'additive', affectedOps: ['listTasks'], invalidates: [] },
  'gf.ownership.amended': { id: 'own-1', group: 'db', from: ['app/db/**'], to: ['app/db/**', 'alembic.ini'], reason: 'the db group needs the alembic configuration file', message: 'msg-1' },
  'gf.config.pinned': { id: 'pin-1', scope: 'S1', files: { '.eccode/security.json': SHA }, reason: 'pin the guard configuration' },
  'gf.dispatch.recorded': { id: 'disp-1', scope: 'S2', role: 'technical-reviewer', step: 'critique', treeHash: 'c'.repeat(40), inputs: [{ path: 'docs/design.md', sha256: SHA }] },
  'gf.review.recorded': { id: 'rev-1', scope: 'S2', step: 'critique', dispatch: 'disp-1', treeHash: 'c'.repeat(40), summary: 'x'.repeat(120), verdict: 'findings', findings: [{ id: 'F-1', severity: 'major', kind: 'defect', summary: 'a forged event is accepted' }] },
  'gf.finding.resolved': { id: 'res-1', finding: 'F-1', resolution: 'fixed', proof: 'ev:ev-post-1' },
  'gf.battery.recorded': { id: 'bat-1', scope: 'S2', round: 1, treeHash: 'c'.repeat(40), evidence: 'ev:ev-1', total: 5, killed: 5, survived: 0, survivors: [] },
  'gf.slice.closed': { scope: 'S2', treeHash: 'c'.repeat(40), steps: { comprehension: 'r1', critique: 'r2', readiness: 'r3' }, batteries: ['b1', 'b2'], accepted: [], accounting: { unit: 'all-processed-tokens', start: 'unmeasurable', end: 4000 } },
};

// One invalid payload per type, each violating exactly one field.
const INVALID = {
  'gf.project.initialized': { ...VALID['gf.project.initialized'], stackProfile: 'node-express' },
  'gf.artifact.registered': { ...VALID['gf.artifact.registered'], stage: 'poetry' },
  'gf.estimate.registered': { ...VALID['gf.estimate.registered'], label: 'calibrated' },
  'gf.estimate.revised': { ...VALID['gf.estimate.revised'], reason: 'short' },
  'gf.g1.sealed': { ...VALID['gf.g1.sealed'], contractsHash: 'xyz' },
  'gf.message': { ...VALID['gf.message'], kind: 'gossip' },
  'gf.contract.amendment.requested': { ...VALID['gf.contract.amendment.requested'], contract: undefined },
  'gf.contract.amended': { ...VALID['gf.contract.amended'], classification: 'maybe' },
  'gf.ownership.amended': { ...VALID['gf.ownership.amended'], to: [] },
  'gf.config.pinned': { ...VALID['gf.config.pinned'], files: { '.eccode/security.json': 'nothex' } },
  'gf.dispatch.recorded': { ...VALID['gf.dispatch.recorded'], step: 'vibes' },
  'gf.review.recorded': { ...VALID['gf.review.recorded'], summary: 'too short' },
  'gf.finding.resolved': { ...VALID['gf.finding.resolved'], resolution: 'ignored' },
  'gf.battery.recorded': { ...VALID['gf.battery.recorded'], round: 0 },
  'gf.slice.closed': { ...VALID['gf.slice.closed'], accounting: { unit: 'all-processed-tokens', start: '', end: null } },
};

test('the constants: groups map to the roles of the design, three new roles, one stack profile', () => {
  assert.deepStrictEqual(Object.keys(C.GROUPS).sort(), ['api', 'backend', 'db', 'delivery', 'frontend', 'security', 'test']);
  assert.deepStrictEqual(C.NEW_ROLES.sort(), ['database-engineer', 'integration-engineer', 'security-engineer']);
  assert.strictEqual(C.groupOf('integration-engineer'), 'api');
  assert.strictEqual(C.groupOf('devops-engineer'), 'delivery');
  assert.strictEqual(C.groupOf('delivery-lead'), 'delivery');
  assert.strictEqual(C.groupOf('orchestrator'), 'orchestrator');
  assert.strictEqual(C.groupOf('technical-reviewer'), null);
  assert.deepStrictEqual(C.STACK_PROFILES, ['python-fastapi-sqlalchemy-sqlite']);
  assert.deepStrictEqual(C.GATE_STAGES, { architecture: ['prd', 'architecture'], design: ['contracts', 'threat'], plan: ['breakdown', 'estimates'] });
  assert.ok(C.CONTRACT_FILES.every((f) => f.startsWith('contracts/')));
  assert.deepStrictEqual(C.EVENT_TYPES.slice().sort(), Object.keys(VALID).sort());
});

for (const type of Object.keys(VALID)) {
  test(`${type}: a valid payload is accepted, an invalid one is refused with a reason`, () => {
    assert.deepStrictEqual(events.validate(type, VALID[type]), []);
    const errs = events.validate(type, INVALID[type]);
    assert.ok(errs.length >= 1, 'the invalid payload must be refused');
  });
}

for (const type of Object.keys(VALID)) {
  test(`${type}: a payload with a field the schema does not name is refused (no event carries extra fields)`, () => {
    assert.ok(events.validate(type, { ...VALID[type], smuggled: 'x' }).some((m) => /smuggled|additional/i.test(m)), type);
  });
}

test('an unknown gf type is refused by validate', () => {
  assert.ok(events.validate('gf.zzz', {}).some((m) => /unknown/.test(m)));
  assert.strictEqual(events.isGfType('gf.message'), true);
  assert.strictEqual(events.isGfType('gate.started'), false);
});

test('commit: an invalid payload leaves events.jsonl byte-identical; a valid one joins the base hash chain and audit stays clean', () => {
  const ctx = tmpProject();
  const file = path.join(ctx.dir, '.eccode', 'events.jsonl');
  const before = fs.readFileSync(file);
  assert.throws(() => events.commit(ctx.store, 'gf.message', 'orchestrator', INVALID['gf.message']), (e) => e.code === 'GF_EVENT_INVALID' && /kind/.test(e.message));
  assert.ok(Buffer.compare(before, fs.readFileSync(file)) === 0, 'the log must not change on a refusal');

  const { event } = events.commit(ctx.store, 'gf.project.initialized', 'orchestrator', VALID['gf.project.initialized']);
  assert.strictEqual(event.type, 'gf.project.initialized');
  const audit = ctx.store.audit();
  assert.deepStrictEqual(audit.errors, []);
  // the frozen reducer ignored the event: the snapshot equals a replay, and nothing GF-specific is in the base state
  assert.strictEqual(JSON.stringify(ctx.store.state()), JSON.stringify(ctx.store.rebuild()));
  assert.strictEqual(Object.keys(ctx.store.state()).some((k) => /^gf/i.test(k)), false);
});

test('commit runs the caller\'s check inside the lock and a throwing check commits nothing', () => {
  const ctx = tmpProject();
  const file = path.join(ctx.dir, '.eccode', 'events.jsonl');
  const before = fs.readFileSync(file);
  assert.throws(() => events.commit(ctx.store, 'gf.project.initialized', 'orchestrator', VALID['gf.project.initialized'], () => { throw new Error('refused by the check'); }), /refused by the check/);
  assert.ok(Buffer.compare(before, fs.readFileSync(file)) === 0);
});

test('projection: rebuilds registrations, estimate, seal, requests, amendments and messages by replay; pure and repeatable', () => {
  const ctx = tmpProject();
  for (const type of ['gf.project.initialized', 'gf.artifact.registered', 'gf.estimate.registered', 'gf.estimate.revised', 'gf.g1.sealed', 'gf.message', 'gf.contract.amendment.requested', 'gf.contract.amended', 'gf.ownership.amended', 'gf.config.pinned', 'gf.dispatch.recorded', 'gf.review.recorded', 'gf.finding.resolved', 'gf.battery.recorded', 'gf.slice.closed']) {
    events.commit(ctx.store, type, 'orchestrator', VALID[type]);
  }
  const evs = ctx.store.readEvents();
  const a = project(evs);
  assert.strictEqual(a.initialized.stackProfile, 'python-fastapi-sqlalchemy-sqlite');
  assert.strictEqual(a.registrations.length, 1);
  assert.strictEqual(a.registrations[0].stage, 'prd');
  assert.strictEqual(a.estimate.original.id, 'est-1');
  assert.strictEqual(a.estimate.revisions.length, 1);
  assert.strictEqual(a.seal.contractsHash, SHA);
  assert.strictEqual(a.messages.length, 1);
  assert.strictEqual(a.requests.length, 1);
  assert.strictEqual(a.amendments.length, 1);
  assert.strictEqual(a.ownershipAmendments.length, 1);
  assert.strictEqual(a.configPins.length, 1);
  assert.strictEqual(a.closures.length, 1);
  assert.strictEqual(a.reviews.length, 1);
  assert.deepStrictEqual(a.unknown, []);
  assert.deepStrictEqual(a.invalid, []);
  assert.deepStrictEqual(project(evs), a, 'replaying the same events gives a deep-equal result');
  assert.strictEqual(project([]).initialized, null);
});

test('projection: unknown gf types and schema-invalid forged events are listed, never merged into the state; later duplicates are kept apart', () => {
  const ctx = tmpProject();
  events.commit(ctx.store, 'gf.project.initialized', 'orchestrator', VALID['gf.project.initialized']);
  // bypass: forged straight through the frozen store, as the plain eccode CLI path would
  ctx.store.commit('gf.zzz', 'orchestrator', { anything: true });
  ctx.store.commit('gf.g1.sealed', 'orchestrator', { contractsHash: 'not-a-hash' });
  ctx.store.commit('gf.project.initialized', 'orchestrator', VALID['gf.project.initialized']);
  ctx.store.commit('gf.g1.sealed', 'orchestrator', VALID['gf.g1.sealed']);
  ctx.store.commit('gf.g1.sealed', 'orchestrator', { ...VALID['gf.g1.sealed'], contractsHash: SHA2 });
  const p = project(ctx.store.readEvents());
  assert.deepStrictEqual(p.unknown.map((u) => u.type), ['gf.zzz']);
  assert.strictEqual(p.invalid.length, 1);
  assert.strictEqual(p.invalid[0].type, 'gf.g1.sealed');
  assert.strictEqual(p.seal.contractsHash, SHA, 'the first valid seal wins');
  assert.strictEqual(p.extraSeals.length, 1);
  assert.strictEqual(p.extraInits.length, 1);
  assert.strictEqual(ctx.store.audit().ok, true, 'the frozen audit sees nothing wrong: GF detection is the layer\'s job');
});
