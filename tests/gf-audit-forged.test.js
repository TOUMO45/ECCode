'use strict';
// Forged events committed straight through the frozen store: every audit invariant that the independent review
// found could be removed without failing a test. Each case forges ONE thing and expects the named rule, with a
// message that says what is wrong. Expectations are on rule ids and message content, so removing the check fails.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sample = require('./fixtures/gf/sample');
const { gfProject, run, WRAPPED, FROZEN } = require('./fixtures/gf/flow');
const { tmpProject } = require('./helpers');
const audit = require('../lib/greenfield/audit');
const bundle = require('../lib/greenfield/bundle');
const snapshots = require('../lib/greenfield/snapshots');
const messages = require('../lib/greenfield/messages');
const contracts = require('../lib/greenfield/contracts');
const events = require('../lib/greenfield/events');
const { project } = require('../lib/greenfield/projection');
const { sha256 } = require('../lib/util');
const { trueEstimate, forgeSeal } = require('./fixtures/gf/forge');

const OPENAPI = 'contracts/openapi.json';
const SHA = (c) => c.repeat(64);
const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);
const errs = (ctx) => audit.run(ctx.store, ctx.config).errors;
const sealed = () => { const ctx = gfProject(); run(ctx, sample.build(), WRAPPED); return ctx; };
const frozen = () => { const ctx = gfProject(); run(ctx, sample.build(), FROZEN); return ctx; };
function refusal(fn) { try { fn(); } catch (e) { return e; } throw new Error('expected a refusal, but the call succeeded'); }
function expect(ctx, rule, re) {
  const found = errs(ctx);
  assert.ok(found.some((e) => e.rule === rule && re.test(e.message)), `expected ${rule} /${re.source}/; got ${JSON.stringify(found.map((e) => `${e.rule}: ${e.message.slice(0, 90)}`))}`);
}

// ---- the estimate and the seal
test('a registered estimate that is not the approved plan\'s estimates.json is GF-EST-1 (submission, hash and numbers)', () => {
  const ctx = frozen();
  forgeSeal(ctx, {}, { planSubmissionId: 'sub_nonexistent', sha256: SHA('a'), groups: { backend: { tasks: 1, minutes: { low: 1, high: 2 }, tokens: { low: 1, high: 2 } } } });
  expect(ctx, 'GF-EST-1', /planSubmissionId/);
  expect(ctx, 'GF-EST-1', /sha256|estimates\.json/);
  expect(ctx, 'GF-EST-1', /groups/);
});
test('a forged seal and estimate that match the approved files audit clean (the forgery is exactly the legitimate record)', () => {
  const ctx = frozen();
  forgeSeal(ctx);
  const own = errs(ctx).filter((e) => ['GF-SEAL-1', 'GF-EST-1', 'GF-ORD-1'].includes(e.rule));
  assert.deepStrictEqual(own, [], 'a correct seal and estimate record is correct however it was committed (the missing registrations are GF-ART-1, a different rule)');
});
test('a seal with the wrong contractsHash is GF-SEAL-1', () => { const ctx = frozen(); forgeSeal(ctx, { contractsHash: SHA('c') }); expect(ctx, 'GF-SEAL-1', /contractsHash/); });
test('a seal naming the wrong plan submission is GF-SEAL-1', () => { const ctx = frozen(); forgeSeal(ctx, { planSubmissionId: 'sub-other' }); expect(ctx, 'GF-SEAL-1', /names plan submission/); });
test('a seal citing an estimate that is not the registered one is GF-SEAL-1', () => { const ctx = frozen(); forgeSeal(ctx, { estimateSeq: 1 }); expect(ctx, 'GF-SEAL-1', /does not cite the registered estimate/); });
test('a seal while the plan gate is not approved is GF-SEAL-1', () => {
  const ctx = gfProject();
  F(ctx, 'gf.g1.sealed', 'gf-engine', { contractsHash: SHA('a'), hashes: {}, planSubmissionId: 'x', estimateSeq: 1 });
  expect(ctx, 'GF-SEAL-1', /plan gate is not approved/);
});
test('an estimate revision with no registered estimate is GF-EST-1', () => {
  const ctx = gfProject();
  F(ctx, 'gf.estimate.revised', 'delivery-lead', { id: 'r1', of: 'est-x', reason: 'a revision with nothing to revise', groups: {} });
  expect(ctx, 'GF-EST-1', /without a registered estimate/);
});
test('an estimate revision by a non-reviser or of the wrong original is GF-EST-1', () => {
  const ctx = sealed();
  F(ctx, 'gf.estimate.revised', 'frontend-engineer', { id: 'r2', of: 'est-bogus', reason: 'a frontend engineer revising an unknown estimate', groups: {} });
  expect(ctx, 'GF-EST-1', /may not revise|not a reviser/);
  expect(ctx, 'GF-EST-1', /revises est-bogus|not the registered/);
});
test('gf.project.initialized that is not the first gf event is GF-AUD-2', () => {
  const plain = tmpProject();
  F(plain, 'gf.message', 'orchestrator', { id: 'm', from: 'orchestrator', to: ['api'], kind: 'question', subject: 'before init', body: 'sent before the project was initialised' });
  F(plain, 'gf.project.initialized', 'orchestrator', { stackProfile: 'python-fastapi-sqlalchemy-sqlite', schemaVersion: 1, groups: { api: ['integration-engineer'] } });
  expect(plain, 'GF-AUD-2', /not the first gf event/);
});

// ---- messages
test('a message body of 8192 bytes (4096 characters) is malformed, however the schema counts it', () => {
  assert.ok(events.validate('gf.message', { id: 'm', from: 'api', to: ['backend'], kind: 'question', subject: 'too big', body: 'é'.repeat(4096) }).some((e) => /bytes/.test(e)));
  const ctx = sealed();
  F(ctx, 'gf.message', 'integration-engineer', { id: 'big', from: 'api', to: ['backend'], kind: 'question', subject: 'too big', body: 'é'.repeat(4096) });
  expect(ctx, 'GF-AUD-1', /malformed.*bytes/);
});
test('a message replying to a message that does not exist is GF-MSG-1', () => {
  const ctx = sealed();
  F(ctx, 'gf.message', 'integration-engineer', { id: 'reply', from: 'api', to: ['backend'], kind: 'answer', subject: 'a reply', body: 'to nothing', inReplyTo: 'msg-404' });
  expect(ctx, 'GF-MSG-1', /inReplyTo msg-404/);
});

// ---- requests and amendments
function request(ctx, over = {}) {
  const m = messages.send(ctx.store, ctx.config, 'frontend-engineer', { to: ['api'], kind: 'amendment-request', subject: 'need a change', body: 'the web client needs a change to the contract' });
  return contracts.requestAmendment(ctx.store, ctx.config, 'frontend-engineer', { contract: OPENAPI, reason: 'the web client needs a change the contract lacks', message: m.id, proposed: 'add or remove an operation', ...over });
}
const editOpenApi = (ctx, fn) => { const f = path.join(ctx.dir, OPENAPI); const d = JSON.parse(fs.readFileSync(f, 'utf8')); fn(d); fs.writeFileSync(f, `${JSON.stringify(d, null, 2)}\n`); snapshots.write(ctx.dir, OPENAPI); return sha256(fs.readFileSync(f)); };
const sealHash = (ctx) => project(ctx.store.readEvents()).seal.hashes[OPENAPI];
const amended = (ctx, req, over) => F(ctx, 'gf.contract.amended', 'technical-reviewer', { id: 'am-f', request: req.id, contract: OPENAPI, fromSha: sealHash(ctx), toSha: SHA('d'), reason: 'a recorded amendment used by the forged-event tests', classification: 'breaking', affectedOps: [], invalidates: [], ...over });

test('an amendment whose classification or affected operations are not what the diff says is GF-FRZ-5', () => {
  const ctx = sealed();
  const req = request(ctx);
  const toSha = editOpenApi(ctx, (d) => { delete d.paths['/tasks/{taskId}'].delete; });
  amended(ctx, req, { toSha, classification: 'additive', affectedOps: [] });
  expect(ctx, 'GF-FRZ-5', /classified additive|classification/);
  expect(ctx, 'GF-FRZ-5', /deleteTask/);
});
test('an honest amendment is recomputed and audits clean', () => {
  const ctx = sealed();
  const req = request(ctx);
  const toSha = editOpenApi(ctx, (d) => { delete d.paths['/tasks/{taskId}'].delete; });
  amended(ctx, req, { toSha, classification: 'breaking', affectedOps: ['deleteTask'] });
  assert.deepStrictEqual(errs(ctx), []);
});
test('two requests citing one message is GF-FRZ-5', () => {
  const ctx = sealed();
  const req = request(ctx);
  F(ctx, 'gf.contract.amendment.requested', 'frontend-engineer', { id: 'req-dup', contract: OPENAPI, reason: 'a second request on the same message', message: req.message, proposed: 'anything at all' });
  expect(ctx, 'GF-FRZ-5', /message .* (more than one|already carries)|cited by/);
});
test('a contract file that appeared after the seal and is not in it is GF-FRZ-2', () => {
  const ctx = sealed();
  fs.writeFileSync(path.join(ctx.dir, 'contracts/events.json'), '{"events":[]}\n');
  expect(ctx, 'GF-FRZ-2', /events\.json.*not (in the seal|sealed)/);
});
test('a request recorded before the seal is GF-FRZ-5', () => {
  const ctx = gfProject();
  F(ctx, 'gf.message', 'frontend-engineer', { id: 'm1', from: 'frontend', to: ['api'], kind: 'amendment-request', subject: 'early', body: 'asked before G1 was sealed' });
  F(ctx, 'gf.contract.amendment.requested', 'frontend-engineer', { id: 'r1', contract: OPENAPI, reason: 'asked before G1 was ever sealed', message: 'm1', proposed: 'anything at all' });
  expect(ctx, 'GF-FRZ-5', /before G1 was sealed/);
});
test('an amendment for another file than its request asked for is GF-FRZ-5', () => {
  const ctx = sealed();
  const req = request(ctx);
  amended(ctx, req, { contract: 'contracts/fixtures.json', fromSha: project(ctx.store.readEvents()).seal.hashes['contracts/fixtures.json'] });
  expect(ctx, 'GF-FRZ-5', /asked for contracts\/openapi\.json/);
});
test('an amendment that records no change is GF-FRZ-5', () => { const ctx = sealed(); const req = request(ctx); amended(ctx, req, { toSha: sealHash(ctx) }); expect(ctx, 'GF-FRZ-5', /records no change/); });
test('a request citing a message that is not an amendment request is GF-MSG-2', () => {
  const ctx = sealed();
  const m = messages.send(ctx.store, ctx.config, 'frontend-engineer', { to: ['api'], kind: 'question', subject: 'only a question', body: 'a question, not a request' });
  F(ctx, 'gf.contract.amendment.requested', 'frontend-engineer', { id: 'r-q', contract: OPENAPI, reason: 'citing a plain question as a request', message: m.id, proposed: 'anything at all' });
  expect(ctx, 'GF-MSG-2', /not a recorded amendment-request/);
});
test('a request recorded by an actor outside the message\'s group is GF-MSG-1', () => {
  const ctx = sealed();
  const m = messages.send(ctx.store, ctx.config, 'frontend-engineer', { to: ['api'], kind: 'amendment-request', subject: 'frontend asks', body: 'from the frontend group' });
  F(ctx, 'gf.contract.amendment.requested', 'backend-engineer', { id: 'r-b', contract: OPENAPI, reason: 'recorded by someone from another group', message: m.id, proposed: 'anything at all' });
  expect(ctx, 'GF-MSG-1', /cites a message from the frontend group/);
});
test('a request naming a file that is not a sealed contract is GF-FRZ-5', () => {
  const ctx = sealed();
  const m = messages.send(ctx.store, ctx.config, 'frontend-engineer', { to: ['api'], kind: 'amendment-request', subject: 'wrong file', body: 'asks about an unsealed file' });
  F(ctx, 'gf.contract.amendment.requested', 'frontend-engineer', { id: 'r-u', contract: 'contracts/events.json', reason: 'naming a file the seal does not hold', message: m.id, proposed: 'anything at all' });
  expect(ctx, 'GF-FRZ-5', /not a sealed contract/);
});
test('an amended contract that no longer validates but whose recorded hash matches is GF-FRZ-5 (not only a drift report)', () => {
  const ctx = sealed();
  const req = request(ctx);
  const toSha = editOpenApi(ctx, (d) => { d.paths['/tasks'].get.operationId = 'createTask'; }); // duplicate operationId
  amended(ctx, req, { toSha, classification: 'breaking', affectedOps: ['createTask', 'listTasks'] });
  const found = errs(ctx);
  assert.ok(!found.some((e) => e.rule === 'GF-FRZ-2'), 'the bytes match the recorded hash, so it is not drift');
  expect(ctx, 'GF-FRZ-5', /no longer validates/);
});

// ---- the in-lock checks of applyAmendment (the world changes while it is recorded)
function interpose(fn, body) {
  const real = snapshots.write;
  snapshots.write = (...a) => { const r = real(...a); fn(); return r; };
  try { return body(); } finally { snapshots.write = real; }
}
test('applyAmendment re-checks inside the lock: the request applied meanwhile, the chain moved meanwhile, the file changed meanwhile', () => {
  const addOp = (d, id) => { d.paths[`/${id}`] = { get: { operationId: id, responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } }, 401: { description: 'no', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } } }; };
  // 1. changed meanwhile
  const a = sealed();
  const ra = request(a);
  editOpenApi(a, (d) => addOp(d, 'one'));
  const e1 = interpose(() => fs.appendFileSync(path.join(a.dir, OPENAPI), ' '), () => refusal(() => contracts.applyAmendment(a.store, a.config, 'technical-reviewer', { request: ra.id, reason: 'approved while the file is changing underneath' })));
  assert.ok((e1.details.problems || []).some((p) => p.rule === 'GF-FRZ-5' && /changed while the amendment was being recorded/.test(p.message)), e1.message);
  // 2. applied meanwhile (the same request recorded by someone else between the check and the commit)
  const b = sealed();
  const rb = request(b);
  const toB = editOpenApi(b, (d) => addOp(d, 'two'));
  const e2 = interpose(() => F(b, 'gf.contract.amended', 'technical-reviewer', { id: 'am-race', request: rb.id, contract: OPENAPI, fromSha: sealHash(b), toSha: toB, reason: 'recorded by another reviewer in the meantime', classification: 'additive', affectedOps: ['two'], invalidates: [] }), () => refusal(() => contracts.applyAmendment(b.store, b.config, 'technical-reviewer', { request: rb.id, reason: 'approved at the same moment as another reviewer' })));
  assert.ok((e2.details.problems || []).some((p) => /applied meanwhile/.test(p.message)), e2.message);
  // 3. chain moved meanwhile (a different request amended the same file in between)
  const c = sealed();
  const rc1 = request(c);
  const rc2 = request(c);
  const toC = editOpenApi(c, (d) => addOp(d, 'three'));
  const e3 = interpose(() => F(c, 'gf.contract.amended', 'technical-reviewer', { id: 'am-other', request: rc2.id, contract: OPENAPI, fromSha: sealHash(c), toSha: SHA('9'), reason: 'another request moved the same contract first', classification: 'breaking', affectedOps: [], invalidates: [] }), () => refusal(() => contracts.applyAmendment(c.store, c.config, 'technical-reviewer', { request: rc1.id, reason: 'approved against a hash that has moved' })));
  assert.ok((e3.details.problems || []).some((p) => /amended meanwhile/.test(p.message)), e3.message);
});

// ---- bundle and openapi gaps from the review
test('validating a gate whose predecessor is not approved is GF-ORD-1', () => {
  const art = sample.build();
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eccode-gf-ord-'));
  const written = sample.write(dir, art);
  const base = sample.fakeBase(art); // no approved gates
  const r = bundle.validateGate(dir, 'design', written.design, base, require('../lib/config').DEFAULT_CONFIG);
  assert.ok(r.problems.some((p) => p.rule === 'GF-ORD-1' && /architecture gate is not approved/.test(p.message)));
});
