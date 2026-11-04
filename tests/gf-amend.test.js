'use strict';
// Messages (GF-MSG-1/2), contract amendment (GF-FRZ-2/5), content-addressed snapshots of sealed contracts, and
// estimate revision (GF-EST-1). Negative assertions name the rule id; bypass cases forge events through the
// frozen store and expect `gf audit` to name the rule.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpProject } = require('./helpers');
const sample = require('./fixtures/gf/sample');
const { gfProject, run, WRAPPED } = require('./fixtures/gf/flow');
const messages = require('../lib/greenfield/messages');
const contracts = require('../lib/greenfield/contracts');
const estimate = require('../lib/greenfield/estimate');
const audit = require('../lib/greenfield/audit');
const { project } = require('../lib/greenfield/projection');
const { sha256 } = require('../lib/util');

const OPENAPI = 'contracts/openapi.json';
const gfOf = (ctx) => project(ctx.store.readEvents());
const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
const auditRules = (ctx) => audit.run(ctx.store, ctx.config).errors.map((e) => e.rule);
function refusal(fn) {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected a refusal, but the call succeeded');
}

/** A sealed project. */
function sealed() {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  return ctx;
}

const send = (ctx, actor, over = {}) => messages.send(ctx.store, ctx.config, actor, { to: ['api'], kind: 'question', subject: 'a question', body: 'Does listTasks paginate?', ...over });

/** Edit the live contract as the api group would: add an operation. */
function addOperation(ctx) {
  const file = path.join(ctx.dir, OPENAPI);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.paths['/me'] = { get: { operationId: 'getMe', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } }, 401: { description: 'no', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } } };
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

function request(ctx, over = {}) {
  const msg = send(ctx, 'frontend-engineer', { kind: 'amendment-request', subject: 'need a profile endpoint', body: 'The web client shows the caller; it needs GET /me.' });
  return contracts.requestAmendment(ctx.store, ctx.config, 'frontend-engineer', { contract: OPENAPI, reason: 'the web client needs the caller\'s profile and the contract has none', message: msg.id, proposed: 'add GET /me returning the User', ...over });
}

// ------------------------------------------------------------------ messages

test('messages: a group member sends and lists; the sender is the actor\'s group; replies chain', () => {
  const ctx = sealed();
  const m1 = send(ctx, 'frontend-engineer');
  assert.strictEqual(m1.from, 'frontend');
  const m2 = messages.send(ctx.store, ctx.config, 'integration-engineer', { to: ['frontend'], kind: 'answer', subject: 'a reply', body: 'Yes, with limit and cursor.', inReplyTo: m1.id });
  assert.strictEqual(m2.from, 'api');
  assert.deepStrictEqual(messages.list(ctx.store, { from: 'frontend' }).map((m) => m.id), [m1.id]);
  assert.deepStrictEqual(messages.list(ctx.store, { to: 'frontend' }).map((m) => m.id), [m2.id]);
  assert.deepStrictEqual(messages.list(ctx.store, { kind: 'answer' }).map((m) => m.id), [m2.id]);
  assert.strictEqual(messages.list(ctx.store).length, 2);
  assert.ok(messages.send(ctx.store, ctx.config, 'orchestrator', { to: ['api', 'backend'], kind: 'decision', subject: 'a decision', body: 'Pagination uses a cursor.' }).from === 'orchestrator');
  assert.deepStrictEqual(audit.run(ctx.store, ctx.config).errors, []);
});

const MSG_REFUSALS = [
  ['an actor outside every group (a reviewer)', 'technical-reviewer', {}, 'GF-MSG-1'],
  ['no recipient', 'frontend-engineer', { to: [] }, 'GF-MSG-1'],
  ['an unknown group', 'frontend-engineer', { to: ['nobody'] }, 'GF-MSG-1'],
  ['an unknown kind', 'frontend-engineer', { kind: 'gossip' }, 'GF-MSG-1'],
  ['an empty body', 'frontend-engineer', { body: '' }, 'GF-MSG-1'],
  ['a body over 4096 bytes (multi-byte characters count as bytes)', 'frontend-engineer', { body: 'é'.repeat(2500) }, 'GF-MSG-1'],
  ['a reply to a message that does not exist', 'frontend-engineer', { inReplyTo: 'msg-404' }, 'GF-MSG-1'],
  ['an amendment request not addressed to api', 'frontend-engineer', { kind: 'amendment-request', to: ['backend'] }, 'GF-MSG-2'],
];
for (const [name, actor, over, rule] of MSG_REFUSALS) {
  test(`${rule} refuses ${name}; the log does not change`, () => {
    const ctx = sealed();
    const before = fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'));
    const err = refusal(() => send(ctx, actor, over));
    assert.strictEqual(err.code, 'GF_RULE', `${err.code}: ${err.message}`);
    assert.ok(rulesOf(err).includes(rule), rulesOf(err).join(','));
    assert.ok(Buffer.compare(before, fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'))) === 0);
  });
}

test('messages need a Greenfield-Senior record', () => {
  const plain = tmpProject();
  const err = refusal(() => messages.send(plain.store, plain.config, 'frontend-engineer', { to: ['api'], kind: 'question', subject: 'a question', body: 'hello there' }));
  assert.ok(rulesOf(err).includes('GF-INIT-1'));
});

test('concurrent writers: two processes sending messages at once both land, in order, with the chain intact', async () => {
  const ctx = sealed();
  const script = `
    const { Store } = require(${JSON.stringify(path.join(__dirname, '../lib/store'))});
    const { loadConfig } = require(${JSON.stringify(path.join(__dirname, '../lib/config'))});
    const messages = require(${JSON.stringify(path.join(__dirname, '../lib/greenfield/messages'))});
    const [dir, actor, to] = process.argv.slice(1);
    const store = new Store(dir); const config = loadConfig(dir);
    for (let i = 0; i < 5; i++) messages.send(store, config, actor, { to: [to], kind: 'question', subject: 'burst ' + i, body: 'message ' + i + ' from ' + actor });
  `;
  const child = (actor, to) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script, ctx.dir, actor, to], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  await Promise.all([child('frontend-engineer', 'api'), child('backend-engineer', 'api')]);
  const all = gfOf(ctx).messages;
  assert.strictEqual(all.length, 10);
  assert.strictEqual(new Set(all.map((m) => m.id)).size, 10);
  assert.strictEqual(all.filter((m) => m.from === 'frontend').length, 5);
  assert.deepStrictEqual(ctx.store.audit().errors, []);
});

// ----------------------------------------------------------------- amendment

test('snapshots: sealing writes a content-addressed copy of every sealed contract, named by its hash', () => {
  const ctx = sealed();
  const gf = gfOf(ctx);
  for (const [p, h] of Object.entries(gf.seal.hashes).filter(([p]) => p.startsWith('contracts/'))) {
    const snap = path.join(ctx.dir, '.eccode/contracts', `${h}.json`);
    assert.ok(fs.existsSync(snap), `${p} has no snapshot`);
    assert.strictEqual(sha256(fs.readFileSync(snap)), h);
  }
  assert.deepStrictEqual(audit.run(ctx.store, ctx.config).errors, []);
});

test('amendment, positive: request, edit by the api group, reviewer applies; the chain moves; the sealed original is still what the audit validates', () => {
  const ctx = sealed();
  const sealedHash = gfOf(ctx).seal.hashes[OPENAPI];
  const req = request(ctx);
  addOperation(ctx);
  const am = contracts.applyAmendment(ctx.store, ctx.config, 'technical-reviewer', { request: req.id, reason: 'approved: GET /me is additive and the web client needs it for AC-4' });
  assert.strictEqual(am.fromSha, sealedHash);
  assert.strictEqual(am.toSha, sha256(fs.readFileSync(path.join(ctx.dir, OPENAPI))));
  assert.strictEqual(am.classification, 'additive');
  assert.deepStrictEqual(am.affectedOps, ['getMe']);
  assert.deepStrictEqual(am.invalidates, []);
  assert.deepStrictEqual(contracts.currentHashes(gfOf(ctx))[OPENAPI], am.toSha);
  assert.ok(fs.existsSync(path.join(ctx.dir, '.eccode/contracts', `${am.toSha}.json`)), 'the amended bytes are snapshotted too');
  const r = audit.run(ctx.store, ctx.config);
  assert.deepStrictEqual(r.errors, [], 'the layer finds nothing wrong: the amendment explains the change');
  assert.ok(r.base.unreviewed.some((u) => u.path === OPENAPI), 'the frozen audit says "modified after approval" until a phase review approves the new bytes (its own rule)');
});

test('amendment classification: a removed operation is breaking; a changed one is breaking; the amended bytes must still be a valid OpenAPI', () => {
  const removed = sealed();
  const req = request(removed);
  const file = path.join(removed.dir, OPENAPI);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete doc.paths['/tasks/{taskId}'].delete;
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  const am = contracts.applyAmendment(removed.store, removed.config, 'technical-reviewer', { request: req.id, reason: 'approved: the delete operation is dropped from the product scope' });
  assert.strictEqual(am.classification, 'breaking');
  assert.deepStrictEqual(am.affectedOps, ['deleteTask']);

  const broken = sealed();
  const req2 = request(broken);
  const f2 = path.join(broken.dir, OPENAPI);
  const d2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
  d2.paths['/tasks'].get.operationId = 'createTask'; // duplicate id: no longer a valid OpenAPI
  fs.writeFileSync(f2, `${JSON.stringify(d2, null, 2)}\n`);
  const err = refusal(() => contracts.applyAmendment(broken.store, broken.config, 'technical-reviewer', { request: req2.id, reason: 'approved but the file is invalid and must be refused' }));
  assert.ok(rulesOf(err).includes('GF-CON-1'), rulesOf(err).join(','));
  assert.strictEqual(gfOf(broken).amendments.length, 0);
});

test('amendment on a non-OpenAPI contract is breaking with no operation list (conservative)', () => {
  const ctx = sealed();
  const msg = send(ctx, 'backend-engineer', { kind: 'amendment-request', subject: 'matrix change', body: 'Members may also list admin tasks in read-only mode.' });
  const req = contracts.requestAmendment(ctx.store, ctx.config, 'backend-engineer', { contract: 'contracts/access-matrix.json', reason: 'the product owner wants a read-only admin view for members', message: msg.id, proposed: 'allow member on adminListTasks' });
  const file = path.join(ctx.dir, 'contracts/access-matrix.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.cells.find((c) => c.role === 'member' && c.operationId === 'adminListTasks').expected = 'allow';
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  const am = contracts.applyAmendment(ctx.store, ctx.config, 'security-reviewer', { request: req.id, reason: 'approved by security: read-only visibility for members is intended' });
  assert.strictEqual(am.classification, 'breaking');
  assert.deepStrictEqual(am.affectedOps, []);
});

const AMEND_REFUSALS = [
  ['an amendment before the seal', () => { const c = gfProject(); return { ctx: c, act: () => contracts.requestAmendment(c.store, c.config, 'frontend-engineer', { contract: OPENAPI, reason: 'a request made before G1 is sealed', message: 'x', proposed: 'anything at all' }) }; }, 'GF-FRZ-5'],
  ['a request naming a file that is not a sealed contract', () => { const c = sealed(); const m = send(c, 'frontend-engineer', { kind: 'amendment-request', subject: 'wrong file', body: 'not a contract' }); return { ctx: c, act: () => contracts.requestAmendment(c.store, c.config, 'frontend-engineer', { contract: 'contracts/nope.json', reason: 'this file is not one of the sealed contracts', message: m.id, proposed: 'anything at all' }) }; }, 'GF-FRZ-5'],
  ['a request citing a message that is not an amendment request', () => { const c = sealed(); const m = send(c, 'frontend-engineer'); return { ctx: c, act: () => contracts.requestAmendment(c.store, c.config, 'frontend-engineer', { contract: OPENAPI, reason: 'the cited message is only a question', message: m.id, proposed: 'anything at all' }) }; }, 'GF-MSG-2'],
  ['a request citing another group\'s message', () => { const c = sealed(); const m = send(c, 'backend-engineer', { kind: 'amendment-request', subject: 'backend asks', body: 'from the backend group' }); return { ctx: c, act: () => contracts.requestAmendment(c.store, c.config, 'frontend-engineer', { contract: OPENAPI, reason: 'the cited message belongs to the backend group', message: m.id, proposed: 'anything at all' }) }; }, 'GF-MSG-1'],
  ['a request citing a message that does not exist', () => { const c = sealed(); return { ctx: c, act: () => contracts.requestAmendment(c.store, c.config, 'frontend-engineer', { contract: OPENAPI, reason: 'there is no such message anywhere', message: 'msg-404', proposed: 'anything at all' }) }; }, 'GF-MSG-1'],
  ['an apply by an actor who is not a reviewer', () => { const c = sealed(); const r = request(c); addOperation(c); return { ctx: c, act: () => contracts.applyAmendment(c.store, c.config, 'frontend-engineer', { request: r.id, reason: 'approving my own request is not allowed at all' }) }; }, 'GF-FRZ-5'],
  ['an apply with a reason under 30 characters', () => { const c = sealed(); const r = request(c); addOperation(c); return { ctx: c, act: () => contracts.applyAmendment(c.store, c.config, 'technical-reviewer', { request: r.id, reason: 'ok' }) }; }, 'GF-FRZ-5'],
  ['an apply when the file was not changed', () => { const c = sealed(); const r = request(c); return { ctx: c, act: () => contracts.applyAmendment(c.store, c.config, 'technical-reviewer', { request: r.id, reason: 'approved, but nothing was changed in the file' }) }; }, 'GF-FRZ-5'],
  ['an apply for a request that does not exist', () => { const c = sealed(); return { ctx: c, act: () => contracts.applyAmendment(c.store, c.config, 'technical-reviewer', { request: 'req-404', reason: 'there is no such request to approve' }) }; }, 'GF-FRZ-5'],
  ['a second apply for the same request', () => { const c = sealed(); const r = request(c); addOperation(c); contracts.applyAmendment(c.store, c.config, 'technical-reviewer', { request: r.id, reason: 'approved: additive and needed by the web client' }); return { ctx: c, act: () => contracts.applyAmendment(c.store, c.config, 'technical-reviewer', { request: r.id, reason: 'approved again, which must not be possible' }) }; }, 'GF-FRZ-5'],
  ['a second request on a message already used', () => { const c = sealed(); const r = request(c); return { ctx: c, act: () => contracts.requestAmendment(c.store, c.config, 'frontend-engineer', { contract: OPENAPI, reason: 'reusing the same message for another request', message: r.message, proposed: 'anything at all' }) }; }, 'GF-FRZ-5'],
];
for (const [name, build, rule] of AMEND_REFUSALS) {
  test(`amendment refuses ${name}`, () => {
    const { ctx, act } = build();
    const before = fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'));
    const err = refusal(act);
    assert.strictEqual(err.code, 'GF_RULE', `${err.code}: ${err.message}`);
    assert.ok(rulesOf(err).includes(rule), `expected ${rule}, got ${rulesOf(err).join(',')}`);
    assert.ok(Buffer.compare(before, fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'))) === 0, 'a refusal leaves the log byte-identical');
  });
}

// -------------------------------------------------------------------- bypass

test('bypass: a file edited with no amendment is GF-FRZ-2; a forged amendment whose toSha is not the file\'s bytes is GF-FRZ-2 too', () => {
  const ctx = sealed();
  addOperation(ctx);
  assert.ok(auditRules(ctx).includes('GF-FRZ-2'));
  const gf = gfOf(ctx);
  ctx.store.commit('gf.contract.amended', 'technical-reviewer', { id: 'am-forged', request: 'req-x', contract: OPENAPI, fromSha: gf.seal.hashes[OPENAPI], toSha: 'f'.repeat(64), reason: 'a forged amendment that does not match the bytes on disk', classification: 'additive', affectedOps: [], invalidates: [] });
  const errs = audit.run(ctx.store, ctx.config).errors;
  assert.ok(errs.some((e) => e.rule === 'GF-FRZ-2'));
  assert.ok(errs.some((e) => e.rule === 'GF-FRZ-5' && /request req-x/.test(e.message)), 'the forged amendment cites no recorded request');
});

test('bypass: a forged amendment by a non-reviewer, with a broken chain, before the seal, or twice for one request is GF-FRZ-5', () => {
  const ctx = sealed();
  const req = request(ctx);
  addOperation(ctx);
  const gf = gfOf(ctx);
  const toSha = sha256(fs.readFileSync(path.join(ctx.dir, OPENAPI)));
  const base = { request: req.id, contract: OPENAPI, reason: 'a forged amendment recorded straight through the store', classification: 'additive', affectedOps: ['getMe'], invalidates: [] };
  ctx.store.commit('gf.contract.amended', 'frontend-engineer', { id: 'am-1', ...base, fromSha: gf.seal.hashes[OPENAPI], toSha });
  ctx.store.commit('gf.contract.amended', 'technical-reviewer', { id: 'am-2', ...base, fromSha: 'a'.repeat(64), toSha });
  ctx.store.commit('gf.contract.amended', 'technical-reviewer', { id: 'am-3', ...base, fromSha: gf.seal.hashes[OPENAPI], toSha });
  const msgs = audit.run(ctx.store, ctx.config).errors.filter((e) => e.rule === 'GF-FRZ-5').map((e) => e.message).join(' | ');
  assert.match(msgs, /am-1[^|]*not a reviewer/, 'a non-reviewer applied it');
  assert.match(msgs, /am-2[^|]*chain/, 'its fromSha is not the current hash');
  assert.match(msgs, /am-3[^|]*(already|twice|more than once)/, 'the request was applied before');

  const early = gfProject();
  early.store.commit('gf.contract.amended', 'technical-reviewer', { id: 'am-e', request: 'r', contract: OPENAPI, fromSha: 'a'.repeat(64), toSha: 'b'.repeat(64), reason: 'recorded before G1 was ever sealed in this project', classification: 'additive', affectedOps: [], invalidates: [] });
  assert.ok(audit.run(early.store, early.config).errors.some((e) => e.rule === 'GF-FRZ-5' && /before/.test(e.message)));
});

test('bypass: a deleted or edited snapshot of a sealed contract is GF-FRZ-2', () => {
  const ctx = sealed();
  const h = gfOf(ctx).seal.hashes[OPENAPI];
  const snap = path.join(ctx.dir, '.eccode/contracts', `${h}.json`);
  fs.appendFileSync(snap, ' ');
  assert.ok(audit.run(ctx.store, ctx.config).errors.some((e) => e.rule === 'GF-FRZ-2' && /snapshot/.test(e.message)));
  fs.rmSync(snap);
  assert.ok(audit.run(ctx.store, ctx.config).errors.some((e) => e.rule === 'GF-FRZ-2' && /snapshot/.test(e.message)));
});

test('bypass: a contract edited again after its amendment, with no new amendment, is GF-FRZ-2', () => {
  const ctx = sealed();
  const req = request(ctx);
  addOperation(ctx);
  const am = contracts.applyAmendment(ctx.store, ctx.config, 'technical-reviewer', { request: req.id, reason: 'approved: GET /me is additive and needed' });
  assert.ok(am);
  const file = path.join(ctx.dir, OPENAPI);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete doc.paths['/me'].get.responses[401];
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`); // edited again after the amendment, with no new amendment
  const errs = audit.run(ctx.store, ctx.config).errors;
  assert.ok(errs.some((e) => e.rule === 'GF-FRZ-2'), 'the live bytes are not the amended hash');
});

// ------------------------------------------------------------------ estimates

const REVISED = { backend: { tasks: 5, minutes: { low: 100, high: 300 }, tokens: { low: 800000, high: 2000000 } } };

test('GF-EST-1: a revision is recorded beside the original, never over it', () => {
  const ctx = sealed();
  const original = gfOf(ctx).estimate.original;
  const rev = estimate.revise(ctx.store, ctx.config, 'delivery-lead', { reason: 'the contract grew by one operation and the backend slice with it', groups: REVISED });
  const gf = gfOf(ctx);
  assert.strictEqual(rev.of, original.id);
  assert.strictEqual(gf.estimate.original.id, original.id, 'the original is what is scored');
  assert.deepStrictEqual(gf.estimate.original.groups, original.groups);
  assert.strictEqual(gf.estimate.revisions.length, 1);
  assert.deepStrictEqual(audit.run(ctx.store, ctx.config).errors, []);
});

const EST_REFUSALS = [
  ['before the estimate is registered', () => gfProject(), 'delivery-lead', { reason: 'revising before anything was registered at all', groups: REVISED }],
  ['an actor outside the delivery group and the orchestrator', () => sealed(), 'frontend-engineer', { reason: 'a frontend engineer revising the project estimate', groups: REVISED }],
  ['a reason under 20 characters', () => sealed(), 'delivery-lead', { reason: 'grew', groups: REVISED }],
  ['a malformed group entry', () => sealed(), 'delivery-lead', { reason: 'the shape of the group entry is wrong here', groups: { backend: { tasks: 'five' } } }],
];
for (const [name, build, actor, input] of EST_REFUSALS) {
  test(`GF-EST-1 refuses a revision: ${name}`, () => {
    const ctx = build();
    const err = refusal(() => estimate.revise(ctx.store, ctx.config, actor, input));
    assert.ok(rulesOf(err).includes('GF-EST-1'), `${err.code}: ${err.message}`);
    assert.strictEqual(gfOf(ctx).estimate.revisions.length, 0);
  });
}
