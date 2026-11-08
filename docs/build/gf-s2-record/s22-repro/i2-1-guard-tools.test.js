'use strict';
// I2-1 (security-reviewer, S2.2 critique). Design 18.4, "The runner is the only route (S2.2, H2-1)": in a
// Greenfield-Senior project the runner (gf_run) is the only route by which a group role runs a project command.
// This test asserts that claim for the frozen tools that are NOT in COMMAND_TOOLS but still run project code for any
// role: guard_migration (proof: true) runs the configured seed/upgrade/downgrade commands, and security_matrix runs the
// configured setup and imports the app, each in a git worktree of the real repository whose dependency directories
// (.venv, node_modules, venv, vendor) are symlinks to the real tree, under the frozen windows only (no copy, no hash of
// the real tree). The engine itself tells the owner to run them (`eccode guard migration --proof --actor <owner>`,
// `eccode security matrix --actor <owner>`). It FAILS while the defect exists.
// Run from inside a checkout of the tree under review: node --test <this file>
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const X = require(path.join(ROOT, 'tests/fixtures/gf/close'));
const mcp = require(path.join(ROOT, 'lib/mcp'));
const wrap = require(path.join(ROOT, 'lib/greenfield/wrap'));
const { closeProject, commitAll, F } = X;

const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
const has = (ctx, rel) => fs.existsSync(path.join(ctx.dir, rel));
const tool = (name) => mcp.tools().find((t) => t.name === name);
const call = (name, args, ctx, actor) => tool(name).handler(args, { store: ctx.store, config: ctx.config, actor });
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);

// Project code a group wrote (it runs wherever the tool runs it): an absolute-path write to another group's draft and
// to a frontend path, and a relative-path write into the dependency directory.
const WRITER = [
  'import os, pathlib',
  'REAL = os.path.dirname(os.environ.get("ECCODE_EVIDENCE", "."))',
  'p = pathlib.Path(REAL, ".eccode/drafts/frontend/note.md"); p.parent.mkdir(parents=True, exist_ok=True); p.write_text("from the db group")',
  'pathlib.Path(REAL, "web/seeded.json").write_text("{}")',
  'pathlib.Path(".venv", "seed-marker").write_text("relative write")',
  '',
].join('\n');

function project() {
  const ctx = closeProject();
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'database-engineer', { task: 's0-db' });
  put(ctx, '.gitignore', '.eccode/\n.venv/\n');
  fs.mkdirSync(path.join(ctx.dir, '.venv'), { recursive: true }); // the project's virtual environment (untracked, ignored)
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'seed/seed.py', WRITER); // the db group's seed (seed/** is db's)
  put(ctx, 'app/db/init_db.py', WRITER); // the db group's database init (app/db/** is db's)
  put(ctx, 'app/__init__.py', '');
  put(ctx, 'app/db/__init__.py', '');
  put(ctx, 'app/main.py', 'app = None\n');
  put(ctx, 'migrations/env.py', '# alembic env\n');
  commitAll(ctx, 'the db group\'s seed, init and migrations');
  return ctx;
}
const markers = (ctx) => ['.eccode/drafts/frontend/note.md', 'web/seeded.json', '.venv/seed-marker'].filter((r) => has(ctx, r));
const attempt = (fn) => { try { return { result: fn(), err: null }; } catch (e) { return { result: null, err: e }; } };

test('I2-1: guard_migration with proof, called by a group role, runs the db group\'s seed outside the runner (design 18.4 says the runner is the only route)', () => {
  const ctx = project();
  // The orchestrator's guard configuration (a group role cannot write it; GF-CONF-1 pins it).
  put(ctx, '.eccode/guards.json', JSON.stringify({ migration: { env: { DATABASE_URL: 'sqlite:///{tmp}/db.sqlite' }, databaseEnv: 'DATABASE_URL', seed: 'python3 seed/seed.py', upgrade: 'true', downgrade: 'true' } }));
  const { err } = attempt(() => call('guard_migration', { proof: true, task: 's0-db' }, ctx, 'database-engineer'));
  const ran = markers(ctx);
  assert.deepStrictEqual(ran, [], `the db group's seed ran outside the runner and wrote into the real tree: ${ran.join(', ')} (the tool answered: ${err ? err.message.split('\n')[0] : 'success'})`);
  assert.ok(rulesOf(err).includes('GF-RUN-2'), `guard_migration --proof was not refused to a group role: ${err ? err.message.split('\n')[0] : 'it succeeded'}`);
});

test('I2-1: security_matrix, called by a group role, runs the configured setup (project code) outside the runner', () => {
  const ctx = project();
  put(ctx, '.eccode/behavior.json', JSON.stringify({ app: 'app.main:app', setup: 'python3 -m app.db.init_db', roles: [{ name: 'member', headers: {} }] }));
  put(ctx, '.eccode/security.json', JSON.stringify({ policy: [{ role: 'member', endpoint: 'GET /tasks', ownership: 'none', expected: 'allow' }] }));
  const { err } = attempt(() => call('security_matrix', { task: 's0-db' }, ctx, 'database-engineer'));
  const ran = markers(ctx);
  assert.deepStrictEqual(ran, [], `the db group's init ran outside the runner and wrote into the real tree: ${ran.join(', ')} (the tool answered: ${err ? err.message.split('\n')[0] : 'success'})`);
  assert.ok(rulesOf(err).includes('GF-RUN-2'), `security_matrix was not refused to a group role: ${err ? err.message.split('\n')[0] : 'it succeeded'}`);
});

test('I2-1 control: the same seed through gf_run is caught (the absolute writes fail the run; the relative write stays in the copy)', () => {
  const ctx = project();
  // The plan pins the seed as the db task's check, so the runner accepts it as a plan-pinned command.
  F(ctx, 'task.rescoped', 'user', { task: 's0-db', files: null, command: 'python3 seed/seed.py', reason: 'the db check the plan pins', from: ['app/db/**', 'migrations/**'] });
  const r = call('gf_run', { label: 'seed', command: 'python3 seed/seed.py', task: 's0-db' }, ctx, 'database-engineer');
  assert.strictEqual(r.exitCode, 99, JSON.stringify(r.problems));
  assert.ok(!has(ctx, '.venv/seed-marker'), 'the relative write reached the real tree through the runner');
});
