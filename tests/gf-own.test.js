'use strict';
// S2, T1: the ownership map (GF-OWN-1, GF-OWN-5). The map is the sealed breakdown's groups plus reviewer
// amendments; it is read back from the approved bytes (hash-checked against the seal), never trusted from the log.
// Table-driven: a valid operation, then one change per row, each expecting a rule id and a message fragment.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sample = require('./fixtures/gf/sample');
const { gfProject, run, WRAPPED, FROZEN } = require('./fixtures/gf/flow');
const ownership = require('../lib/greenfield/ownership');
const ops = require('../lib/greenfield/ownership-ops');
const audit = require('../lib/greenfield/audit');
const messages = require('../lib/greenfield/messages');
const bundle = require('../lib/greenfield/bundle');
const mcp = require('../lib/mcp');
const { project } = require('../lib/greenfield/projection');

const sealed = () => { const ctx = gfProject(); run(ctx, sample.build(), WRAPPED); return ctx; };
const base = () => ownership.mapOf(sample.build().breakdown);
const call = (name, args, ctx, actor) => mcp.tools().find((t) => t.name === name).handler(args, { store: ctx.store, config: ctx.config, actor });
const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refusal(fn) { try { fn(); } catch (e) { return e; } throw new Error('expected a refusal, but the call succeeded'); }
const errs = (ctx) => audit.run(ctx.store, ctx.config).errors;
const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);
const REASON = 'the db group needs the alembic configuration file to run migrations';
const note = (ctx) => messages.send(ctx.store, ctx.config, 'database-engineer', { to: ['orchestrator'], kind: 'blocker', subject: 'alembic.ini is unowned', body: 'The migration runner needs alembic.ini at the project root, which no group owns.' }).id;
const DB_GLOBS = ['app/db/**', 'migrations/**', 'seed/**'];
const goodAmendment = (ctx, over = {}) => ({ group: 'db', to: [...DB_GLOBS, 'alembic.ini'], reason: REASON, message: note(ctx), ...over });
function expectAudit(ctx, rule, re) {
  const found = errs(ctx);
  assert.ok(found.some((e) => e.rule === rule && re.test(e.message)), `expected ${rule} /${re.source}/; got ${JSON.stringify(found.map((e) => `${e.rule}: ${e.message.slice(0, 100)}`))}`);
}

// ------------------------------------------------------------------ the map algebra
test('mapOf reads the groups of a breakdown: roles, globs and denied globs', () => {
  const m = base();
  assert.deepStrictEqual(Object.keys(m.groups).sort(), ['api', 'backend', 'db', 'delivery', 'frontend', 'security', 'test']);
  assert.deepStrictEqual(m.groups.backend.denyGlobs, ['app/db/**', 'app/auth/**']);
  assert.deepStrictEqual(m.groups.delivery.roles, ['delivery-lead', 'devops-engineer']);
});

const OWNER_ROWS = [
  ['app/main.py', 'backend'],
  ['app/db/models.py', 'db'],
  ['app/auth/tokens.py', 'security'],
  ['migrations/versions/0001.py', 'db'],
  ['contracts/openapi.json', 'api'],
  ['mocks/server.js', 'api'],
  ['tests/acceptance/test_auth.py', 'test'],
  ['web/index.html', 'frontend'],
  ['Dockerfile', 'delivery'],
  ['pyproject.toml', null],
  ['README.md', null],
  ['app/../web/x.js', 'frontend'],
  ['./web/x.js', 'frontend'],
  ['web//x.js', 'frontend'],
  ['../outside.txt', null],
  ['web/../../outside.txt', null],
  ['/etc/passwd', null],
  ['', null],
  ['.', null],
  ['web\\x.js', null],
  ['web/\u0000x.js', null],
  ['app/main\u0000.py', null],
  [undefined, null],
  [42, null],
];
for (const [rel, want] of OWNER_ROWS) {
  test(`ownerOfPath(${JSON.stringify(rel)}) is ${JSON.stringify(want)}`, () => {
    assert.strictEqual(ownership.ownerOfPath(base(), rel), want);
  });
}

test('effectiveMap replaces exactly the amended group\'s globs, in log order; mapAt ignores later amendments', () => {
  const b = base();
  const am = [{ seq: 10, group: 'db', from: DB_GLOBS, to: [...DB_GLOBS, 'alembic.ini'] }, { seq: 20, group: 'db', from: [...DB_GLOBS, 'alembic.ini'], to: ['app/db/**'] }];
  assert.deepStrictEqual(ownership.effectiveMap(b, am).groups.db.globs, ['app/db/**']);
  assert.deepStrictEqual(ownership.effectiveMap(b, am).groups.backend.globs, ['app/**']);
  assert.deepStrictEqual(ownership.mapAt(b, am, 15).groups.db.globs, [...DB_GLOBS, 'alembic.ini']);
  assert.deepStrictEqual(ownership.mapAt(b, am, 5).groups.db.globs, DB_GLOBS);
  assert.deepStrictEqual(b.groups.db.globs, DB_GLOBS, 'the base map is not mutated');
});

test('mapProblems: a valid map is clean; overlap and a missing reserved path are named', () => {
  assert.deepStrictEqual(ownership.mapProblems(base()), []);
  const overlap = ownership.effectiveMap(base(), [{ seq: 1, group: 'backend', to: ['app/**', 'web/**'] }]);
  assert.ok(ownership.mapProblems(overlap).some((p) => /web\/\*\*/.test(p) && /both own/.test(p)));
  const noApi = ownership.effectiveMap(base(), [{ seq: 1, group: 'api', to: ['mocks/**', 'tests/contract/**'] }]);
  assert.ok(ownership.mapProblems(noApi).some((p) => /api must own contracts\/\*\*/.test(p)));
});

const GLOB_ROWS = [['app/**', true], ['alembic.ini', true], ['web/auth/**', true], ['', false], ['/abs/**', false], ['../x/**', false], ['a/../b', false], ['a\\b', false], [' ', false], [null, false], [7, false], ['a\u0000b', false], ['./web/**', false]];
for (const [g, ok] of GLOB_ROWS) test(`validGlob(${JSON.stringify(g)}) is ${ok}`, () => assert.strictEqual(ownership.validGlob(g), ok));

// ------------------------------------------------------------------ loadMap (GF-OWN-1)
test('loadMap on a sealed project returns the sealed breakdown\'s map with no problem', () => {
  const ctx = sealed();
  const r = ops.loadMap(ctx.store);
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(ownership.ownerOfPath(r.map, 'app/db/x.py'), 'db');
});
test('loadMap before the seal has no map and says G1 is not sealed (GF-OWN-1)', () => {
  const ctx = gfProject();
  const r = ops.loadMap(ctx.store);
  assert.strictEqual(r.map, null);
  assert.ok(r.problems.some((p) => p.rule === 'GF-OWN-1' && /not sealed/.test(p.message)));
});
test('loadMap on a record that is not a Greenfield-Senior project has no map and no opinion', () => {
  const { tmpProject } = require('./helpers');
  const plain = tmpProject();
  const r = ops.loadMap(plain.store);
  assert.strictEqual(r.map, null);
  assert.deepStrictEqual(r.problems, []);
});
test('bypass: one byte appended to the approved breakdown.json: loadMap returns GF-OWN-1 and the audit reports it', () => {
  const ctx = sealed();
  const p = Object.keys(bundle.approvedHashes(ctx.store.state())).find((x) => path.posix.basename(x) === 'breakdown.json');
  fs.appendFileSync(path.join(ctx.dir, p), ' ');
  const r = ops.loadMap(ctx.store);
  assert.ok(r.problems.some((x) => x.rule === 'GF-OWN-1' && /breakdown\.json/.test(x.message) && /sealed/.test(x.message)), JSON.stringify(r.problems));
  assert.strictEqual(r.map, null, 'a map whose bytes are not the sealed bytes is not used');
  expectAudit(ctx, 'GF-OWN-1', /breakdown\.json/);
});
test('bypass: an engine task owned by a role in no group, approved through the frozen gates and sealed by a forged seal, is GF-OWN-1', () => {
  const ctx = gfProject();
  const art = sample.build();
  art.plan.tasks[0].owner = 'ai-engineer';
  run(ctx, art, FROZEN);
  const { forgeSeal } = require('./fixtures/gf/forge');
  forgeSeal(ctx);
  expectAudit(ctx, 'GF-OWN-1', /ai-engineer/);
});

// ------------------------------------------------------------------ amend (GF-OWN-5)
test('amend: a reviewer extends the db group\'s globs with a reason and a cited message; the map changes and the audit is clean on ownership', () => {
  const ctx = sealed();
  const r = ops.amend(ctx.store, ctx.config, 'technical-reviewer', goodAmendment(ctx));
  assert.strictEqual(r.event.type, 'gf.ownership.amended');
  assert.deepStrictEqual(r.event.data.from, DB_GLOBS);
  const { map } = ops.loadMap(ctx.store);
  assert.strictEqual(ownership.ownerOfPath(map, 'alembic.ini'), 'db');
  assert.deepStrictEqual(errs(ctx).filter((e) => /^GF-OWN/.test(e.rule)), []);
  assert.strictEqual(project(ctx.store.readEvents()).ownershipAmendments.length, 1);
});
test('amend through the MCP tool, and the show tool reports the effective map', () => {
  const ctx = sealed();
  const out = call('gf_ownership_amend', goodAmendment(ctx), ctx, 'security-reviewer');
  assert.strictEqual(out.group, 'db');
  const shown = call('gf_ownership_show', {}, ctx, 'orchestrator');
  assert.ok(shown.groups.db.globs.includes('alembic.ini'));
  assert.strictEqual(shown.amendments, 1);
});
test('a second amendment chains from the first', () => {
  const ctx = sealed();
  ops.amend(ctx.store, ctx.config, 'technical-reviewer', goodAmendment(ctx));
  const next = goodAmendment(ctx, { from: undefined, to: [...DB_GLOBS, 'alembic.ini', 'pyproject.toml'] });
  const r = ops.amend(ctx.store, ctx.config, 'technical-reviewer', next);
  assert.deepStrictEqual(r.event.data.from, [...DB_GLOBS, 'alembic.ini']);
});

const AMEND_ROWS = [
  ['a non-reviewer', (c) => ({ actor: 'orchestrator' }), /reviewer/],
  ['a group role', (c) => ({ actor: 'backend-engineer' }), /reviewer/],
  ['a reason under 30 characters', (c) => ({ over: { reason: 'too short' } }), /reason/],
  ['no cited message', (c) => ({ over: { message: undefined } }), /message/],
  ['a message that is not recorded', (c) => ({ over: { message: 'msg-nope' } }), /message msg-nope is not a recorded message/],
  ['an unknown group', (c) => ({ over: { group: 'ops' } }), /unknown group ops/],
  ['an empty globs list', (c) => ({ over: { to: [] } }), /at least one glob/],
  ['a glob with ..', (c) => ({ over: { to: [...DB_GLOBS, '../x/**'] } }), /not a valid ownership glob/],
  ['an absolute glob', (c) => ({ over: { to: [...DB_GLOBS, '/etc/**'] } }), /not a valid ownership glob/],
  ['a backslash glob', (c) => ({ over: { to: [...DB_GLOBS, 'a\\b'] } }), /not a valid ownership glob/],
  ['an empty-string glob', (c) => ({ over: { to: [...DB_GLOBS, ''] } }), /not a valid ownership glob/],
  ['a non-string glob', (c) => ({ over: { to: [...DB_GLOBS, 7] } }), /not a valid ownership glob/],
  ['a glob another group owns', (c) => ({ over: { group: 'backend', to: ['app/**', 'web/**'] } }), /both own web\/\*\*/],
  ['dropping a reserved path from its group', (c) => ({ over: { group: 'api', to: ['mocks/**', 'tests/contract/**'] } }), /api must own contracts\/\*\*/],
  ['taking a reserved path', (c) => ({ over: { group: 'security', to: ['app/auth/**', 'contracts/**'] } }), /contracts\/\*\*/],
  ['leaving a pending task uncovered', (c) => ({ over: { to: ['app/db/**', 'seed/**'] } }), /pending task s0-db/],
  ['a stale from', (c) => ({ over: { from: ['app/db/**'] } }), /from/],
];
for (const [name, build, re] of AMEND_ROWS) {
  test(`amend refuses ${name} with GF-OWN-5`, () => {
    const ctx = sealed();
    const spec = build(ctx);
    const input = goodAmendment(ctx, spec.over || {});
    for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
    const before = ctx.store.readEvents().length;
    const err = refusal(() => ops.amend(ctx.store, ctx.config, spec.actor || 'technical-reviewer', input));
    assert.ok(rulesOf(err).includes('GF-OWN-5'), `${err.message}`);
    assert.match(err.message, re);
    assert.strictEqual(ctx.store.readEvents().length, before, 'a refused amendment writes nothing');
  });
}
test('amend before the seal is refused with GF-OWN-1', () => {
  const ctx = gfProject();
  const err = refusal(() => ops.amend(ctx.store, ctx.config, 'technical-reviewer', { group: 'db', to: ['app/db/**'], reason: REASON, message: 'msg-x' }));
  assert.ok(rulesOf(err).includes('GF-OWN-1'));
});

// ------------------------------------------------------------------ rescope (GF-OWN-5)
const RESCOPE = { files: 'app/main.py,app/util.py', reason: 'the app stub also needs a util module' };
test('rescope inside the owner\'s group passes through to the frozen function', () => {
  const ctx = sealed();
  const r = ops.rescope(ctx.store, ctx.config, 's0-app', 'user', RESCOPE);
  assert.deepStrictEqual(ctx.store.state().tasks['s0-app'].files, ['app/main.py', 'app/util.py']);
  assert.strictEqual(r.event.type, 'task.rescoped');
});
const RESCOPE_ROWS = [
  ['a file of another group', 'app/main.py,web/x.js', /web\/x\.js belongs to frontend/],
  ['a file of the db group', 'app/db/models.py', /app\/db\/models\.py belongs to db/],
  ['a path owned by no group', 'pyproject.toml', /pyproject\.toml is owned by no group/],
  ['a path that normalises into another group', 'app/../web/x.js', /web\/x\.js belongs to frontend/],
  ['a path outside the project', '../outside.py', /outside the project/],
  ['a contract path', 'contracts/openapi.json', /contracts\/openapi\.json belongs to api/],
];
for (const [name, files, re] of RESCOPE_ROWS) {
  test(`rescope refuses ${name} with GF-OWN-5 and the frozen call is not made`, () => {
    const ctx = sealed();
    const before = ctx.store.readEvents().length;
    const err = refusal(() => ops.rescope(ctx.store, ctx.config, 's0-app', 'user', { ...RESCOPE, files }));
    assert.ok(rulesOf(err).includes('GF-OWN-5'), err.message);
    assert.match(err.message, re);
    assert.strictEqual(ctx.store.readEvents().length, before);
    assert.deepStrictEqual(ctx.store.state().tasks['s0-app'].files, ['app/main.py', 'app/__init__.py']);
  });
}
test('a rescope of a task that does not exist reaches the frozen function, which refuses it as UNKNOWN_TASK (no crash in the check)', () => {
  const ctx = sealed();
  let err;
  try { ops.rescope(ctx.store, ctx.config, 'no-such-task', 'user', { files: 'app/x.py', reason: RESCOPE.reason }); } catch (e) { err = e; }
  assert.ok(err, 'refused');
  assert.strictEqual(err.code, 'UNKNOWN_TASK', `${err.code}: ${err.message}`);
});
test('the MCP task_rescope tool runs the same check, and a rescope in a project that is not Greenfield-Senior is the frozen behaviour', () => {
  const ctx = sealed();
  const err = refusal(() => call('task_rescope', { task: 's0-app', files: 'web/x.js', reason: RESCOPE.reason }, ctx, 'user'));
  assert.ok(rulesOf(err).includes('GF-OWN-5'));
  call('task_rescope', { task: 's0-app', files: 'app/main.py,app/util.py', reason: RESCOPE.reason }, ctx, 'user');
  assert.deepStrictEqual(ctx.store.state().tasks['s0-app'].files, ['app/main.py', 'app/util.py']);
});

// ------------------------------------------------------------------ bypass: forged events judged by the audit (battery B1)
const forgeAmend = (ctx, actor, data) => F(ctx, 'gf.ownership.amended', actor, { id: 'own-forged', group: 'db', from: DB_GLOBS, to: [...DB_GLOBS, 'alembic.ini'], reason: REASON, message: note(ctx), ...data });
test('bypass: a valid-looking amendment committed through Store.commit by a reviewer audits clean on ownership (it is the legitimate record)', () => {
  const ctx = sealed();
  forgeAmend(ctx, 'technical-reviewer', {});
  assert.deepStrictEqual(errs(ctx).filter((e) => /^GF-OWN/.test(e.rule)), []);
});
const FORGE_ROWS = [
  ['an actor that is not a reviewer', 'technical-designer', {}, /not a reviewer/],
  ['a group role as actor', 'frontend-engineer', {}, /not a reviewer/],
  ['a stale from', 'technical-reviewer', { from: ['app/db/**'] }, /from/],
  ['a message that is not recorded', 'technical-reviewer', { message: 'msg-ghost' }, /message msg-ghost/],
  ['an unknown group', 'technical-reviewer', { group: 'ops' }, /unknown group ops/],
  ['a glob another group owns', 'technical-reviewer', { group: 'backend', from: ['app/**'], to: ['app/**', 'web/**'] }, /both own web\/\*\*/],
  ['dropping contracts/** from api', 'technical-reviewer', { group: 'api', from: ['contracts/**', 'mocks/**', 'tests/contract/**'], to: ['mocks/**', 'tests/contract/**'] }, /api must own contracts\/\*\*/],
  ['a glob with ..', 'technical-reviewer', { to: [...DB_GLOBS, '../x/**'] }, /not a valid ownership glob/],
];
for (const [name, actor, data, re] of FORGE_ROWS) {
  test(`bypass: a forged amendment with ${name} is GF-OWN-5 in the audit`, () => {
    const ctx = sealed();
    forgeAmend(ctx, actor, data);
    expectAudit(ctx, 'GF-OWN-5', re);
  });
}
test('bypass: an amendment whose reason is under 30 characters, forged, is reported as malformed (GF-AUD-1), never merged into the map', () => {
  const ctx = sealed();
  forgeAmend(ctx, 'technical-reviewer', { reason: 'short' });
  expectAudit(ctx, 'GF-AUD-1', /gf\.ownership\.amended is malformed/);
  assert.strictEqual(project(ctx.store.readEvents()).ownershipAmendments.length, 0);
});
test('bypass: a forged task.rescoped that moves a task into another group is GF-OWN-5 in the audit, naming the task and the owner', () => {
  const ctx = sealed();
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: ['web/x.js'], command: null, reason: 'forged move into the frontend area', from: ['app/main.py', 'app/__init__.py'] });
  expectAudit(ctx, 'GF-OWN-5', /s0-app.*web\/x\.js.*belongs to frontend/);
});
test('a rescope that changes only the pinned command (files null) is replayed by the audit without a crash or an ownership error', () => {
  const ctx = sealed();
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command: 'node --test tests/app.test.js', reason: 'the check is narrowed to the app tests', from: ['app/main.py', 'app/__init__.py'] });
  const found = errs(ctx);
  assert.deepStrictEqual(found.filter((e) => /^GF-OWN|^GF-AUD-1/.test(e.rule)), [], JSON.stringify(found));
});
test('bypass: a forged rescope that is inside the owner\'s group audits clean on ownership', () => {
  const ctx = sealed();
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: ['app/main.py', 'app/util.py'], command: null, reason: 'the app stub also needs a util module', from: ['app/main.py', 'app/__init__.py'] });
  assert.deepStrictEqual(errs(ctx).filter((e) => /^GF-OWN/.test(e.rule)), []);
});
test('an amendment moves what a later rescope may do: after db gains alembic.ini, a db task may be rescoped onto it', () => {
  const ctx = sealed();
  ops.amend(ctx.store, ctx.config, 'technical-reviewer', goodAmendment(ctx));
  ops.rescope(ctx.store, ctx.config, 's0-db', 'user', { files: 'app/db/**,migrations/**,alembic.ini', reason: 'the migration runner configuration belongs with the db task' });
  assert.deepStrictEqual(errs(ctx).filter((e) => /^GF-OWN/.test(e.rule)), []);
});
test('the audit of a project that is not Greenfield-Senior has no ownership opinion', () => {
  const { tmpProject } = require('./helpers');
  const plain = tmpProject();
  const r = audit.run(plain.store, plain.config);
  assert.strictEqual(r.enabled, false);
});
