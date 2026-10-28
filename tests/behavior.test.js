'use strict';
// The behavior diff (Phase 2) at the engine level: routing, contract rules,
// classification, staleness, the reviewer's own run, coverage, waivers, the
// report, and the audit over its artifacts. The gates here run on a tiny
// Node repository with recorded results, so they need no Python; the real
// diff on the FastAPI fixture is in tests/phase2-fixtures.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const behavior = require('../lib/behavior');
const works = require('../lib/works');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const { deliver } = require('../lib/delivery');
const { tmpProject, write, approval, task, passCheck, handoffFor, expectCode, recordLesson, labRootCause } = require('./helpers');
const { sha256 } = require('../lib/util');

function commit(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], { cwd: dir });
}

/** A delivered greenfield record on a repo with a route and an imported helper, ready for the next work item. */
function project() {
  const ctx = tmpProject({ beforeInit: (dir) => {
    write(dir, 'src/util.js', 'function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }\nmodule.exports = { clamp };\n');
    write(dir, 'src/server.js', "const { clamp } = require('./util');\nconst app = { get: () => {} };\napp.get('/items', (req, res) => res.json({ n: clamp(req.query.n, 0, 10) }));\nmodule.exports = { app };\n");
    write(dir, 'tests/util.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\nconst { clamp } = require('../src/util');\ntest('clamp', () => assert.strictEqual(clamp(5, 0, 10), 5));\n");
    commit(dir, 'base');
  } });
  const { store, config } = ctx;
  require('./helpers').approveThroughPlan(ctx, { phases: [{ id: 'core', name: 'Core', goal: 'build the core service', acceptanceCriteria: ['the server responds'] }], tasks: [task('api', 'backend-engineer', ['src/**'])] });
  gates.startGate(store, config, 'phase:core', 'orchestrator');
  tasks.claim(store, config, 'api', 'backend-engineer');
  write(ctx.dir, 'src/server.js', fs.readFileSync(path.join(ctx.dir, 'src/server.js'), 'utf8') + '// v1\n');
  tasks.complete(store, config, 'api', 'backend-engineer', handoffFor('api', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/server.js']));
  gates.submit(store, config, 'phase:core', 'delivery-lead');
  gates.recordReview(store, config, 'phase:core', 'technical-reviewer', approval([[`ev:${passCheck(store, 'technical-reviewer').id}`]]));
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/v.md', '# V\nok\n');
  gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/v.md', 'src/server.js'] });
  gates.recordReview(store, config, 'verification', 'security-reviewer', approval([[`ev:${passCheck(store, 'security-reviewer').id}`]]));
  deliver(store, 'delivery-lead');
  commit(ctx.dir, 'w1 delivered');
  return ctx;
}

/** A recorded diff result (as the engine would write it) with the given differences. */
function recordResult(ctx, actor, { differences = [], coverage = 'ok', track } = {}) {
  const { store } = ctx;
  const state = store.state();
  const id = `bd-${Math.random().toString(36).slice(2, 8)}`;
  const artifactRel = `.eccode/behavior/${id}.json`;
  const text = JSON.stringify({ id, differences }) + '\n';
  write(ctx.dir, artifactRel, text);
  const diffs = differences.map((d, i) => ({ probe: `http:${d.target}#${i}`, surface: d.surface, target: d.target, role: null, input: {}, paths: [{ path: '$.status', baseline: 404, candidate: 400 }], sha256: sha256(JSON.stringify(d)), classification: 'unexplained', contract: null }));
  // Classification as the engine does it: against the contracts and amendments recorded so far.
  const entries = state.work.track === 'refactor' ? [] : [...state.behavior.contracts.flatMap((c) => c.entries.map((e) => ({ ...e, from: c.id }))), ...state.behavior.amendments.flatMap((a) => a.entries.map((e) => ({ ...e, from: a.id })))];
  for (const d of diffs) {
    const m = entries.find((e) => behavior.targetMatches(e, d));
    d.classification = m ? 'expected' : 'unexplained';
    d.contract = m ? m.from : null;
  }
  const unexplained = diffs.filter((d) => d.classification === 'unexplained').length;
  store.commit('behavior.diff.result', actor, { id, base: state.work.baseCommit, head: state.work.baseCommit, treeFingerprint: behavior.treeFingerprint(ctx.dir, state), probes: 10, executed: 10, dropped: 0, reached: coverage === 'ok' ? 10 : 0, nondeterministic: [], differences: diffs, unexplained, expected: diffs.length - unexplained, coverage, coverageNote: coverage === 'ok' ? null : 'no probe reached the impacted surface', evidence: [], notes: [], track: track || state.work.track, task: null, artifact: artifactRel, artifactSha256: sha256(text) });
  return id;
}

test('routing: a change that reaches a route or an imported definition must run the diff; a docs-only change may skip; quick and debug refuse', () => {
  const ctx = project();
  const { store, config, dir } = ctx;
  works.startWork(store, config, 'orchestrator', { track: 'fix', title: 'Clamp the upper bound' });
  const skip = behavior.route(store, config, 'backend-engineer');
  assert.strictEqual(skip.decision, 'skip');
  write(dir, 'src/util.js', 'function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n))); }\nmodule.exports = { clamp };\n');
  const run = behavior.route(store, config, 'backend-engineer');
  assert.strictEqual(run.decision, 'run');
  assert.ok(run.surfaces.some((s) => s.kind === 'function' && s.target === 'src/util.js::clamp'), JSON.stringify(run.surfaces));
  assert.ok(run.surfaces.some((s) => s.kind === 'http' && s.target === 'GET /items' && s.via === 'dependent'), 'the route in the dependent server is reached');
  assert.strictEqual(store.state().behavior.routing.id, run.id);
  assert.strictEqual(store.state().behavior.routings.length, 2);
  works.abandonWork(store, 'user', 'testing the quick track next');
  works.startWork(store, config, 'orchestrator', { track: 'quick', title: 'A quick change', quick: { owner: 'backend-engineer', files: 'src/**', command: 'node -e "process.exit(0)"' } });
  expectCode(() => behavior.route(store, config, 'backend-engineer'), 'TRACK_RULE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the last gate refuses: no routing; a stale skip; no result; an unexplained difference; a stale result; insufficient coverage — and accepts a reviewer\'s amendment or waiver', () => {
  const ctx = project();
  const { store, config, dir } = ctx;
  works.startWork(store, config, 'orchestrator', { track: 'fix', title: 'Clamp the upper bound' });
  const skip = behavior.route(store, config, 'backend-engineer');
  assert.strictEqual(skip.decision, 'skip');
  write(dir, 'src/util.js', 'function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n))); }\nmodule.exports = { clamp };\n');
  let problems = behavior.trackProblems(store.state(), dir);
  assert.match(problems.join('\n'), /routing recorded skip, but the change now reaches/);
  behavior.route(store, config, 'backend-engineer');
  problems = behavior.trackProblems(store.state(), dir);
  assert.match(problems.join('\n'), /no result is recorded/);
  // An unexplained difference.
  const r1 = recordResult(ctx, 'backend-engineer', { differences: [{ surface: 'http', target: 'GET /items' }] });
  problems = behavior.trackProblems(store.state(), dir);
  assert.match(problems.join('\n'), /1 unexplained difference\(s\)/);
  // The owner cannot whitewash it with a contract after the fact.
  expectCode(() => behavior.contract(store, config, 'backend-engineer', [{ surface: 'http', target: 'GET /items', inputClass: 'an id no item has', expected: 'status 400 instead of 404' }]), 'CONTRACT_AFTER_DIFF');
  // A reviewer amends it, with a reason; the reviewer whose run it was may not.
  expectCode(() => behavior.amend(store, config, 'backend-engineer', { result: r1, entries: [{ surface: 'http', target: 'GET /items', inputClass: 'an id no item has', expected: 'status 400 instead of 404' }], reason: 'owners do not amend' }), 'ROLE_NOT_ALLOWED');
  behavior.amend(store, config, 'technical-reviewer', { result: r1, entries: [{ surface: 'http', target: 'GET /items', inputClass: 'an id no item has', expected: 'status 400 instead of 404' }], reason: 'the 400 is the documented contract; the old 404 was the bug' });
  assert.deepStrictEqual(behavior.trackProblems(store.state(), dir), []);
  // The tree changes after the result: stale.
  write(dir, 'src/util.js', 'function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n))); } // edited\nmodule.exports = { clamp };\n');
  assert.match(behavior.trackProblems(store.state(), dir).join('\n'), /is stale: the tree changed after the diff ran/);
  // Insufficient coverage never passes silently; a reviewer may waive it.
  const r2 = recordResult(ctx, 'backend-engineer', { coverage: 'insufficient-coverage' });
  assert.match(behavior.trackProblems(store.state(), dir).join('\n'), /insufficient coverage/);
  expectCode(() => behavior.waive(store, config, 'backend-engineer', { result: r2, reason: 'owners do not waive coverage' }), 'ROLE_NOT_ALLOWED');
  expectCode(() => behavior.waive(store, config, 'security-reviewer', { result: r1, reason: 'that result had coverage ok already' }), 'INVALID_TRANSITION');
  behavior.waive(store, config, 'security-reviewer', { result: r2, reason: 'the clamp helper has no HTTP probe yet; the unit test covers the only caller' });
  assert.deepStrictEqual(behavior.trackProblems(store.state(), dir), []);
  assert.strictEqual(store.audit().ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a contract declared before the diff explains its differences; a refactor declares nothing and every difference is unexplained', () => {
  const ctx = project();
  const { store, config, dir } = ctx;
  works.startWork(store, config, 'orchestrator', { track: 'feature', title: 'Items answer 400 on a bad id' });
  expectCode(() => behavior.contract(store, config, 'technical-reviewer', [{ surface: 'http', target: 'GET /items', inputClass: 'an id no item has', expected: 'status 400 instead of 404' }]), 'ROLE_NOT_ALLOWED');
  expectCode(() => behavior.contract(store, config, 'technical-designer', [{ surface: 'grpc', target: 'x', inputClass: 'an id no item has', expected: 'status 400 instead of 404' }]), 'INVALID_INPUT');
  const c = behavior.contract(store, config, 'technical-designer', [{ surface: 'http', target: 'GET /items', inputClass: 'an id no item has', expected: 'status 400 instead of 404' }]);
  write(dir, 'src/util.js', 'function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n))); }\nmodule.exports = { clamp };\n');
  behavior.route(store, config, 'backend-engineer');
  const r = recordResult(ctx, 'backend-engineer', { differences: [{ surface: 'http', target: 'GET /items' }, { surface: 'http', target: 'GET /items' }] });
  const res = store.state().behavior.results.find((x) => x.id === r);
  assert.strictEqual(res.unexplained, 0);
  assert.ok(res.differences.every((d) => d.classification === 'expected' && d.contract === c.id));
  assert.deepStrictEqual(behavior.trackProblems(store.state(), dir), []);
  assert.match(behavior.reportLines(store.state()).join('\n'), /Declared behaviour changes[\s\S]*\| expected \(bc-/);
  works.abandonWork(store, 'user', 'now the refactor case');
  works.startWork(store, config, 'orchestrator', { track: 'refactor', title: 'Tidy the clamp helper', behavior: 'node -e "process.exit(0)"' });
  expectCode(() => behavior.contract(store, config, 'delivery-lead', [{ surface: 'http', target: 'GET /items', inputClass: 'every request', expected: 'nothing changes' }]), 'CONTRACT_REFUSED');
  write(dir, 'src/util.js', 'const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\nmodule.exports = { clamp };\n');
  behavior.route(store, config, 'backend-engineer');
  recordResult(ctx, 'backend-engineer', { differences: [{ surface: 'function', target: 'src/util.js::clamp' }] });
  assert.match(behavior.trackProblems(store.state(), dir).join('\n'), /A refactor changes no behaviour/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verification approval needs the reviewer\'s own fresh diff; delivery re-checks; the handoff reports it', () => {
  const ctx = project();
  const { store, config, dir } = ctx;
  works.startWork(store, config, 'orchestrator', { track: 'fix', title: 'Clamp accepts strings' });
  gates.startGate(store, config, 'plan', 'orchestrator');
  write(dir, '.eccode/artifacts/plan2.json', JSON.stringify({ phases: [{ id: 'fix', name: 'Fix', goal: 'clamp accepts numeric strings', acceptanceCriteria: ['clamp("5", 0, 10) is 5'] }], tasks: [task('clamp', 'backend-engineer', ['src/**'], [], 'fix')] }));
  gates.submit(store, config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/plan2.json'] });
  gates.recordReview(store, config, 'plan', 'technical-reviewer', approval([['artifact:.eccode/artifacts/plan2.json']]));
  gates.startGate(store, config, 'phase:fix', 'orchestrator');
  const repro = 'node -e "process.exit(process.env.CLAMPED ? 0 : 1)"';
  tasks.claim(store, config, 'clamp', 'backend-engineer');
  write(dir, 'src/util.js', 'function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n))); }\nmodule.exports = { clamp };\n');
  labRootCause(store, 'backend-engineer', { command: repro, at: 'src/util.js:1', task: 'clamp' });
  tasks.complete(store, config, 'clamp', 'backend-engineer', handoffFor('clamp', 'backend-engineer', [passCheck(store, 'backend-engineer').id], ['src/util.js']));
  gates.submit(store, config, 'phase:fix', 'delivery-lead');
  gates.recordReview(store, config, 'phase:fix', 'technical-reviewer', approval([[`ev:${passCheck(store, 'technical-reviewer').id}`]]));
  process.env.CLAMPED = '1';
  try {
    require('../lib/evidence').runCommand(store, 'backend-engineer', { label: 'fixed', command: repro });
  } finally {
    delete process.env.CLAMPED;
  }
  recordLesson(store);
  gates.startGate(store, config, 'verification', 'orchestrator');
  write(dir, '.eccode/artifacts/v2.md', '# V\nok\n');
  const submit = () => gates.submit(store, config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/v2.md', 'src/util.js'] });
  assert.match(expectCode(submit, 'TRACK_RULE').message, /behavior: no risk routing recorded/);
  behavior.route(store, config, 'delivery-lead');
  assert.match(expectCode(submit, 'TRACK_RULE').message, /no result is recorded/);
  recordResult(ctx, 'backend-engineer');
  submit();
  const ev = passCheck(store, 'security-reviewer');
  const review = approval([[`ev:${ev.id}`, 'artifact:.eccode/artifacts/v2.md']]);
  assert.match(expectCode(() => gates.recordReview(store, config, 'verification', 'security-reviewer', review), 'REVIEW_REJECTED').message, /requires the behavior diff re-run by the reviewer after submission/);
  recordResult(ctx, 'security-reviewer');
  gates.recordReview(store, config, 'verification', 'security-reviewer', review);
  // Editing after the reviewer's run: delivery refuses (stale), and so does the audit of approved artifacts.
  const before = fs.readFileSync(path.join(dir, 'src/util.js'), 'utf8');
  write(dir, 'src/util.js', before + '// late edit\n');
  assert.match(expectCode(() => deliver(store, 'delivery-lead'), 'DELIVERY_BLOCKED').message, /is stale: the tree changed after the diff ran/);
  write(dir, 'src/util.js', before);
  deliver(store, 'delivery-lead');
  const report = fs.readFileSync(path.join(dir, '.eccode/delivery/final-handoff-w2.md'), 'utf8');
  assert.match(report, /## Behavior diff[\s\S]*\*\*Risk routing:\*\* run/);
  assert.match(report, /## Debugging Lab/);
  assert.strictEqual(store.audit().ok, true);
  // A tampered diff artifact fails the audit.
  const r = store.state().behavior.results[0];
  fs.appendFileSync(path.join(dir, r.artifact), ' ');
  assert.match(store.audit().errors.join('\n'), /behavior diff bd-\S+: artifact .* differs from its recorded hash/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalization and flakiness: timestamps, uuids and addresses are normalized; unordered paths are sorted; nondeterministic paths are excluded', () => {
  const norm = (v) => behavior.normalizeValue(v, behavior.NORMALIZERS, new Set(['etag']), new Set(['$.items']));
  assert.deepStrictEqual(norm({ at: '2026-10-28T12:00:00Z', id: '123e4567-e89b-12d3-a456-426614174000', etag: 'x', obj: '<Thing object at 0x7f3a1c2b4d60>', items: [{ n: 2 }, { n: 1 }] }), { at: '<timestamp>', id: '<uuid>', obj: '<Thing object>', items: [{ n: 1 }, { n: 2 }] });
  assert.deepStrictEqual(behavior.diffPaths({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }), [{ path: '$.b[1]', baseline: 2, candidate: 3 }]);
  assert.deepStrictEqual(behavior.withoutPaths({ a: { t: 5 }, b: [1, 2] }, ['$.a.t', '$.b[0]']), { a: { t: '<nondeterministic>' }, b: ['<nondeterministic>', 2] });
  assert.ok(behavior.targetMatches({ surface: 'http', target: 'GET /items/*' }, { surface: 'http', target: 'GET /items/{id}' }));
  assert.ok(behavior.targetMatches({ surface: 'function', target: 'clamp' }, { surface: 'function', target: 'src/util.js::clamp' }));
  assert.ok(!behavior.targetMatches({ surface: 'http', target: 'POST /items' }, { surface: 'http', target: 'GET /items' }));
});
