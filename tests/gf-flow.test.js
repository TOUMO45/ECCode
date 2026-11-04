'use strict';
// Init, the wrapped gate and claim operations, and the seal (GF-INIT-1, GF-ART-1, GF-EST-1, GF-SEAL-1, and every
// stage rule at the point of submission). Positive: the sample goes through and seals. Negative: each mutation is
// refused at its gate with its rule id and NOTHING is committed for the refused submission. Non-GF projects
// behave exactly as before.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { tmpProject, approval } = require('./helpers');
const sample = require('./fixtures/gf/sample');
const { MUTATIONS } = require('./fixtures/gf/mutations');
const { gfProject, run, WRAPPED, FROZEN, ev } = require('./fixtures/gf/flow');
const wrap = require('../lib/greenfield/wrap');
const { initProject } = require('../lib/greenfield/init');
const { project } = require('../lib/greenfield/projection');
const { NEW_ROLES } = require('../lib/greenfield/constants');

const gfOf = (ctx) => project(ctx.store.readEvents());
const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refusal(fn) {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected a refusal, but the call succeeded');
}

test('GF-INIT-1: init writes the GF event and the config; a second init, an existing project and an unsupported stack are refused', () => {
  const ctx = gfProject();
  const gf = gfOf(ctx);
  assert.strictEqual(gf.initialized.stackProfile, 'python-fastapi-sqlalchemy-sqlite');
  assert.strictEqual(wrap.isEnabled(ctx.store), true);
  const cfg = JSON.parse(fs.readFileSync(path.join(ctx.dir, '.eccode/config.json'), 'utf8'));
  for (const r of NEW_ROLES) assert.ok(cfg.roles.phase.authors.includes(r), `${r} may author phase work`);
  assert.ok(cfg.roles.design.reviewers.includes('security-reviewer'));
  assert.ok(cfg.roles.design.reviewers.includes('technical-reviewer'));
  assert.ok(cfg.limits.maxConcurrency >= 4);
  assert.deepStrictEqual(cfg.gf, { enabled: true, schemaVersion: 1, stackProfile: 'python-fastapi-sqlalchemy-sqlite' });
  assert.strictEqual(ctx.store.state().work.track, 'greenfield');
  assert.deepStrictEqual(ctx.store.audit().errors, []);

  const again = refusal(() => initProject(ctx.dir, { name: 'x', idea: 'a second attempt at the same project' }));
  assert.strictEqual(again.code, 'GF_RULE');
  assert.ok(rulesOf(again).includes('GF-INIT-1'));

  const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eccode-gf-init-'));
  const bad = refusal(() => initProject(fresh, { name: 'x', idea: 'an idea that is long enough', stackProfile: 'node-express' }));
  assert.ok(rulesOf(bad).includes('GF-INIT-1'));
  assert.strictEqual(fs.existsSync(path.join(fresh, '.eccode')), false, 'a refused init writes nothing');
});

test('GF-INIT-1: an existing plain ECCode project cannot be adopted in v1', () => {
  const plain = tmpProject();
  const err = refusal(() => initProject(plain.dir, { name: 'x', idea: 'adopting an existing project' }));
  assert.ok(rulesOf(err).includes('GF-INIT-1'));
  assert.strictEqual(wrap.isEnabled(plain.store), false);
});

test('positive: the sample goes through all three gates through the wrapped operations, registers six stages, registers the estimate, and seals', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), WRAPPED);
  const gf = gfOf(ctx);
  assert.deepStrictEqual(gf.registrations.map((r) => r.stage), ['prd', 'architecture', 'contracts', 'threat', 'breakdown', 'estimates']);
  assert.deepStrictEqual(gf.registrations.map((r) => r.gate), ['architecture', 'architecture', 'design', 'design', 'plan', 'plan']);
  assert.ok(gf.estimate.original, 'the estimate is registered');
  assert.ok(gf.seal, 'the plan approval sealed G1');
  assert.ok(gf.estimate.original.seq < gf.seal.seq && gf.seal.estimateSeq === gf.estimate.original.seq, 'the estimate is registered before the seal and the seal cites it');
  assert.strictEqual(gf.estimate.original.label, 'agent-estimate-uncalibrated');
  for (const f of ['contracts/openapi.json', 'contracts/db-schema.json', 'contracts/migrations-plan.json', 'contracts/access-matrix.json', 'contracts/fixtures.json', '.eccode/artifacts/prd.json']) {
    assert.match(gf.seal.hashes[f], /^[0-9a-f]{64}$/, `${f} is in the seal`);
  }
  assert.match(gf.seal.contractsHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(ctx.store.state().gates.plan.status, 'approved');
  assert.deepStrictEqual(ctx.store.audit().errors, []);

  // after the seal a task can be claimed through the wrapped operations
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  wrap.taskClaim(ctx.store, ctx.config, 's0-contracts', 'integration-engineer');
  assert.strictEqual(ctx.store.state().tasks['s0-contracts'].status, 'claimed');
});

test('the seal hash is deterministic: the same approved files give the same contractsHash', () => {
  const a = gfProject();
  const b = gfProject();
  run(a, sample.build(), WRAPPED);
  run(b, sample.build(), WRAPPED);
  assert.strictEqual(gfOf(a).seal.contractsHash, gfOf(b).seal.contractsHash);
});

for (const m of MUTATIONS) {
  test(`negative ${m.rule}: the wrapped ${m.gate} gate refuses ${m.name}, with the rule id, and commits nothing for it`, () => {
    const ctx = gfProject();
    const art = sample.build();
    m.apply(art);
    const err = refusal(() => run(ctx, art, WRAPPED));
    assert.strictEqual(err.code, 'GF_RULE', `${err.code}: ${err.message}`);
    assert.strictEqual(ctx.at, m.gate, `refused at ${ctx.at}, expected ${m.gate}`);
    assert.ok(rulesOf(err).includes(m.rule), `expected ${m.rule}, got ${rulesOf(err).join(', ')}`);
    const g = ctx.store.state().gates[m.gate];
    assert.strictEqual(g.submissions.length, 0, 'nothing was submitted to the refused gate');
    assert.strictEqual(gfOf(ctx).registrations.filter((r) => r.gate === m.gate).length, 0, 'nothing was registered for the refused gate');
  });
}

test('GF-SEAL-1: a claim and a phase start are refused until G1 is sealed (a plan approved through the frozen API has no seal)', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), FROZEN);
  assert.strictEqual(ctx.store.state().gates.plan.status, 'approved', 'the frozen engine approved the plan');
  assert.strictEqual(gfOf(ctx).seal, null);
  const start = refusal(() => wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator'));
  assert.ok(rulesOf(start).includes('GF-SEAL-1'));
  // the frozen engine would let the phase start and the claim through
  gates.startGate(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  const claim = refusal(() => wrap.taskClaim(ctx.store, ctx.config, 's0-contracts', 'integration-engineer'));
  assert.ok(rulesOf(claim).includes('GF-SEAL-1'));
  assert.strictEqual(ctx.store.state().tasks['s0-contracts'].status, 'pending', 'the refused claim changed nothing');
});

test('GF-EST-1: a phase gate cannot start when the seal has no registered estimate', () => {
  const ctx = gfProject();
  run(ctx, sample.build(), FROZEN);
  // forged straight through the store, as the plain CLI path could: a seal citing an estimate that was never registered
  ctx.store.commit('gf.g1.sealed', 'orchestrator', { contractsHash: 'a'.repeat(64), hashes: {}, planSubmissionId: ctx.store.state().gates.plan.approvedSubmission, estimateSeq: 1 });
  const err = refusal(() => wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator'));
  assert.ok(rulesOf(err).includes('GF-EST-1'), rulesOf(err).join(','));
});

test('GF-ART-1: approving a submission that the frozen API accepted (no registration) is refused', () => {
  const ctx = gfProject();
  const art = sample.build();
  try { run(ctx, art, FROZEN, { upTo: 'architecture' }); } catch (e) { assert.fail(`the frozen path should accept: ${e.message}`); }
  // the architecture gate is already approved by the frozen API; do the next gate by hand: frozen submit, wrapped review
  gates.startGate(ctx.store, ctx.config, 'design', 'orchestrator', { reviewers: ['technical-reviewer', 'security-reviewer'] });
  const written = sample.write(ctx.dir, art);
  gates.submit(ctx.store, ctx.config, 'design', 'technical-designer', { artifacts: written.design });
  const err = refusal(() => wrap.gateReview(ctx.store, ctx.config, 'design', 'technical-reviewer', ev('contracts/openapi.json')));
  assert.ok(rulesOf(err).includes('GF-ART-1'), rulesOf(err).join(','));
  assert.strictEqual(ctx.store.state().gates.design.reviews.length, 0);
  // a rejection does not need registrations: a reviewer may always ask for changes
  const reject = require('./helpers').rejection('F1');
  assert.doesNotThrow(() => wrap.gateReview(ctx.store, ctx.config, 'design', 'technical-reviewer', reject));
});

test('half-success: a file that changes between validation and the committed submission leaves no registration, and the review is refused', () => {
  const ctx = gfProject();
  const art = sample.build();
  const real = gates.submit;
  require('./fixtures/gf/flow').recordRequest(ctx, art);
  const written = sample.write(ctx.dir, art);
  gates.startGate(ctx.store, ctx.config, 'architecture', 'orchestrator');
  gates.submit = function patched(...args) {
    fs.appendFileSync(path.join(ctx.dir, '.eccode/artifacts/prd.json'), ' '); // changed after the wrapper validated it
    return real.apply(this, args);
  };
  let err;
  try { err = refusal(() => wrap.gateSubmit(ctx.store, ctx.config, 'architecture', 'product-architect', { artifacts: written.architecture })); } finally { gates.submit = real; }
  assert.ok(rulesOf(err).includes('GF-ART-1'), `${err.code}: ${err.message}`);
  assert.strictEqual(gfOf(ctx).registrations.length, 0, 'no registration for a submission that differs from what was validated');
  const review = refusal(() => wrap.gateReview(ctx.store, ctx.config, 'architecture', 'architecture-reviewer', ev('.eccode/artifacts/prd.json')));
  assert.ok(rulesOf(review).includes('GF-ART-1'));
});

test('GF-SEAL-1: a contract edited after design approval cannot be sealed (refused at plan submit with GF-ART-DRIFT, and at plan approval with GF-SEAL-1)', () => {
  const a = gfProject();
  const art = sample.build();
  run(a, art, WRAPPED, { upTo: 'design' });
  const written = sample.write(a.dir, art); // rewrites every file as approved; the drift is introduced after
  fs.appendFileSync(path.join(a.dir, 'contracts/openapi.json'), ' ');
  wrap.gateStart(a.store, a.config, 'plan', 'orchestrator');
  const submit = refusal(() => wrap.gateSubmit(a.store, a.config, 'plan', 'delivery-lead', { artifacts: written.plan }));
  assert.ok(rulesOf(submit).includes('GF-ART-DRIFT'), rulesOf(submit).join(','));

  // the drift appears only after the plan was submitted: approval is refused with GF-SEAL-1
  const b = gfProject();
  const art2 = sample.build();
  const w2 = run(b, art2, WRAPPED, { upTo: 'design' });
  wrap.gateStart(b.store, b.config, 'plan', 'orchestrator');
  wrap.gateSubmit(b.store, b.config, 'plan', 'delivery-lead', { artifacts: w2.plan });
  fs.appendFileSync(path.join(b.dir, 'contracts/openapi.json'), ' ');
  const approve = refusal(() => wrap.gateReview(b.store, b.config, 'plan', 'technical-reviewer', ev('.eccode/artifacts/plan.json')));
  assert.ok(rulesOf(approve).includes('GF-SEAL-1'), rulesOf(approve).join(','));
  assert.strictEqual(b.store.state().gates.plan.status, 'submitted');
  assert.strictEqual(gfOf(b).seal, null);
});

test('a plan review that requests changes does not seal', () => {
  const ctx = gfProject();
  const w = run(ctx, sample.build(), WRAPPED, { upTo: 'design' });
  wrap.gateStart(ctx.store, ctx.config, 'plan', 'orchestrator');
  wrap.gateSubmit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: w.plan });
  wrap.gateReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', require('./helpers').rejection('F1'));
  assert.strictEqual(ctx.store.state().gates.plan.status, 'changes_requested');
  assert.strictEqual(gfOf(ctx).seal, null);
  assert.strictEqual(gfOf(ctx).estimate.original, null);
});

test('non-GF projects: the wrapped operations are exactly the frozen ones (same results, same refusals)', () => {
  const plain = tmpProject();
  assert.strictEqual(wrap.isEnabled(plain.store), false);
  const unknown = refusal(() => wrap.gateStart(plain.store, plain.config, 'nope', 'orchestrator'));
  assert.strictEqual(unknown.code, 'UNKNOWN_GATE');
  wrap.gateStart(plain.store, plain.config, 'architecture', 'orchestrator');
  assert.strictEqual(plain.store.state().gates.architecture.status, 'in_progress');
  // a submission the GF layer would refuse for content is accepted: there is no GF layer here
  fs.mkdirSync(path.join(plain.dir, '.eccode/artifacts'), { recursive: true });
  fs.writeFileSync(path.join(plain.dir, '.eccode/artifacts/brief.md'), require('./helpers').ARCH_MD);
  const r = wrap.gateSubmit(plain.store, plain.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  assert.strictEqual(r.event.type, 'gate.submitted');
  assert.strictEqual(project(plain.store.readEvents()).registrations.length, 0);
  const claim = refusal(() => wrap.taskClaim(plain.store, plain.config, 'nope', 'backend-engineer'));
  assert.strictEqual(claim.code, 'UNKNOWN_TASK', 'the frozen refusal, not a GF one');
  void tasks; void approval;
});
