'use strict';
// S4-PREREQ D-2: automated slice approval inside a budget (lib/greenfield/approval.js) and the intervention counter
// (lib/greenfield/interventions.js). Each rule of the approver has its own test; the fixtures are the existing
// closure fixtures (tests/fixtures/gf/close.js), used unchanged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const X = require('./fixtures/gf/close');
const { loadConfig } = require('../lib/config');
const audit = require('../lib/greenfield/audit');
const rejections = require('../lib/greenfield/rejections');
const approval = require('../lib/greenfield/approval');
const interventions = require('../lib/greenfield/interventions');

const BIN = path.join(__dirname, '..', 'bin', 'eccode-gf.js');
const COUNT_TOOL = path.join(__dirname, '..', 'tools', 'count-interventions.js');
const POLICY = { enabled: true, maxSlices: 3, maxTokens: 100000, maxWallClockMinutes: 600 };
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);

function setConfig(ctx, mutate) {
  const file = path.join(ctx.dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(cfg);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  ctx.config = loadConfig(ctx.dir);
}
const enable = (ctx, over = {}) => setConfig(ctx, (cfg) => { cfg.gf.approval = { auto: { ...POLICY, ...over } }; });
const autoEvents = (ctx) => ctx.store.readEvents().filter((e) => e.type === 'auto-approval');

/** A sealed project with slice `scope` validly closed on a clean tree. */
function closedSlice({ scope = 'S2', accounting } = {}) {
  const ctx = X.closeProject();
  X.validClosure(ctx, scope);
  X.closeIt(ctx, { scope, ...(accounting ? { accounting } : {}) });
  return ctx;
}
function refused(ctx, scope, rule, opts) {
  let err;
  try { approval.autoApprove(ctx.store, ctx.config, scope, opts); } catch (e) { err = e; }
  assert.ok(err, `expected ${rule}, but the slice was approved`);
  assert.ok(rulesOf(err).includes(rule), `expected ${rule}, got ${JSON.stringify(rulesOf(err))}: ${err.message}`);
  assert.strictEqual(err.details.humanNeeded, true);
  return err;
}

// ------------------------------------------------------------------ off by default
test('D-2 off by default: initProject writes no gf.approval, and the approver approves nothing (GF-AUTO-0)', () => {
  const ctx = closedSlice();
  assert.strictEqual(ctx.config.gf.approval, undefined);
  const ev = approval.evaluate(ctx.store, ctx.config, 'S2');
  assert.strictEqual(ev.ok, false);
  assert.ok(ev.problems.some((p) => p.rule === 'GF-AUTO-0'));
  refused(ctx, 'S2', 'GF-AUTO-0');
  assert.strictEqual(autoEvents(ctx).length, 0);
});

test('D-2 off by default: a policy with enabled false, or a bound that is not a positive integer, approves nothing', () => {
  const ctx = closedSlice();
  enable(ctx, { enabled: false });
  refused(ctx, 'S2', 'GF-AUTO-0');
  enable(ctx, { maxSlices: 0 });
  refused(ctx, 'S2', 'GF-AUTO-0');
  enable(ctx, { maxTokens: '100' });
  refused(ctx, 'S2', 'GF-AUTO-0');
  setConfig(ctx, (cfg) => { cfg.gf.approval = { auto: { enabled: true, maxSlices: 2 } }; });
  refused(ctx, 'S2', 'GF-AUTO-0');
  assert.strictEqual(autoEvents(ctx).length, 0);
});

// ------------------------------------------------------------------ approves only when every precondition holds
test('D-2 positive: every precondition holds, the slice is approved as one hash-chained auto-approval event', () => {
  const ctx = closedSlice();
  enable(ctx);
  const r = approval.autoApprove(ctx.store, ctx.config, 'S2');
  assert.strictEqual(r.event.type, 'auto-approval');
  assert.strictEqual(r.event.actor, 'auto-approver');
  const d = r.event.data;
  assert.strictEqual(d.scope, 'S2');
  assert.strictEqual(d.treeHash, X.tree(ctx));
  assert.strictEqual(d.budget.slicesUsed, 1);
  assert.strictEqual(d.budget.tokensUsed, 1500);
  assert.match(d.policyHash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(d.policy, POLICY);
  // the same hash chain as every other event; the frozen and GF audits stay clean; the approval audit agrees
  assert.deepStrictEqual(ctx.store.audit().errors, []);
  assert.strictEqual(audit.run(ctx.store, ctx.config).ok, true);
  assert.deepStrictEqual(approval.audit(ctx.store, ctx.config), []);
  assert.strictEqual(autoEvents(ctx).length, 1);
});

test('D-2 GF-AUTO-1: a slice that is not closed is not approved, and the reason is recorded in the rejection log', () => {
  const ctx = X.closeProject();
  enable(ctx);
  refused(ctx, 'S2', 'GF-AUTO-1');
  const log = fs.readFileSync(rejections.fileOf(ctx.store.root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.action === 'auto-approve' && e.rule === 'GF-AUTO-1'));
  assert.deepStrictEqual(rejections.verify(ctx.store.root).errors, []);
});

test('D-2 GF-AUTO-1: a slice is approved once; a second approval of the same scope is refused', () => {
  const ctx = closedSlice();
  enable(ctx);
  approval.autoApprove(ctx.store, ctx.config, 'S2');
  refused(ctx, 'S2', 'GF-AUTO-1');
  assert.strictEqual(autoEvents(ctx).length, 1);
});

test('D-2 GF-AUTO-1: a record whose GF audit is not clean is not approved (gates green)', () => {
  const ctx = closedSlice();
  enable(ctx);
  // a forged review (no dispatch, not a reviewer) makes the audit fail
  X.F(ctx, 'gf.review.recorded', 'backend-engineer', { id: 'rev-forged', scope: 'S2', step: 'critique', dispatch: 'nope', treeHash: X.tree(ctx), summary: X.LONG, verdict: 'clean', findings: [] });
  assert.strictEqual(audit.run(ctx.store, ctx.config).ok, false);
  refused(ctx, 'S2', 'GF-AUTO-1');
});

// ------------------------------------------------------------------ budget: hard stop
test('D-2 GF-AUTO-2: the slice budget is a hard stop (maxSlices reached: the next slice needs a human)', () => {
  const ctx = closedSlice();
  enable(ctx, { maxSlices: 1 });
  approval.autoApprove(ctx.store, ctx.config, 'S2');
  X.validClosure(ctx, 'S3');
  X.closeIt(ctx, { scope: 'S3' });
  for (let i = 0; i < 3; i++) refused(ctx, 'S3', 'GF-AUTO-2');
  assert.strictEqual(autoEvents(ctx).length, 1);
});

test('D-2 GF-AUTO-2: the token budget counts every closure; an unmeasurable closure refuses (the budget cannot be verified)', () => {
  const over = closedSlice();
  enable(over, { maxTokens: 1000 }); // the closure spent 1500
  refused(over, 'S2', 'GF-AUTO-2');
  const blind = closedSlice({ accounting: { unit: 'all-processed-tokens', start: 'unmeasurable', end: 'unmeasurable' } });
  enable(blind);
  refused(blind, 'S2', 'GF-AUTO-2');
});

test('D-2 GF-AUTO-2: the wall-clock budget runs from gf.project.initialized', () => {
  const ctx = closedSlice();
  enable(ctx, { maxWallClockMinutes: 5 });
  const init = ctx.store.readEvents().find((e) => e.type === 'gf.project.initialized');
  refused(ctx, 'S2', 'GF-AUTO-2', { now: Date.parse(init.ts) + 6 * 60 * 1000 });
  const ok = approval.autoApprove(ctx.store, ctx.config, 'S2', { now: Date.parse(init.ts) + 4 * 60 * 1000 });
  assert.strictEqual(ok.event.type, 'auto-approval');
});

// ------------------------------------------------------------------ sealed contracts and hidden-suite paths
test('D-2 GF-AUTO-3: a closing tree whose contract file differs from its sealed hash is never approved', () => {
  const ctx = X.closeProject();
  const rel = 'contracts/openapi.json';
  const doc = JSON.parse(fs.readFileSync(path.join(ctx.dir, rel), 'utf8'));
  doc.info = { ...(doc.info || {}), description: 'changed after the seal' };
  X.put(ctx, rel, JSON.stringify(doc, null, 2));
  X.commitAll(ctx, 'touch a sealed contract');
  X.validClosure(ctx);
  X.closeIt(ctx);
  enable(ctx);
  refused(ctx, 'S2', 'GF-AUTO-3');
});

test('D-2 GF-AUTO-3: a contract amendment since the last approval needs a human', () => {
  const ctx = closedSlice();
  enable(ctx);
  X.F(ctx, 'gf.contract.amendment.requested', 'integration-engineer', { id: 'amr-1', contract: 'contracts/openapi.json', reason: 'a field the slice needs is missing', message: 'msg-1', proposed: 'add the field to the schema' });
  refused(ctx, 'S2', 'GF-AUTO-3');
});

test('D-2 GF-AUTO-3: a hidden-suite path inside the closing tree is never approved', () => {
  const ctx = X.closeProject();
  X.put(ctx, 'acceptance-hidden/test_x.py', 'def test_x():\n    assert True\n');
  X.commitAll(ctx, 'a hidden-suite file in the tree');
  X.validClosure(ctx);
  X.closeIt(ctx);
  enable(ctx);
  setConfig(ctx, (cfg) => { cfg.gf.hiddenSuite = { path: 'acceptance-hidden' }; });
  refused(ctx, 'S2', 'GF-AUTO-3');
});

// ------------------------------------------------------------------ the rejection log
test('D-2 GF-AUTO-4: a new denial in the rejection log since the last approval stops the approver; its own refusals do not', () => {
  const ctx = closedSlice();
  // the approver's own refusal (disabled) is logged, and does not block a later approval
  refused(ctx, 'S2', 'GF-AUTO-0');
  enable(ctx);
  rejections.record(ctx.store.root, { actor: 'backend-engineer', action: 'Read', rule: 'GF-HID-1', reason: 'read of the hidden suite denied' });
  refused(ctx, 'S2', 'GF-AUTO-4');
  // a human intervention acknowledges what came before it; the approver may then go on
  interventions.record(ctx.store, 'user', { type: 'unblock', note: 'operator reviewed the denial and resumed' });
  const ok = approval.autoApprove(ctx.store, ctx.config, 'S2');
  assert.strictEqual(ok.event.type, 'auto-approval');
});

test('D-2 GF-AUTO-4: a rejection log whose hash chain is broken stops the approver', () => {
  const ctx = closedSlice();
  enable(ctx);
  rejections.record(ctx.store.root, { actor: 'backend-engineer', action: 'Read', rule: 'GF-HID-1', reason: 'read of the hidden suite denied' });
  interventions.record(ctx.store, 'user', { type: 'unblock', note: 'operator reviewed the denial and resumed' });
  const file = rejections.fileOf(ctx.store.root);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('read of the hidden suite denied', 'nothing happened here'));
  refused(ctx, 'S2', 'GF-AUTO-4');
});

// ------------------------------------------------------------------ audit replay of the approvals
test('D-2 GF-AUTO-5: the approval audit reports a forged over-budget auto-approval and a wrong actor', () => {
  const ctx = closedSlice();
  enable(ctx, { maxSlices: 1 });
  const first = approval.autoApprove(ctx.store, ctx.config, 'S2').event.data;
  assert.deepStrictEqual(approval.audit(ctx.store, ctx.config), []);
  X.validClosure(ctx, 'S3');
  X.closeIt(ctx, { scope: 'S3' });
  const forged = { ...first, id: 'aa-forged', scope: 'S3', closureSeq: ctx.store.readEvents().filter((e) => e.type === 'gf.slice.closed').pop().seq, budget: { ...first.budget, slicesUsed: 2 } };
  ctx.store.commit('auto-approval', 'auto-approver', forged);
  ctx.store.commit('auto-approval', 'orchestrator', { ...forged, id: 'aa-forged-2' });
  const problems = approval.audit(ctx.store, ctx.config);
  assert.ok(problems.some((p) => p.rule === 'GF-AUTO-5' && /maxSlices|budget/.test(p.message)), JSON.stringify(problems));
  assert.ok(problems.some((p) => p.rule === 'GF-AUTO-5' && /actor/.test(p.message)), JSON.stringify(problems));
});

test('D-2 GF-AUTO-5: an auto-approval whose policyHash does not match its policy, or with no prior closure, is reported', () => {
  const ctx = closedSlice();
  enable(ctx);
  const d = approval.autoApprove(ctx.store, ctx.config, 'S2').event.data;
  ctx.store.commit('auto-approval', 'auto-approver', { ...d, id: 'aa-x', scope: 'S9', policyHash: 'f'.repeat(64) });
  const problems = approval.audit(ctx.store, ctx.config).map((p) => p.message).join('\n');
  assert.match(problems, /policyHash/);
  assert.match(problems, /S9/);
});

// ------------------------------------------------------------------ interventions: the record and the counter
test('D-2 intervention record: only the user records one, with a type from the closed taxonomy', () => {
  const ctx = X.closeProject();
  assert.throws(() => interventions.record(ctx.store, 'orchestrator', { type: 'approval', note: 'x' }), /user/);
  assert.throws(() => interventions.record(ctx.store, 'user', { type: 'nudge', note: 'x' }), /type/);
  const r = interventions.record(ctx.store, 'user', { type: 'restart', note: 'process crashed, restarted once' });
  assert.strictEqual(r.event.type, 'intervention');
  assert.strictEqual(r.event.data.type, 'restart');
  assert.strictEqual(typeof r.event.data.rejectionsSeq, 'number');
});

test('D-2 counter: a synthetic record gives exactly the known counts by type, auto-approvals apart', () => {
  let seq = 0;
  const ev = (type, actor, data = {}) => ({ seq: ++seq, ts: '2026-11-09T00:00:00Z', type, actor, data });
  const log = [
    ev('gf.project.initialized', 'orchestrator'),
    ev('intervention', 'user', { type: 'approval', note: 'n' }),
    ev('intervention', 'user', { type: 'approval', note: 'n' }),
    ev('intervention', 'user', { type: 'restart', note: 'n' }),
    ev('intervention', 'user', { type: 'correction', note: 'n' }),
    ev('intervention', 'user', { type: 'unblock', note: 'n' }),
    ev('request.clarified', 'user', { question: 'Q-1' }), // seq 7: clarification-answer, not referenced
    ev('gate.reopened', 'user', {}), // seq 8: referenced by the next intervention, counted once
    ev('intervention', 'user', { type: 'approval', note: 'reopened the plan gate', refSeq: 8 }),
    ev('auto-approval', 'auto-approver', { scope: 'S0' }),
    ev('auto-approval', 'auto-approver', { scope: 'S1' }),
    ev('auto-approval', 'auto-approver', { scope: 'S2' }),
    ev('gf.slice.closed', 'orchestrator', { scope: 'S2' }),
    ev('task.claimed', 'backend-engineer', {}),
  ];
  const c = interventions.count(log);
  assert.deepStrictEqual(c.counted, { approval: 3, 'clarification-answer': 1, correction: 1, restart: 1, unblock: 1 });
  assert.strictEqual(c.total, 7);
  assert.strictEqual(c.autoApprovals, 3);
});

// ------------------------------------------------------------------ the CLI and the standalone counter
function gfCli(dir, args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--root', dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('D-2 CLI: eccode-gf approve exits 2 with GF-AUTO-0 by default, 0 with a policy; interventions count reads the record', () => {
  const ctx = closedSlice();
  const off = gfCli(ctx.dir, ['approve', '--scope', 'S2']);
  assert.strictEqual(off.code, 2, off.out + off.err);
  assert.match(off.err, /GF-AUTO-0/);
  enable(ctx);
  const on = gfCli(ctx.dir, ['approve', '--scope', 'S2', '--json']);
  assert.strictEqual(on.code, 0, on.out + on.err);
  assert.strictEqual(JSON.parse(on.out).event.type, 'auto-approval');
  const c = gfCli(ctx.dir, ['interventions', 'count', '--json']);
  assert.strictEqual(c.code, 0, c.err);
  assert.strictEqual(JSON.parse(c.out).autoApprovals, 1);
  assert.strictEqual(JSON.parse(c.out).total, 0);
});

test('D-2 tools/count-interventions.js: counts from an events.jsonl alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-count-'));
  const file = path.join(dir, 'events.jsonl');
  const lines = [
    { seq: 1, type: 'intervention', actor: 'user', data: { type: 'unblock', note: 'n' } },
    { seq: 2, type: 'auto-approval', actor: 'auto-approver', data: { scope: 'S0' } },
    { seq: 3, type: 'request.clarified', actor: 'user', data: {} },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [COUNT_TOOL, file], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.total, 2);
  assert.strictEqual(out.counted.unblock, 1);
  assert.strictEqual(out.counted['clarification-answer'], 1);
  assert.strictEqual(out.autoApprovals, 1);
});
