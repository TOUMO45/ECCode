'use strict';
// S2, T3: GF-OWN-3 (a completion lists only files of the completing actor's group) and GF-OWN-4 (tree attribution:
// every path changed since a base commit belongs to a group that completed a task declaring it). Both judge PATHS
// against the sealed map, not actor strings, so a spoofed actor buys less (design 16.4, F1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const sample = require('./fixtures/gf/sample');
const { gfProject, run, WRAPPED } = require('./fixtures/gf/flow');
const wrap = require('../lib/greenfield/wrap');
const ops = require('../lib/greenfield/ownership-ops');
const ownership = require('../lib/greenfield/ownership');
const audit = require('../lib/greenfield/audit');
const bundle = require('../lib/greenfield/bundle');
const tasksModule = require('../lib/tasks');
const mcp = require('../lib/mcp');

const CLI = path.join(__dirname, '..', 'bin', 'eccode-gf.js');
const F = (ctx, type, actor, data) => ctx.store.commit(type, actor, data);
const errs = (ctx) => audit.run(ctx.store, ctx.config).errors;
const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refusal(fn) { try { fn(); } catch (e) { return e; } throw new Error('expected a refusal, but the call succeeded'); }
const call = (name, args, ctx, actor) => mcp.tools().find((t) => t.name === name).handler(args, { store: ctx.store, config: ctx.config, actor });
const sealed = () => { const ctx = gfProject(); run(ctx, sample.build(), WRAPPED); wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator'); return ctx; };
const mapOf = (ctx) => ops.loadMap(ctx.store).map;
const handoff = (task, from, filesChanged) => ({ task, from, filesChanged, summary: 'done', evidence: [] });

/** Stub the frozen completion for the length of `fn`: records the calls, returns a marker. */
function withFrozenStub(fn) {
  const calls = [];
  const original = tasksModule.complete;
  tasksModule.complete = (...a) => { calls.push(a); return { event: { type: 'task.completed', data: {} } }; };
  try { fn(calls); } finally { tasksModule.complete = original; }
}

// ------------------------------------------------------------------ completionProblems
const COMPLETE_ROWS = [
  ['backend-engineer', ['app/main.py', 'app/__init__.py'], []],
  ['backend-engineer', ['.eccode/drafts/backend/n.md'], []],
  ['database-engineer', ['app/db/models.py', 'migrations/versions/1.py'], []],
  ['backend-engineer', ['web/x.js'], [/web\/x\.js belongs to frontend, not to backend/]],
  ['backend-engineer', ['app/db/models.py'], [/app\/db\/models\.py belongs to db, not to backend/]],
  ['backend-engineer', ['pyproject.toml'], [/pyproject\.toml is owned by no group/]],
  ['backend-engineer', ['app/../web/x.js'], [/web\/x\.js belongs to frontend/]],
  ['backend-engineer', ['../outside.py'], [/outside the project/]],
  ['backend-engineer', ['/etc/passwd'], [/outside the project/]],
  ['backend-engineer', ['app/main.py', 'web/x.js', 'Dockerfile'], [/web\/x\.js belongs to frontend/, /Dockerfile belongs to delivery/]],
  ['technical-reviewer', ['app/main.py'], [/technical-reviewer is in no group/]],
  ['backend-engineer', [42, null], [/not a path/]],
];
for (const [actor, files, wants] of COMPLETE_ROWS) {
  test(`completionProblems(${actor}, ${JSON.stringify(files)}) is ${wants.length ? 'refused (GF-OWN-3)' : 'clean'}`, () => {
    const ctx = sealed();
    const got = ops.completionProblems(mapOf(ctx), actor, files);
    if (!wants.length) assert.deepStrictEqual(got, []);
    else {
      assert.ok(got.every((p) => p.rule === 'GF-OWN-3'));
      for (const re of wants) assert.ok(got.some((p) => re.test(p.message)), `${re} in ${JSON.stringify(got.map((p) => p.message))}`);
    }
  });
}

// ------------------------------------------------------------------ the wrapped completion
test('GF-OWN-3 positive: a completion of own files reaches the frozen function with the same arguments', () => {
  const ctx = sealed();
  const h = handoff('s0-app', 'backend-engineer', ['app/main.py']);
  withFrozenStub((calls) => {
    wrap.taskComplete(ctx.store, ctx.config, 's0-app', 'backend-engineer', h);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].slice(2), ['s0-app', 'backend-engineer', h]);
  });
});
test('GF-OWN-3 negative: a completion listing another group\'s file is refused and the frozen function is not called', () => {
  const ctx = sealed();
  withFrozenStub((calls) => {
    const before = ctx.store.readEvents().length;
    const err = refusal(() => wrap.taskComplete(ctx.store, ctx.config, 's0-app', 'backend-engineer', handoff('s0-app', 'backend-engineer', ['app/main.py', 'web/x.js'])));
    assert.ok(rulesOf(err).includes('GF-OWN-3'), err.message);
    assert.match(err.message, /web\/x\.js belongs to frontend, not to backend/);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(ctx.store.readEvents().length, before);
  });
});
test('GF-OWN-3: a handoff without a files list, or not an object, is left to the frozen validation (no crash here)', () => {
  const ctx = sealed();
  withFrozenStub((calls) => {
    wrap.taskComplete(ctx.store, ctx.config, 's0-app', 'backend-engineer', { task: 's0-app', from: 'backend-engineer' });
    wrap.taskComplete(ctx.store, ctx.config, 's0-app', 'backend-engineer', null);
    assert.strictEqual(calls.length, 2);
  });
});
test('GF-OWN-3: with the ownership map untrusted (a byte added to the sealed breakdown), a completion is refused with GF-OWN-1', () => {
  const ctx = sealed();
  const p = Object.keys(bundle.approvedHashes(ctx.store.state())).find((x) => path.posix.basename(x) === 'breakdown.json');
  fs.appendFileSync(path.join(ctx.dir, p), ' ');
  withFrozenStub((calls) => {
    const err = refusal(() => wrap.taskComplete(ctx.store, ctx.config, 's0-app', 'backend-engineer', handoff('s0-app', 'backend-engineer', ['app/main.py'])));
    assert.ok(rulesOf(err).includes('GF-OWN-1'));
    assert.strictEqual(calls.length, 0);
  });
});
test('on a record that is not a Greenfield-Senior project the wrapped completion is the frozen one', () => {
  const { tmpProject } = require('./helpers');
  const plain = tmpProject();
  withFrozenStub((calls) => {
    wrap.taskComplete(plain.store, plain.config, 'x', 'backend-engineer', handoff('x', 'backend-engineer', ['anything/at/all.py']));
    assert.strictEqual(calls.length, 1);
  });
});
test('the MCP task_complete tool runs the same check before the frozen validation', () => {
  const ctx = sealed();
  const err = refusal(() => call('task_complete', { task: 's0-app', handoff: handoff('s0-app', 'backend-engineer', ['web/x.js']) }, ctx, 'backend-engineer'));
  assert.ok(rulesOf(err).includes('GF-OWN-3'), err.message);
});

// ------------------------------------------------------------------ bypass: a forged completion judged by the audit
test('bypass: a forged task.completed listing a foreign file is GF-OWN-3 in the audit, naming the task, the actor and the file', () => {
  const ctx = sealed();
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.completed', 'backend-engineer', { task: 's0-app', handoffId: 'ho-forged', filesChanged: ['app/main.py', 'web/x.js'] });
  const found = errs(ctx).filter((e) => e.rule === 'GF-OWN-3');
  assert.ok(found.some((e) => /s0-app/.test(e.message) && /backend-engineer/.test(e.message) && /web\/x\.js belongs to frontend/.test(e.message)), JSON.stringify(found));
});
test('bypass: a completion forged by one group of ANOTHER group\'s task, listing the forger\'s own files, is GF-OWN-3 (the task owner is checked, not only the actor)', () => {
  const ctx = sealed();
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-web' });
  F(ctx, 'task.completed', 'backend-engineer', { task: 's0-web', handoffId: 'ho-x', filesChanged: ['app/main.py'] });
  assert.ok(errs(ctx).some((e) => e.rule === 'GF-OWN-3' && /s0-web was completed by backend-engineer, but it is owned by frontend-engineer/.test(e.message)), JSON.stringify(errs(ctx).map((e) => e.message)));
});
test('bypass: a forged completion of own files audits clean on ownership', () => {
  const ctx = sealed();
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.completed', 'backend-engineer', { task: 's0-app', handoffId: 'ho-ok', filesChanged: ['app/main.py'] });
  assert.deepStrictEqual(errs(ctx).filter((e) => /^GF-OWN/.test(e.rule)), []);
});
test('bypass: the audit judges a completion against the map in force at that event, not today\'s: a later amendment does not excuse it', () => {
  const ctx = sealed();
  F(ctx, 'task.claimed', 'database-engineer', { task: 's0-db' });
  F(ctx, 'task.completed', 'database-engineer', { task: 's0-db', handoffId: 'ho-db', filesChanged: ['alembic.ini'] });
  const note = require('../lib/greenfield/messages').send(ctx.store, ctx.config, 'database-engineer', { to: ['orchestrator'], kind: 'blocker', subject: 'alembic.ini is unowned', body: 'The migration runner needs alembic.ini at the project root.' }).id;
  ops.amend(ctx.store, ctx.config, 'technical-reviewer', { group: 'db', to: ['app/db/**', 'migrations/**', 'seed/**', 'alembic.ini'], reason: 'the db group needs the alembic configuration file to run migrations', message: note });
  assert.strictEqual(ownership.ownerOfPath(mapOf(ctx), 'alembic.ini'), 'db', 'today the db group owns it');
  assert.ok(errs(ctx).some((e) => e.rule === 'GF-OWN-3' && /alembic\.ini is owned by no group/.test(e.message)), 'but it did not when the task was completed');
});

// ------------------------------------------------------------------ attribution (GF-OWN-4)
function done(ctx, role, task, filesChanged) {
  F(ctx, 'task.claimed', role, { task });
  F(ctx, 'task.completed', role, { task, handoffId: `ho-${task}`, filesChanged });
}
const attrib = (ctx, changed) => ops.attribution({ map: mapOf(ctx), tasks: Object.values(ctx.store.state().tasks), changed });

test('GF-OWN-4 positive: every changed path declared by a completed task of the owning group is attributed', () => {
  const ctx = sealed();
  done(ctx, 'backend-engineer', 's0-app', ['app/main.py']);
  done(ctx, 'database-engineer', 's0-db', ['app/db/models.py', 'migrations/versions/1.py']);
  assert.deepStrictEqual(attrib(ctx, ['app/main.py', 'app/db/models.py', 'migrations/versions/1.py', '.eccode/events.jsonl']), []);
});
const ATTR_ROWS = [
  ['a changed path no task declares', (c) => done(c, 'backend-engineer', 's0-app', ['app/main.py']), ['app/main.py', 'app/__init__.py'], /app\/__init__\.py was changed but no completed task of backend declares it/],
  ['a path declared only by a task of another group', (c) => done(c, 'frontend-engineer', 's0-web', ['app/main.py']), ['app/main.py'], /app\/main\.py was changed but no completed task of backend declares it/],
  ['a path owned by no group', (c) => done(c, 'backend-engineer', 's0-app', ['app/main.py']), ['app/main.py', 'pyproject.toml'], /pyproject\.toml was changed and is owned by no group/],
  ['a task that was claimed but never completed', (c) => F(c, 'task.claimed', 'backend-engineer', { task: 's0-app' }), ['app/main.py'], /app\/main\.py was changed but no completed task of backend declares it/],
  ['a path the completed task lists but its globs do not cover', (c) => done(c, 'backend-engineer', 's0-app', ['app/routes/x.py']), ['app/routes/x.py'], /app\/routes\/x\.py was changed but no completed task of backend declares it/],
  ['a path outside the project', () => {}, ['../escape.txt'], /\.\.\/escape\.txt is outside the project/],
  ['a path that normalises into another group', (c) => done(c, 'backend-engineer', 's0-app', ['app/main.py']), ['app/../web/x.js'], /web\/x\.js was changed but no completed task of frontend declares it/],
];
for (const [name, setup, changed, re] of ATTR_ROWS) {
  test(`GF-OWN-4 negative: ${name} is reported`, () => {
    const ctx = sealed();
    setup(ctx);
    const got = attrib(ctx, changed);
    assert.ok(got.length >= 1 && got.every((p) => p.rule === 'GF-OWN-4'), JSON.stringify(got));
    assert.ok(got.some((p) => re.test(p.message)), `${re} in ${JSON.stringify(got.map((p) => p.message))}`);
  });
}
test('GF-OWN-4: with no usable map the result is the GF-OWN-1 problem, never a clean attribution', () => {
  const ctx = gfProject();
  const got = ops.attribution({ map: null, tasks: [], changed: ['app/main.py'] });
  assert.ok(got.length === 1 && got[0].rule === 'GF-OWN-1');
  void ctx;
});

// ------------------------------------------------------------------ bypass: a real working tree
function gitIn(dir, ...args) { return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim(); }
function cli(ctx, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', ctx.dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
test('bypass: a real tree: a frontend file changed by a backend task and not declared is found by eccode-gf attribute (exit 2); once declared by a frontend task it is clean (exit 0)', () => {
  const ctx = sealed();
  gitIn(ctx.dir, 'add', '-A');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'sealed');
  const base = gitIn(ctx.dir, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(ctx.dir, 'app'), { recursive: true });
  fs.mkdirSync(path.join(ctx.dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'app/main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(ctx.dir, 'web/x.js'), 'x\n');
  done(ctx, 'backend-engineer', 's0-app', ['app/main.py']);
  const bad = cli(ctx, 'attribute', '--base', base);
  assert.strictEqual(bad.code, 2, bad.out);
  assert.match(bad.out, /web\/x\.js was changed but no completed task of frontend declares it/);
  assert.doesNotMatch(bad.out, /app\/main\.py was changed/);
  done(ctx, 'frontend-engineer', 's0-web', ['web/x.js']);
  const good = cli(ctx, 'attribute', '--base', base);
  assert.strictEqual(good.code, 0, good.out);
  assert.match(good.out, /attributed/);
});
test('the MCP gf_attribute tool answers the same, and a base that is not a commit is one problem, not a crash', () => {
  const ctx = sealed();
  gitIn(ctx.dir, 'add', '-A');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'sealed');
  fs.mkdirSync(path.join(ctx.dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'web/x.js'), 'x\n');
  const r = call('gf_attribute', { base: 'HEAD' }, ctx, 'orchestrator');
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => /web\/x\.js was changed/.test(p.message)));
  const bad = call('gf_attribute', { base: 'no-such-commit' }, ctx, 'orchestrator');
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.rule === 'GF-OWN-4' && /cannot list the changes since no-such-commit/.test(p.message)));
});
void ownership; void audit;
