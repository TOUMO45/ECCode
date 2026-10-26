'use strict';
// Breaking-change and migration safety rules at task completion.
const test = require('node:test');
const assert = require('node:assert');
const gates = require('../lib/gates');
const tasks = require('../lib/tasks');
const compat = require('../lib/compat');
const { tmpProject, write, approveThroughPlan, samplePlan, task, passCheck, handoffFor, expectCode } = require('./helpers');

const API = 'src/server/api.js';
const BASE_API = [
  "exports.createTicket = (req) => req;",
  "exports.listTickets = () => [];",
  "app.get('/tickets', list);",
  "app.post('/tickets', create);",
].join('\n') + '\n';

function project(level, planTweak) {
  const plan = samplePlan();
  if (planTweak) planTweak(plan);
  const ctx = tmpProject({ configOverrides: { lean: { level } } });
  approveThroughPlan(ctx, plan);
  write(ctx.dir, API, BASE_API);
  write(ctx.dir, 'migrations/001_init.sql', 'CREATE TABLE tickets (id int);\n');
  require('child_process').execFileSync('git', ['add', '-A'], { cwd: ctx.dir });
  require('child_process').execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: ctx.dir });
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  return ctx;
}

function completeApi(ctx, files, extra = {}) {
  const ev = passCheck(ctx.store, 'backend-engineer');
  return tasks.complete(ctx.store, ctx.config, 'api', 'backend-engineer', {
    ...handoffFor('api', 'backend-engineer', [ev.id], files),
    testsNotNeeded: 'compat fixture; covered by the phase contract tests',
    ...extra,
  });
}

test('routes are read from express-style calls and decorators', () => {
  assert.deepStrictEqual(
    compat.routesIn('a.py', "@app.get('/items')\ndef x(): pass\n@bp.route('/admin')\ndef y(): pass\n"),
    ['ANY /admin', 'GET /items'],
  );
  assert.deepStrictEqual(compat.routesIn('a.js', BASE_API), ['GET /tickets', 'POST /tickets']);
});

test('removing a public export or route must be declared with the detected name', () => {
  const plan = (p) => p.tasks.push(task('mig', 'backend-engineer', ['migrations/**'], []));
  const ctx = project('full', plan);
  tasks.claim(ctx.store, ctx.config, 'api', 'backend-engineer');
  write(ctx.dir, API, "exports.createTicket = (req) => req;\napp.post('/tickets', create);\n"); // listTickets + GET gone
  let err = expectCode(() => completeApi(ctx, [API]), 'INVALID_HANDOFF');
  assert.match(err.message, /compat: public definition "listTickets" removed/);
  assert.match(err.message, /compat: HTTP route "GET \/tickets" removed/);
  // a declaration with the wrong name is refused too
  err = expectCode(() => completeApi(ctx, [API], { breakingChanges: [{ kind: 'export', name: 'listTickets', reason: 'superseded by search endpoint' }] }), 'INVALID_HANDOFF');
  assert.match(err.message, /cannot see \(export "listTickets"\)/);
  completeApi(ctx, [API], {
    breakingChanges: [
      { kind: 'export', name: `${API}#listTickets`, reason: 'superseded by the search endpoint', migration: 'call POST /tickets/search instead' },
      { kind: 'route', name: 'GET /tickets', reason: 'superseded by the search endpoint', migration: 'call POST /tickets/search instead' },
    ],
  });
  const lean = ctx.store.state().tasks.api.lean;
  assert.deepStrictEqual(lean.breaking.map((b) => b.kind).sort(), ['export', 'route']);
  assert.strictEqual(lean.declaredBreaking, 2);
});

test('editing an applied migration or shipping destructive SQL must be declared', () => {
  const ctx = project('full', (p) => p.tasks.push(task('mig', 'backend-engineer', ['migrations/**'], [])));
  tasks.claim(ctx.store, ctx.config, 'mig', 'backend-engineer');
  write(ctx.dir, 'migrations/001_init.sql', 'CREATE TABLE tickets (id int, user int);\n'); // edited applied migration
  write(ctx.dir, 'migrations/002_cleanup.sql', 'DROP TABLE audit_log;\n'); // destructive new one
  const ev = passCheck(ctx.store, 'backend-engineer');
  const complete = (extra = {}) => tasks.complete(ctx.store, ctx.config, 'mig', 'backend-engineer', {
    ...handoffFor('mig', 'backend-engineer', [ev.id], ['migrations/001_init.sql', 'migrations/002_cleanup.sql']),
    testsNotNeeded: 'SQL files; validated by the migration runner in CI',
    ...extra,
  });
  const err = expectCode(complete, 'INVALID_HANDOFF');
  assert.match(err.message, /migration migrations\/001_init\.sql was edited/);
  assert.match(err.message, /destructive SQL \(DROP TABLE\)/);
  complete({
    breakingChanges: [
      { kind: 'migration', name: 'migrations/001_init.sql', reason: 'never released; 001 only exists on this branch' },
      { kind: 'destructive-migration', name: 'migrations/002_cleanup.sql', reason: 'audit_log replaced by the events table', migration: 'data copied by 002 before the drop' },
    ],
  });
});

test('the refactor track refuses breaking changes even when declared', () => {
  const works = require('../lib/works');
  const { deliver } = require('../lib/delivery');
  const ctx = project('full');
  // finish w1 quickly: no tasks needed beyond what the sample plan requires
  for (const [id, owner, file] of [['api', 'backend-engineer', 'src/server/app.js'], ['ui', 'frontend-engineer', 'src/web/b.js'], ['tests', 'test-engineer', 'tests/c.test.js']]) {
    tasks.claim(ctx.store, ctx.config, id, owner);
    write(ctx.dir, file, `// ${id}\n`);
    const ev = passCheck(ctx.store, owner);
    tasks.complete(ctx.store, ctx.config, id, owner, { ...handoffFor(id, owner, [ev.id], [file]), testsNotNeeded: 'fixture change, covered by phase checks' });
  }
  gates.submit(ctx.store, ctx.config, 'phase:core', 'delivery-lead');
  let ev = passCheck(ctx.store, 'technical-reviewer');
  gates.recordReview(ctx.store, ctx.config, 'phase:core', 'technical-reviewer', require('./helpers').approval([[`ev:${ev.id}`]]));
  gates.startGate(ctx.store, ctx.config, 'verification', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/v.md', '# V\nok\n');
  gates.submit(ctx.store, ctx.config, 'verification', 'delivery-lead', { artifacts: ['.eccode/artifacts/v.md', 'src/server/app.js', 'src/web/b.js', 'tests/c.test.js', API, 'migrations/001_init.sql'] });
  ev = passCheck(ctx.store, 'security-reviewer');
  gates.recordReview(ctx.store, ctx.config, 'verification', 'security-reviewer', require('./helpers').approval([[`ev:${ev.id}`, 'artifact:.eccode/artifacts/v.md']]));
  deliver(ctx.store, 'delivery-lead');
  require('child_process').execFileSync('git', ['add', '-A'], { cwd: ctx.dir });
  require('child_process').execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'w1'], { cwd: ctx.dir });

  const behavior = 'node -e "process.exit(0)" # suite';
  works.startWork(ctx.store, ctx.config, 'orchestrator', { track: 'refactor', title: 'Tidy the ticket API', behavior });
  require('../lib/evidence').runCommand(ctx.store, 'delivery-lead', { label: 'before', command: behavior });
  gates.startGate(ctx.store, ctx.config, 'plan', 'orchestrator');
  write(ctx.dir, '.eccode/artifacts/rplan.json', JSON.stringify({
    phases: [{ id: 'tidy', name: 'Tidy', goal: 'tidy the ticket api internals', acceptanceCriteria: ['behavior unchanged'] }],
    tasks: [task('tidy', 'backend-engineer', ['src/server/**'], [], 'tidy')],
  }));
  gates.submit(ctx.store, ctx.config, 'plan', 'delivery-lead', { artifacts: ['.eccode/artifacts/rplan.json'] });
  gates.recordReview(ctx.store, ctx.config, 'plan', 'technical-reviewer', require('./helpers').approval([['artifact:.eccode/artifacts/rplan.json']]));
  gates.startGate(ctx.store, ctx.config, 'phase:tidy', 'orchestrator');
  tasks.claim(ctx.store, ctx.config, 'tidy', 'backend-engineer');
  write(ctx.dir, API, BASE_API.replace("exports.listTickets = () => [];\n", '')); // removes a public export
  const ev2 = passCheck(ctx.store, 'backend-engineer');
  const err = expectCode(() => tasks.complete(ctx.store, ctx.config, 'tidy', 'backend-engineer', {
    ...handoffFor('tidy', 'backend-engineer', [ev2.id], [API]),
    testsNotNeeded: 'refactor only, behavior suite covers it',
    breakingChanges: [{ kind: 'export', name: `${API}#listTickets`, reason: 'declared, but refactors must not break' }],
  }), 'INVALID_HANDOFF');
  assert.match(err.message, /refactor track preserves behavior/);
});

test('strict requires plan pre-approval; lite only warns', () => {
  const strict = project('strict', (p) => (p.tasks[0].allowedBreaking = []));
  tasks.claim(strict.store, strict.config, 'api', 'backend-engineer');
  write(strict.dir, API, BASE_API.replace("exports.listTickets = () => [];\n", ''));
  write(strict.dir, 'src/server/api.test.js', 'test\n');
  const err = expectCode(() => completeApi(strict, [API, 'src/server/api.test.js'], {
    breakingChanges: [{ kind: 'export', name: `${API}#listTickets`, reason: 'superseded by the search endpoint' }],
  }), 'INVALID_HANDOFF');
  assert.match(err.message, /not pre-approved in the plan \(task\.allowedBreaking\)/);

  const lite = project('lite');
  tasks.claim(lite.store, lite.config, 'api', 'backend-engineer');
  write(lite.dir, API, BASE_API.replace("exports.listTickets = () => [];\n", ''));
  completeApi(lite, [API]);
  const lean = lite.store.state().tasks.api.lean;
  assert.ok(lean.warnings.some((w) => w.includes('listTickets')));
  assert.deepStrictEqual(lean.breaking, [{ kind: 'export', name: `${API}#listTickets` }]);
});

const fsx = require('fs');
const osx = require('os');
const pathx = require('path');
const scratch = () => fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'eccode-compat-'));

test('test helpers are not public API: removing one is not a breaking change', () => {
  const dir = scratch();
  write(dir, 'tests/utils/factories.py', 'def random_user():\n    return 1\n');
  write(dir, 'src/app.py', 'def run():\n    return 1\n');
  const base = compat.snapshot(dir, ['**']);
  write(dir, 'tests/utils/factories.py', '# moved to tests/fixtures\n');
  write(dir, 'src/app.py', '# gone\n');
  assert.deepStrictEqual(compat.detect(dir, base, ['**']).map((d) => d.name), ['src/app.py#run']);
});

test('a new Python migration is destructive when its upgrade drops data, not when its downgrade does', () => {
  const dir = scratch();
  const base = compat.snapshot(dir, ['**']);
  write(dir, 'mealie/alembic/versions/001_add.py', 'from alembic import op\n\ndef upgrade():\n    op.add_column("users", sa.Column("x"))\n\n\ndef downgrade():\n    op.drop_column("users", "x")\n    op.execute("DROP TABLE tmp")\n');
  write(dir, 'mealie/alembic/versions/002_drop.py', 'from alembic import op\n\ndef upgrade():\n    with op.batch_alter_table("users") as batch_op:\n        batch_op.drop_column("x")\n\n\ndef downgrade():\n    pass\n');
  write(dir, 'mealie/alembic/versions/003_table.py', 'def upgrade():\n    op.drop_table("audit")\n');
  write(dir, 'shop/migrations/0004_remove.py', 'from django.db import migrations\n\nclass Migration(migrations.Migration):\n    operations = [migrations.RemoveField(model_name="order", name="note")]\n');
  write(dir, 'migrations/005_cleanup.sql', 'DROP TABLE audit_log;\n');
  const found = compat.detect(dir, base, ['**']).filter((d) => d.kind === 'destructive-migration');
  assert.deepStrictEqual(found.map((d) => d.name).sort(), ['mealie/alembic/versions/002_drop.py', 'mealie/alembic/versions/003_table.py', 'migrations/005_cleanup.sql', 'shop/migrations/0004_remove.py']);
  assert.match(found.find((d) => d.name.endsWith('002_drop.py')).detail, /drop_column/);
});

test('a definition moved to another file is a move, reported, not a removed export', () => {
  const dir = scratch();
  write(dir, 'src/a.py', 'def helper():\n    return 1\n\n\ndef gone():\n    return 2\n');
  write(dir, 'src/c.py', 'def gone():\n    return 3\n');
  const base = compat.snapshot(dir, ['**']);
  write(dir, 'src/a.py', '# split up\n');
  write(dir, 'src/util/new.py', 'def helper():\n    return 1\n');
  assert.deepStrictEqual(compat.detect(dir, base, ['**']).map((d) => d.name), ['src/a.py#gone'], 'gone stays a removal: c.py had its own before');
  assert.deepStrictEqual(compat.detectAll(dir, base, ['**']).moved, [{ name: 'helper', from: 'src/a.py', to: 'src/util/new.py' }]);
});

test('a migration is a file a migration tool would run: versioned or dated, or under alembic/versions', () => {
  const dir = scratch();
  for (const f of ['mealie/services/migrations/paprika.py', 'mealie/services/migrations/utils/migration_helpers.py', 'shop/migrations/__init__.py', 'shop/migrations/0004_remove.py', 'db/migrate/20240101_add_users.rb', 'prisma/migrations/20240101_init/migration.sql', 'mealie/alembic/versions/b3f1c9a27d84_add.py', 'sql/migrations/V2__add.sql', 'migrations/001_init.sql']) write(dir, f, '-- x\n');
  assert.deepStrictEqual(Object.keys(compat.snapshot(dir, ['**']).migrations).sort(), ['db/migrate/20240101_add_users.rb', 'mealie/alembic/versions/b3f1c9a27d84_add.py', 'migrations/001_init.sql', 'prisma/migrations/20240101_init/migration.sql', 'shop/migrations/0004_remove.py', 'sql/migrations/V2__add.sql']);
});

test('a standalone Python script is not public API: its definitions can go; a package module or an imported script cannot', () => {
  const dir = scratch();
  const MAIN = 'def transform():\n    return 1\n\n\ndef main():\n    transform()\n\n\nif __name__ == "__main__":\n    main()\n';
  write(dir, 'dev/scripts/convert_seed.py', MAIN);
  write(dir, 'pkg/__init__.py', '');
  write(dir, 'pkg/cli.py', MAIN);
  write(dir, 'tools/shared.py', MAIN);
  write(dir, 'tools/report.py', 'from shared import transform\n\nif __name__ == "__main__":\n    transform()\n');
  const base = compat.snapshot(dir, ['**']);
  assert.ok(!('dev/scripts/convert_seed.py' in base.exports), 'a script outside any package, imported by nothing, has no import surface');
  for (const f of ['dev/scripts/convert_seed.py', 'pkg/cli.py', 'tools/shared.py']) write(dir, f, '# gone\n');
  assert.deepStrictEqual(compat.detect(dir, base, ['**']).map((d) => d.name).sort(), ['pkg/cli.py#main', 'pkg/cli.py#transform', 'tools/shared.py#main', 'tools/shared.py#transform']);
});

test('routes are read on routers of any name: user_router, item_router, userRouter', () => {
  const py = '@user_router.get("/refresh")\nasync def refresh():\n    pass\n\n@item_router.post("/items/{id}")\ndef add():\n    pass\n\n@cache.get("key")\ndef cached():\n    pass\n';
  assert.deepStrictEqual(compat.routesIn('mealie/routes/auth.py', py), ['GET /refresh', 'POST /items/{id}']);
  const js = "userRouter.get('/users', list);\nadmin_router.delete('/users/:id', drop);\nconfig.get('/not-a-route');\n";
  assert.deepStrictEqual(compat.routesIn('src/routes.js', js), ['DELETE /users/:id', 'GET /users']);
});

test('a script is judged by importers anywhere in the project, across multi-line imports, and a file turning script keeps its definitions', () => {
  const dir = scratch();
  const MAIN = 'def transform():\n    return 1\n\n\nif __name__ == "__main__":\n    transform()\n';
  write(dir, 'tools/shared.py', MAIN);
  write(dir, 'tools/report.py', 'from shared import transform\n');
  // Only the task's file is in scope; its importer is not.
  assert.deepStrictEqual(compat.snapshot(dir, ['tools/shared.py']).exports, { 'tools/shared.py': ['transform'] });
  write(dir, 'ns/seed.py', MAIN);
  write(dir, 'app/use.py', 'from ns import (\n    seed,\n)\n');
  assert.ok('ns/seed.py' in compat.snapshot(dir, ['ns/**']).exports, 'a parenthesised import names the module');
  write(dir, 'lib/plain.py', 'def util():\n    return 1\n');
  const base = compat.snapshot(dir, ['lib/**']);
  write(dir, 'lib/plain.py', 'def util():\n    return 1\n\n\nif __name__ == "__main__":\n    util()\n');
  assert.deepStrictEqual(compat.detect(dir, base, ['lib/**']), [], 'gaining a main guard removes nothing');
});
