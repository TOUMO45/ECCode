'use strict';
// bin/eccode-gf.js: the CLI face of the layer. Exit codes as the base CLI: 0 success, 1 usage or internal error,
// 2 refused by a rule. Driven as a real process in throwaway git repositories.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const sample = require('./fixtures/gf/sample');
const { MUTATIONS } = require('./fixtures/gf/mutations');
const { recordRequest } = require('./fixtures/gf/flow');
const { approval, rejection } = require('./helpers');
const { Store } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const { project } = require('../lib/greenfield/projection');

const CLI = path.join(__dirname, '..', 'bin', 'eccode-gf.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gf-cli-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}
function gf(dir, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '', ...extraEnv } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const json = (r) => JSON.parse(r.out);
function init(dir) {
  return gf(dir, ['init', '--name', 'Tasks API', '--idea', 'A small team task tracker with registration and ownership']);
}
function review(dir, name, body) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(body));
  return f;
}
const arts = (list) => list.flatMap((a) => ['--artifact', a]);

/** Drive the sample through the three gates with the CLI; the design module's records come from the library. */
function drive(dir, art, { stopAt = 'plan' } = {}) {
  const ctx = { dir, store: new Store(dir), config: loadConfig(dir) };
  recordRequest(ctx, art);
  const w = sample.write(dir, art);
  const ok = (r, what) => { if (r.code !== 0) throw Object.assign(new Error(`${what}: exit ${r.code}: ${r.err}`), { result: r }); return r; };
  ok(gf(dir, ['gate', 'start', 'architecture', '--actor', 'orchestrator']), 'start architecture');
  ok(gf(dir, ['gate', 'submit', 'architecture', '--actor', 'product-architect', ...arts(w.architecture)]), 'submit architecture');
  ok(gf(dir, ['gate', 'review', 'architecture', '--actor', 'architecture-reviewer', '--file', review(dir, 'r1.json', approval([['artifact:.eccode/artifacts/prd.json']]))]), 'review architecture');
  if (stopAt === 'architecture') return w;
  ok(gf(dir, ['gate', 'start', 'design', '--actor', 'orchestrator', '--reviewers', 'technical-reviewer,security-reviewer']), 'start design');
  ok(gf(dir, ['gate', 'submit', 'design', '--actor', 'technical-designer', ...arts(w.design)]), 'submit design');
  ok(gf(dir, ['gate', 'review', 'design', '--actor', 'technical-reviewer', '--file', review(dir, 'r2.json', approval([['artifact:contracts/openapi.json']]))]), 'review design');
  ok(gf(dir, ['gate', 'review', 'design', '--actor', 'security-reviewer', '--file', review(dir, 'r3.json', approval([['artifact:.eccode/artifacts/threat-model.json']]))]), 'security review design');
  ok(gf(dir, ['gate', 'start', 'plan', '--actor', 'orchestrator']), 'start plan');
  ok(gf(dir, ['gate', 'submit', 'plan', '--actor', 'delivery-lead', ...arts(w.plan)]), 'submit plan');
  ok(gf(dir, ['gate', 'review', 'plan', '--actor', 'technical-reviewer', '--file', review(dir, 'r4.json', approval([['artifact:.eccode/artifacts/plan.json']]))]), 'review plan');
  return w;
}

test('help states the enforcement wording and names every command; no command is also a bare "prevent"', () => {
  const r = gf(repo(), ['--help']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /prevention on the managed \(MCP\) path plus guaranteed detection by log-replay audit in all profiles/);
  for (const c of ['init', 'status', 'validate', 'gate', 'task claim', 'amend', 'message', 'estimate revise', 'audit']) assert.ok(r.out.includes(c), `${c} missing from help`);
  assert.strictEqual(gf(repo(), []).code, 0, 'no arguments prints the help');
});

test('init: creates the project, status reports it; a second init, an unsupported stack and a missing flag are refused with the right exit codes', () => {
  const dir = repo();
  const r = init(dir);
  assert.strictEqual(r.code, 0, r.err);
  const s = json(gf(dir, ['status', '--json']));
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.stackProfile, 'python-fastapi-sqlalchemy-sqlite');
  assert.strictEqual(s.sealed, false);
  const again = init(dir);
  assert.strictEqual(again.code, 2);
  assert.match(again.err, /GF-INIT-1/);
  const fresh = repo();
  const bad = gf(fresh, ['init', '--name', 'x', '--idea', 'an idea that is long enough', '--stack', 'node-express']);
  assert.strictEqual(bad.code, 2);
  assert.match(bad.err, /GF-INIT-1/);
  assert.strictEqual(fs.existsSync(path.join(fresh, '.eccode')), false);
  const missing = gf(repo(), ['init', '--name', 'x']);
  assert.strictEqual(missing.code, 1);
  assert.match(missing.err, /--idea/);
});

test('the sample goes through all three gates by CLI, seals, and the audit is clean; a claim then works', () => {
  const dir = repo();
  init(dir);
  drive(dir, sample.build());
  const s = json(gf(dir, ['status', '--json']));
  assert.strictEqual(s.sealed, true);
  assert.strictEqual(s.estimateRegistered, true);
  assert.deepStrictEqual(s.registered.sort(), ['architecture', 'breakdown', 'contracts', 'estimates', 'prd', 'threat']);
  const a = gf(dir, ['audit', '--json']);
  assert.strictEqual(a.code, 0, a.out + a.err);
  assert.deepStrictEqual(json(a).errors, []);
  assert.strictEqual(gf(dir, ['gate', 'start', 'phase:skeleton', '--actor', 'orchestrator']).code, 0);
  const claim = gf(dir, ['task', 'claim', 's0-contracts', '--actor', 'integration-engineer']);
  assert.strictEqual(claim.code, 0, claim.err);
});

test('validate: a good gate exits 0; a bad one exits 2 and names the rule; it commits nothing', () => {
  const dir = repo();
  init(dir);
  const art = sample.build();
  MUTATIONS.find((m) => m.rule === 'GF-PRD-2').apply(art);
  const ctx = { dir, store: new Store(dir), config: loadConfig(dir) };
  recordRequest(ctx, art);
  const w = sample.write(dir, art);
  const before = fs.readFileSync(path.join(dir, '.eccode/events.jsonl'));
  const r = gf(dir, ['validate', 'architecture', ...arts(w.architecture), '--json']);
  assert.strictEqual(r.code, 2);
  assert.ok(json(r).problems.some((p) => p.rule === 'GF-PRD-2'));
  assert.ok(Buffer.compare(before, fs.readFileSync(path.join(dir, '.eccode/events.jsonl'))) === 0);

  const good = repo();
  init(good);
  const clean = sample.build();
  const c2 = { dir: good, store: new Store(good), config: loadConfig(good) };
  recordRequest(c2, clean);
  const w2 = sample.write(good, clean);
  assert.strictEqual(gf(good, ['validate', 'architecture', ...arts(w2.architecture)]).code, 0);
});

test('gate submit: a mutated bundle is refused with exit 2 and its rule id on stderr, and nothing is submitted', () => {
  const dir = repo();
  init(dir);
  const art = sample.build();
  MUTATIONS.find((m) => m.rule === 'GF-ARC-1' && /one alternative/.test(m.name)).apply(art);
  let failure;
  try { drive(dir, art); } catch (e) { failure = e; }
  assert.ok(failure && failure.result, 'the drive must stop at a refusal');
  assert.strictEqual(failure.result.code, 2);
  assert.match(failure.result.err, /GF-ARC-1/);
  assert.strictEqual(new Store(dir).state().gates.architecture.submissions.length, 0);
});

test('task claim and a phase start before the seal exit 2 with GF-SEAL-1', () => {
  const dir = repo();
  init(dir);
  drive(dir, sample.build(), { stopAt: 'architecture' });
  const start = gf(dir, ['gate', 'start', 'phase:skeleton', '--actor', 'orchestrator']);
  assert.strictEqual(start.code, 2);
  assert.match(start.err, /GF-SEAL-1/);
  const claim = gf(dir, ['task', 'claim', 's0-contracts', '--actor', 'integration-engineer']);
  assert.strictEqual(claim.code, 2);
  assert.match(claim.err, /GF-SEAL-1/);
});

test('gate review: a review that requests changes is accepted without registrations and moves the gate to changes_requested', () => {
  const dir = repo();
  init(dir);
  const w = drive(dir, sample.build(), { stopAt: 'architecture' });
  assert.strictEqual(gf(dir, ['gate', 'start', 'design', '--actor', 'orchestrator', '--reviewers', 'technical-reviewer,security-reviewer']).code, 0);
  assert.strictEqual(gf(dir, ['gate', 'submit', 'design', '--actor', 'technical-designer', ...arts(w.design)]).code, 0);
  const r = gf(dir, ['gate', 'review', 'design', '--actor', 'technical-reviewer', '--file', review(dir, 'rej.json', rejection('F1')), '--json']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(json(r).gateStatus, 'changes_requested');
  const noFile = gf(dir, ['gate', 'review', 'design', '--actor', 'technical-reviewer']);
  assert.strictEqual(noFile.code, 1);
  assert.match(noFile.err, /--file/);
});

test('audit exits 2 and names the rule when a sealed contract is changed', () => {
  const dir = repo();
  init(dir);
  drive(dir, sample.build());
  fs.appendFileSync(path.join(dir, 'contracts/openapi.json'), ' ');
  const a = gf(dir, ['audit', '--json']);
  assert.strictEqual(a.code, 2);
  assert.ok(json(a).errors.some((e) => e.rule === 'GF-FRZ-2'));
});

test('messages and amendment through the CLI', () => {
  const dir = repo();
  init(dir);
  drive(dir, sample.build());
  const sent = json(gf(dir, ['message', 'send', '--actor', 'frontend-engineer', '--to', 'api', '--kind', 'amendment-request', '--subject', 'need GET /me', '--body', 'the client shows the caller', '--json']));
  assert.strictEqual(sent.from, 'frontend');
  const listed = json(gf(dir, ['message', 'list', '--to', 'api', '--json']));
  assert.strictEqual(listed.length, 1);
  const bad = gf(dir, ['message', 'send', '--actor', 'technical-reviewer', '--to', 'api', '--kind', 'question', '--subject', 'who am I', '--body', 'a reviewer has no group']);
  assert.strictEqual(bad.code, 2);
  assert.match(bad.err, /GF-MSG-1/);
  const req = json(gf(dir, ['amend', 'request', '--actor', 'frontend-engineer', '--contract', 'contracts/openapi.json', '--reason', 'the web client needs the caller\'s profile and the contract has none', '--message', sent.id, '--proposed', 'add GET /me', '--json']));
  const file = path.join(dir, 'contracts/openapi.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.paths['/me'] = { get: { operationId: 'getMe', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } }, 401: { description: 'no', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } } };
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  const notReviewer = gf(dir, ['amend', 'apply', '--actor', 'frontend-engineer', '--request', req.id, '--reason', 'approving my own request must not be allowed at all']);
  assert.strictEqual(notReviewer.code, 2);
  assert.match(notReviewer.err, /GF-FRZ-5/);
  const applied = json(gf(dir, ['amend', 'apply', '--actor', 'technical-reviewer', '--request', req.id, '--reason', 'approved: additive and needed by the web client', '--json']));
  assert.strictEqual(applied.classification, 'additive');
  const groups = path.join(dir, 'groups.json');
  fs.writeFileSync(groups, JSON.stringify({ backend: { tasks: 5, minutes: { low: 100, high: 300 }, tokens: { low: 800000, high: 2000000 } } }));
  const rev = gf(dir, ['estimate', 'revise', '--actor', 'delivery-lead', '--reason', 'the contract grew by one operation after the seal', '--file', groups, '--json']);
  assert.strictEqual(rev.code, 0, rev.err);
  assert.ok(project(new Store(dir).readEvents()).estimate.revisions.length === 1);
});

test('usage errors exit 1: unknown command, unknown subcommand, a missing --actor', () => {
  const dir = repo();
  init(dir);
  assert.strictEqual(gf(dir, ['frobnicate']).code, 1);
  assert.strictEqual(gf(dir, ['gate', 'frobnicate', 'architecture', '--actor', 'orchestrator']).code, 1);
  const noActor = gf(dir, ['gate', 'start', 'architecture']);
  assert.strictEqual(noActor.code, 1);
  assert.match(noActor.err, /--actor/);
  assert.strictEqual(gf(dir, ['--actor', 'a', '--actor', 'b', 'status']).code, 1, 'a flag given twice is refused, as in the base CLI');
});
