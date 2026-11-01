'use strict';
// Design before code (Phase 3, Part A): no ownership on a design track without a
// decision over two alternatives; a spike never ships; the verification review
// cites the ADR; interfaces outside the ADR need a reviewed amendment; a
// blocking ambiguity stops planning until the user clarifies or a reading is
// recorded as an assumption that the report surfaces. Bypass tests forge the
// raw events.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const works = require('../lib/works');
const design = require('../lib/design');
const behavior = require('../lib/behavior');
const { deliver, preconditions, buildReport } = require('../lib/delivery');
const { tmpProject, write, approval, task, passCheck, handoffFor, expectCode, approveThroughPlan, designDecision, adrRef, ARCH_MD, DESIGN_MD } = require('./helpers');

const T = (k) => `${k} tradeoff stated for the test`;
const TRADEOFFS = { complexity: T('complexity'), risk: T('risk'), performance: T('performance'), security: T('security'), reversibility: T('reversibility') };
const OPTIONS = [{ id: 'A', title: 'Keep it in process', tradeoffs: TRADEOFFS }, { id: 'B', title: 'Split a service', tradeoffs: TRADEOFFS }];

function commit(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], { cwd: dir });
}

/** Architecture and design gates approved on a greenfield record; the plan gate not yet started. */
function throughDesign(ctx) {
  const { dir, store, config } = ctx;
  gates.startGate(store, config, 'architecture', 'orchestrator');
  write(dir, '.eccode/artifacts/brief.md', ARCH_MD);
  gates.submit(store, config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] });
  gates.recordReview(store, config, 'architecture', 'architecture-reviewer', approval([['artifact:.eccode/artifacts/brief.md#Requirements']]));
  gates.startGate(store, config, 'design', 'orchestrator');
  write(dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(store, config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  gates.recordReview(store, config, 'design', 'technical-reviewer', approval([['artifact:.eccode/artifacts/spec.md']]));
}

function throughPlan(ctx, plan) {
  const { dir, store, config } = ctx;
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan.json', JSON.stringify(plan, null, 2));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/plan.json']]));
}

const onePlan = () => ({ phases: [{ id: 'core', name: 'Core', goal: 'build the core service', acceptanceCriteria: ['the server responds'] }], tasks: [task('api', 'backend-engineer', ['src/**'])] });

test('gate 1: ownership on a design track is refused until a decision over two alternatives exists; quick and fix are exempt', () => {
  const ctx = tmpProject();
  const { store, config } = ctx;
  throughDesign(ctx);
  throughPlan(ctx, onePlan());
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  assert.match(expectCode(() => tasks.claim(store, config, 'api', 'backend-engineer'), 'TRACK_RULE').message, /no design decision recorded/);
  // One option is not a comparison.
  assert.match(expectCode(() => design.alternatives(store, config, 'technical-designer', [OPTIONS[0]]), 'INVALID_INPUT').message, /at least two options/);
  // A missing tradeoff is refused.
  assert.match(expectCode(() => design.alternatives(store, config, 'technical-designer', [OPTIONS[0], { id: 'C', title: 'Other', tradeoffs: { ...TRADEOFFS, security: '' } }]), 'INVALID_INPUT').message, /tradeoff security/);
  // An implementer may not decide.
  expectCode(() => design.alternatives(store, config, 'backend-engineer', OPTIONS), 'ROLE_NOT_ALLOWED');
  const alt = design.alternatives(store, config, 'technical-designer', OPTIONS);
  // The decision must reject every other option with a reason, and choose one of them.
  assert.match(expectCode(() => design.decide(store, config, 'technical-designer', { alternatives: alt.id, chosen: 'A', rationale: 'A keeps the deployment unchanged and is reversible', rejected: [] }), 'INVALID_INPUT').message, /missing: B/);
  expectCode(() => design.decide(store, config, 'technical-designer', { alternatives: alt.id, chosen: 'Z', rationale: 'A keeps the deployment unchanged and is reversible', rejected: [{ option: 'B', why: 'a second service to run' }] }), 'INVALID_INPUT');
  const dec = design.decide(store, config, 'technical-designer', { alternatives: alt.id, chosen: 'A', rationale: 'A keeps the deployment unchanged and is reversible', rejected: [{ option: 'B', why: 'a second service to run' }], interfaces: [{ surface: 'http', target: 'GET /items' }] });
  assert.strictEqual(store.state().design.decision.id, dec.id);
  tasks.claim(store, config, 'api', 'backend-engineer');
  assert.strictEqual(store.state().tasks.api.status, 'claimed');
  // Once implementation started, the decision is locked: a change is a reviewer's amendment.
  expectCode(() => design.decide(store, config, 'technical-designer', { alternatives: alt.id, chosen: 'B', rationale: 'changed my mind after starting the implementation', rejected: [{ option: 'A', why: 'turned out to be slower' }] }), 'DESIGN_LOCKED');
  expectCode(() => design.amend(store, config, 'backend-engineer', { decision: dec.id, interfaces: [{ surface: 'http', target: 'GET /x' }], reason: 'the owner cannot amend' }), 'ROLE_NOT_ALLOWED');
  const am = design.amend(store, config, 'technical-reviewer', { decision: dec.id, interfaces: [{ surface: 'http', target: 'GET /x' }], reason: 'a second read route is needed' });
  assert.strictEqual(store.state().design.amendments[0].id, am.id);
  assert.ok(store.audit().ok);
  // The fix, debug and quick tracks are exempt (the Lab's tracks and the small-change track).
  const { emptyDesign } = require('../lib/reducer');
  for (const track of ['fix', 'debug', 'quick']) assert.strictEqual(design.claimProblem({ work: { track, status: 'active' }, design: emptyDesign(), tasks: {} }), null, track);
  assert.match(design.claimProblem({ work: { track: 'feature', status: 'active' }, design: emptyDesign(), tasks: {} }), /no design decision/);
});

test('bypass: a forged decision over one alternative, or alternatives missing a tradeoff, still refuses ownership', () => {
  const ctx = tmpProject();
  const { store, config } = ctx;
  throughDesign(ctx);
  throughPlan(ctx, onePlan());
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  store.commit('design.alternatives', 'technical-designer', { id: 'da-forged', options: [OPTIONS[0]] });
  store.commit('design.decision', 'technical-designer', { id: 'dd-forged', alternatives: 'da-forged', chosen: 'A', rationale: 'forged straight into the log', rejected: [], interfaces: [] });
  assert.match(expectCode(() => tasks.claim(store, config, 'api', 'backend-engineer'), 'TRACK_RULE').message, /references 1 alternative/);
  store.commit('design.alternatives', 'technical-designer', { id: 'da-forged2', options: [OPTIONS[0], { id: 'B', title: 'B', tradeoffs: { complexity: 'stated for the test here' } }] });
  store.commit('design.decision', 'technical-designer', { id: 'dd-forged2', alternatives: 'da-forged2', chosen: 'A', rationale: 'forged straight into the log', rejected: [], interfaces: [] });
  assert.match(expectCode(() => tasks.claim(store, config, 'api', 'backend-engineer'), 'TRACK_RULE').message, /do not state every tradeoff/);
});

test('gate 2: a spike never ships, by path or by content under another name; an open spike blocks completion', () => {
  const ctx = tmpProject({ beforeInit: (dir) => { write(dir, 'src/server.js', 'module.exports = 1;\n'); commit(dir, 'base'); } });
  const { dir, store, config } = ctx;
  approveThroughPlan(ctx, { phases: [{ id: 'core', name: 'Core', goal: 'build the core service', acceptanceCriteria: ['the server responds'] }], tasks: [task('api', 'backend-engineer', ['src/**', 'spikes/**'])] });
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  const sp = design.spikeStart(store, config, 'backend-engineer', { question: 'does the streaming parser keep up?', paths: ['spikes/**'] });
  write(dir, 'spikes/try.js', 'console.log("throwaway prototype of the streaming parser");\n');
  write(dir, 'src/server.js', 'module.exports = 2;\n');
  const complete = (files) => tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], files));
  // Open spike, and its file in the change.
  let err = expectCode(() => complete(['src/server.js', 'spikes/try.js']), 'INVALID_HANDOFF');
  assert.match(err.message, /spike .* is open/);
  assert.match(err.message, /still in the change: spikes\/try\.js/);
  expectCode(() => design.spikeClose(store, config, 'frontend-engineer', sp.id, { proved: 'it keeps up at 10k lines per second' }), 'ROLE_NOT_ALLOWED');
  const closed = design.spikeClose(store, config, 'backend-engineer', sp.id, { proved: 'it keeps up at 10k lines per second' });
  assert.deepStrictEqual(Object.keys(closed.fileHashes), ['spikes/try.js']);
  // Closed but still present.
  err = expectCode(() => complete(['src/server.js', 'spikes/try.js']), 'INVALID_HANDOFF');
  assert.match(err.message, /still in the change/);
  // Renamed into the delivered area: the content is recognized.
  fs.renameSync(path.join(dir, 'spikes/try.js'), path.join(dir, 'src/parser.js'));
  err = expectCode(() => complete(['src/server.js', 'src/parser.js']), 'INVALID_HANDOFF');
  assert.match(err.message, /src\/parser\.js has the content of spike/);
  fs.rmSync(path.join(dir, 'src/parser.js'));
  complete(['src/server.js']);
  assert.strictEqual(store.state().tasks.api.status, 'done');
  // Delivery re-checks: a spike file put back after completion is refused.
  write(dir, 'spikes/try.js', 'console.log("throwaway prototype of the streaming parser");\n');
  const pre = preconditions(store, 'delivery-lead');
  assert.ok(pre.problems.some((p) => /spike .* is still in the change: spikes\/try\.js/.test(p)), pre.problems.join('\n'));
});

test('gate 3: the verification review must cite the ADR; delivery refuses interfaces the ADR does not declare until a reviewer amends', () => {
  const ctx = tmpProject({ beforeInit: (dir) => { write(dir, 'src/server.js', "const app = { get: () => {} };\napp.get('/items', () => 1);\nmodule.exports = { app };\n"); commit(dir, 'base'); } });
  const { dir, store, config } = ctx;
  // A feature work item (the initial greenfield item abandoned by the user): the behavior contract names an interface.
  works.abandonWork(store, 'user', 'the greenfield item is replaced by a feature item for this test');
  works.startWork(store, config, 'orchestrator', { track: 'feature', title: 'Add a read route' });
  gates.startGate(store, config, 'design', 'orchestrator');
  write(dir, '.eccode/artifacts/spec.md', DESIGN_MD);
  gates.submit(store, config, 'design', 'technical-designer', { artifacts: ['.eccode/artifacts/spec.md'] });
  gates.recordReview(store, config, 'design', 'technical-reviewer', approval([['artifact:.eccode/artifacts/spec.md']]));
  const adr = designDecision(ctx, { interfaces: [{ surface: 'http', target: 'GET /items' }] });
  behavior.contract(store, config, 'technical-designer', [{ surface: 'http', target: 'POST /items', inputClass: 'any body', expected: 'creates an item' }]);
  const problems = design.deliveryProblems(store.state(), dir, []);
  assert.ok(problems.some((p) => /interfaces changed that the ADR .* does not declare: http POST \/items/.test(p)), problems.join('\n'));
  design.amend(store, config, 'technical-reviewer', { decision: store.state().design.decision.id, interfaces: [{ surface: 'http', target: 'POST /items' }], reason: 'the write route is part of the feature' });
  assert.deepStrictEqual(design.deliveryProblems(store.state(), dir, []), []);
  // A wildcard interface covers its prefix.
  assert.deepStrictEqual(design.interfaceProblems({ ...store.state(), behavior: { contracts: [] }, design: { ...store.state().design, decision: { ...store.state().design.decision, interfaces: [{ surface: 'http', target: 'GET /items*' }] }, amendments: [] } }, ['http GET /items/1']), []);
  assert.strictEqual(design.interfaceProblems({ ...store.state(), behavior: { contracts: [] }, design: { ...store.state().design, decision: { ...store.state().design.decision, interfaces: [{ surface: 'http', target: 'GET /items*' }] }, amendments: [] } }, ['http DELETE /items/1']).length, 1);
  // The review rule: a verification approval without the ADR ref is rejected with the reason.
  const review = approval([['ev:x']]);
  const reasons = design.reviewProblems(store.state(), 'verification', { ...review, criteria: [{ id: 'c1', met: true, evidence: ['ev:x'] }] });
  assert.match(reasons[0], /must cite the ADR \(artifact:\.eccode\/design\//);
  assert.deepStrictEqual(design.reviewProblems(store.state(), 'verification', { ...review, criteria: [{ id: 'c1', met: true, evidence: ['ev:x', adr] }] }), []);
  assert.deepStrictEqual(design.reviewProblems(store.state(), 'phase:core', review), []);
  // The ADR is content-hashed: an edit after the fact fails the audit.
  const rel = store.state().design.adrs[0].artifact;
  fs.appendFileSync(path.join(dir, rel), '\nedited after the fact\n');
  assert.strictEqual(store.audit().ok, false);
  assert.match(store.audit().errors.join('\n'), /ADR .* differs from its recorded hash/);
});

test('gate 3, end to end: a greenfield delivery whose verification review does not cite the ADR is rejected, then delivered with it; the report shows the decision', () => {
  const ctx = tmpProject({ beforeInit: (dir) => { write(dir, 'src/server.js', 'module.exports = 1;\n'); commit(dir, 'base'); } });
  const { dir, store, config } = ctx;
  approveThroughPlan(ctx, onePlan());
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(dir, 'src/server.js', 'module.exports = 2;\n');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server.js']));
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${passCheck(store, 'technical-reviewer').id}`]]));
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/v.md', '# V\nok\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/v.md', 'src/server.js'] });
  const ev = passCheck(store, 'security-reviewer').id;
  assert.match(expectCode(() => gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${ev}`]])), 'REVIEW_REJECTED').message, /must cite the ADR/);
  gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${ev}`, ...adrRef(ctx)]]));
  const r = deliver(store, 'delivery-lead');
  const report = fs.readFileSync(path.join(dir, r.report), 'utf8');
  assert.match(report, /## Design decision\n\n\*\*A\*\* over B/);
  assert.ok(store.audit().ok);
});

test('gate 4: a blocking ambiguity stops planning; only the user clarifies; a recorded assumption lets planning continue and the report says so', () => {
  const ctx = tmpProject();
  const { store, config } = ctx;
  throughDesign(ctx);
  const amb = design.ambiguity(store, config, 'orchestrator', [{ id: 'q1', text: 'What happens to orders in flight when the price changes?', blocking: true }, { id: 'q2', text: 'Should the export include archived items?', blocking: false }]);
  assert.strictEqual(amb.questions.length, 2);
  assert.match(expectCode(() => gates.startGate(store, config, 'plan', 'orchestrator'), 'AMBIGUITY_OPEN').message, /q1 \(What happens to orders/);
  // Guessing silently is not possible: an implementer or the orchestrator cannot clarify.
  expectCode(() => design.clarify(store, config, 'orchestrator', { question: 'q1', answer: 'they keep the old price' }), 'USER_AUTH_REQUIRED');
  // An assumption needs a reading and a rationale, on an open question.
  expectCode(() => design.assume(store, config, 'orchestrator', { question: 'q9', reading: 'they keep the old price', rationale: 'the invoice already went out' }), 'NOT_FOUND');
  expectCode(() => design.assume(store, config, 'orchestrator', { question: 'q1', reading: '', rationale: 'the invoice already went out' }), 'INVALID_INPUT');
  design.assume(store, config, 'orchestrator', { question: 'q1', reading: 'orders in flight keep the price they were placed at', rationale: 'the invoice has already been issued at that price' });
  gates.startGate(store, config, 'plan', 'orchestrator');
  assert.strictEqual(store.state().gates.plan.status, 'in_progress');
  // The user's clarification is recorded for the non-blocking one too.
  design.clarify(store, config, 'user', { question: 'q2', answer: 'yes, archived items are exported' });
  const lines = design.reportLines(store.state()).join('\n');
  assert.match(lines, /q1 \(blocking\).*\*\*assumed\*\* \(not confirmed by the user\): orders in flight keep the price/);
  assert.match(lines, /q2: .*clarified by the user: yes, archived items/);
  assert.match(design.assumptionLines(store.state())[0], /^Assumption \(not confirmed by the user\) on q1/);
  // Bypass: a forged clarification by a non-user actor does not count as the user's answer... it is refused at commit time by the role check,
  // and a forged raw event is visible in the log with its actor.
  const ctx2 = tmpProject();
  throughDesign(ctx2);
  design.ambiguity(ctx2.store, ctx2.config, 'orchestrator', [{ id: 'q1', text: 'Which currency are totals reported in?', blocking: true }]);
  ctx2.store.commit('request.clarified', 'orchestrator', { question: 'q1', answer: 'forged by the orchestrator' });
  // A clarification not by the user is not an answer: planning stays refused.
  const forged = ctx2.store.state().design.clarifications[0];
  assert.strictEqual(forged.by, 'orchestrator');
  assert.match(expectCode(() => gates.startGate(ctx2.store, ctx2.config, 'plan', 'orchestrator'), 'AMBIGUITY_OPEN').message, /q1/);
});

test('the CLI and MCP expose the design and request groups', () => {
  const tools = require('../lib/mcp').tools().map((t) => t.name);
  for (const n of ['design_alternatives', 'design_decide', 'design_adr', 'design_amend', 'design_spike_start', 'design_spike_close', 'design_show', 'request_ambiguity', 'request_assume', 'request_show']) assert.ok(tools.includes(n), n);
  const help = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'eccode.js'), '--help'], { encoding: 'utf8' });
  assert.match(help, /design alternatives --file/);
  assert.match(help, /request ambiguity --file/);
});
