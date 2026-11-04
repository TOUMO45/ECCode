'use strict';
// `gf audit`: guaranteed detection, in every profile, of what the managed path would have refused. Each
// mutation row is driven through the FROZEN engine API (what a caller of the plain `eccode` CLI can do), which
// accepts it; the audit must then report the rule id. Plus the generic bypass battery B1-B5.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { tmpProject } = require('./helpers');
const sample = require('./fixtures/gf/sample');
const { MUTATIONS } = require('./fixtures/gf/mutations');
const { gfProject, run, WRAPPED, FROZEN } = require('./fixtures/gf/flow');
const audit = require('../lib/greenfield/audit');
const events = require('../lib/greenfield/events');

const rules = (r) => r.errors.map((e) => e.rule);
const GATES = ['architecture', 'design', 'plan'];

/** Run through the frozen API as far as it goes; returns the gate it stopped at (null when it reached the end). */
function frozen(ctx, art, opts) {
  try { run(ctx, art, FROZEN, opts); return null; } catch (e) { return `${ctx.at}: ${e.code}`; }
}

test('B0 a clean wrapped flow audits ok, both halves', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  const r = audit.run(ctx.store, ctx.config);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.base.ok, true, JSON.stringify(r.base));
  assert.strictEqual(r.ok, true);
});

test('a non-GF record is audited by the frozen checks only', () => {
  const plain = tmpProject();
  const r = audit.run(plain.store, plain.config);
  assert.strictEqual(r.enabled, false);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.ok, true);
});

for (const m of MUTATIONS) {
  test(`bypass ${m.rule}: the frozen API accepts ${m.name}; the audit reports the rule`, () => {
    const ctx = gfProject();
    const art = sample.build();
    m.apply(art);
    frozen(ctx, art);
    const status = ctx.store.state().gates[m.gate].status;
    assert.strictEqual(status, 'approved', `the frozen engine must have approved ${m.gate} (it is the bypass); it is ${status}`);
    const r = audit.run(ctx.store, ctx.config);
    assert.strictEqual(r.ok, false);
    assert.ok(rules(r).includes(m.rule), `expected ${m.rule}; got ${[...new Set(rules(r))].join(', ')}`);
  });
}

test('B1 a forged seal (no hashes of the approved files) is reported GF-SEAL-1, and the approval without a seal is too', () => {
  const ctx = gfProject();
  frozen(ctx, sample.build());
  assert.ok(rules(audit.run(ctx.store, ctx.config)).includes('GF-SEAL-1'), 'plan approved, no seal');
  ctx.store.commit('gf.g1.sealed', 'orchestrator', { contractsHash: 'a'.repeat(64), hashes: { 'contracts/openapi.json': 'b'.repeat(64) }, planSubmissionId: ctx.store.state().gates.plan.approvedSubmission, estimateSeq: 1 });
  const errs = audit.run(ctx.store, ctx.config).errors.filter((e) => e.rule === 'GF-SEAL-1');
  assert.ok(errs.some((e) => /differ|hash/i.test(e.message)), JSON.stringify(errs));
});

test('B1 forged registrations with the right hashes do not launder invalid content: the rule is still reported from the files', () => {
  const ctx = gfProject();
  const art = sample.build();
  MUTATIONS.find((m) => m.rule === 'GF-PRD-2').apply(art);
  frozen(ctx, art, { upTo: 'architecture' });
  const sub = ctx.store.state().gates.architecture.submissions[0];
  for (const stage of ['prd', 'architecture']) {
    const files = sub.artifacts.filter((a) => a.path.endsWith(stage === 'prd' ? 'prd.json' : 'architecture.json'));
    events.commit(ctx.store, 'gf.artifact.registered', 'product-architect', { stage, gate: 'architecture', submissionId: sub.id, files, validator: { name: stage, version: 1 } });
  }
  const r = audit.run(ctx.store, ctx.config);
  assert.ok(!rules(r).includes('GF-ART-1'), 'the registrations now match the submission');
  assert.ok(rules(r).includes('GF-PRD-2'), 'but the content is still invalid and the audit says so');
});

test('bypass GF-ART-1: every document-gate submission made on the frozen API lacks its registrations, and the audit names each gate and stage', () => {
  const ctx = gfProject();
  frozen(ctx, sample.build());
  const errs = audit.run(ctx.store, ctx.config).errors.filter((e) => e.rule === 'GF-ART-1');
  for (const [gate, stages] of [['architecture', ['prd', 'architecture']], ['design', ['contracts', 'threat']], ['plan', ['breakdown', 'estimates']]]) {
    for (const stage of stages) assert.ok(errs.some((e) => e.message.includes(`of ${gate}`) && e.message.includes(`registered ${stage} artifacts`)), `${gate}/${stage} not reported: ${errs.map((e) => e.message).join(' | ')}`);
  }
});

test('bypass GF-ART-1: a registration whose hashes do not match the submission is reported at the registration', () => {
  const ctx = gfProject();
  frozen(ctx, sample.build(), { upTo: 'architecture' });
  const sub = ctx.store.state().gates.architecture.submissions[0];
  for (const stage of ['prd', 'architecture']) {
    const f = sub.artifacts.find((a) => a.path.endsWith(stage === 'prd' ? 'prd.json' : 'architecture.json'));
    events.commit(ctx.store, 'gf.artifact.registered', 'product-architect', { stage, gate: 'architecture', submissionId: sub.id, files: [{ path: f.path, sha256: 'e'.repeat(64) }], validator: { name: stage, version: 1 } });
  }
  const errs = audit.run(ctx.store, ctx.config).errors.filter((e) => e.rule === 'GF-ART-1');
  assert.ok(errs.some((e) => /does not match submission/.test(e.message) && Number.isInteger(e.seq)), JSON.stringify(errs));
});

test('B2 one byte changed in a contract after the seal is GF-FRZ-2 (and the approved file drifted)', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  assert.strictEqual(audit.run(ctx.store, ctx.config).ok, true);
  fs.appendFileSync(path.join(ctx.dir, 'contracts/openapi.json'), ' ');
  const r = audit.run(ctx.store, ctx.config);
  assert.ok(rules(r).includes('GF-FRZ-2'));
  assert.ok(rules(r).includes('GF-ART-DRIFT'));
  assert.ok(r.errors.some((e) => e.rule === 'GF-FRZ-2' && /openapi\.json/.test(e.message)));
  assert.strictEqual(r.ok, false);
});

test('B3 a forged message whose sender is not the actor\'s group is GF-MSG-1; an amendment request not sent to api is GF-MSG-2', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  ctx.store.commit('gf.message', 'frontend-engineer', { id: 'm1', from: 'backend', to: ['api'], kind: 'question', subject: 'spoofed', body: 'sent as the backend group by the frontend actor' });
  ctx.store.commit('gf.message', 'frontend-engineer', { id: 'm2', from: 'frontend', to: ['backend'], kind: 'amendment-request', subject: 'wrong target', body: 'an amendment request must go to the api group' });
  ctx.store.commit('gf.message', 'frontend-engineer', { id: 'm3', from: 'frontend', to: ['nobody'], kind: 'question', subject: 'unknown group', body: 'there is no such group' });
  const r = audit.run(ctx.store, ctx.config);
  assert.ok(r.errors.some((e) => e.rule === 'GF-MSG-1' && /m1/.test(e.message)));
  assert.ok(r.errors.some((e) => e.rule === 'GF-MSG-2' && /m2/.test(e.message)));
  assert.ok(r.errors.some((e) => e.rule === 'GF-MSG-1' && /m3/.test(e.message)));
});

test('B4 a log with two lines swapped fails the frozen half of the audit', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED, { upTo: 'architecture' });
  const file = path.join(ctx.dir, '.eccode/events.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  [lines[3], lines[4]] = [lines[4], lines[3]];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const r = audit.run(ctx.store, ctx.config);
  assert.strictEqual(r.base.ok, false);
  assert.strictEqual(r.ok, false);
});

test('B5 a phase start and a claim made directly on the frozen functions before the seal are GF-ORD-1', () => {
  const ctx = gfProject();
  frozen(ctx, sample.build());
  gates.startGate(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 's0-contracts', 'integration-engineer');
  const errs = audit.run(ctx.store, ctx.config).errors.filter((e) => e.rule === 'GF-ORD-1');
  assert.ok(errs.some((e) => /gate\.started/.test(e.message)));
  assert.ok(errs.some((e) => /task\.claimed/.test(e.message)));
  assert.ok(errs.every((e) => Number.isInteger(e.seq)), 'each names the event it found');
});

test('B6 unknown and malformed gf events, a second init, a second seal and a second estimate are reported', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  const gf = require('../lib/greenfield/projection').project(ctx.store.readEvents());
  ctx.store.commit('gf.zzz', 'orchestrator', { anything: 1 });
  ctx.store.commit('gf.message', 'orchestrator', { id: 'bad' });
  ctx.store.commit('gf.project.initialized', 'orchestrator', gf.initialized && { stackProfile: 'python-fastapi-sqlalchemy-sqlite', schemaVersion: 1, groups: { api: ['integration-engineer'] } });
  ctx.store.commit('gf.g1.sealed', 'orchestrator', { contractsHash: 'c'.repeat(64), hashes: {}, planSubmissionId: 'x', estimateSeq: 1 });
  ctx.store.commit('gf.estimate.registered', 'orchestrator', { id: 'e2', planSubmissionId: 'x', sha256: 'd'.repeat(64), label: 'agent-estimate-uncalibrated', basis: 'a second registration made after the seal, which is not allowed', groups: {} });
  const r = audit.run(ctx.store, ctx.config);
  const have = new Set(rules(r));
  for (const want of ['GF-AUD-1', 'GF-AUD-2', 'GF-SEAL-1', 'GF-EST-1']) assert.ok(have.has(want), `${want} missing from ${[...have].join(', ')}`);
  assert.ok(r.errors.filter((e) => e.rule === 'GF-AUD-1').length >= 2, 'both the unknown and the malformed event');
});

test('gf events with no gf.project.initialized are GF-AUD-2', () => {
  const plain = tmpProject();
  plain.store.commit('gf.message', 'orchestrator', { id: 'm', from: 'api', to: ['backend'], kind: 'question', subject: 'orphan', body: 'no project init precedes this' });
  assert.ok(rules(audit.run(plain.store, plain.config)).includes('GF-AUD-2'));
});

test('audit is read-only: it changes neither the log nor the files', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  const before = fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'));
  audit.run(ctx.store, ctx.config);
  assert.ok(Buffer.compare(before, fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'))) === 0);
  void GATES;
});
