'use strict';
// S2.1 (the owner's structural redesign of GF-RUN-2, 2026-11-08; design 18.0 and 18.4): the runner executes a project
// command in a throwaway copy of the tree and copies back only the files the caller's group owns; it hashes every file
// of the REAL tree before and after the run, without asking git, and fails the run on any change there outside the
// caller's group, anything inside .git included. Every evasion of rounds 5 and 6 is a permanent row here (named by its
// finding id). Positive, negative and bypass rows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('./fixtures/gf/close');
const runner = require('../lib/greenfield/runner');
const { closeProject, commitAll, F, git } = X;

const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };
const read = (ctx, rel) => { try { return fs.readFileSync(path.join(ctx.dir, rel), 'utf8'); } catch { return null; } };
const exists = (ctx, rel) => { try { fs.lstatSync(path.join(ctx.dir, rel)); return true; } catch { return false; } };
const head = (ctx) => git(ctx.dir, 'rev-parse', 'HEAD');
const msgs = (r) => (r.problems || []).map((p) => `${p.rule} ${p.message}`).join(' | ');
const show = (r) => JSON.stringify({ status: r.status, exitCode: r.exitCode, problems: r.problems, copiedBack: r.copiedBack, discarded: r.discarded, tail: r.outputTail });
function team() {
  const ctx = closeProject();
  require('../lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  F(ctx, 'task.claimed', 'frontend-engineer', { task: 's0-web' });
  return ctx;
}
// REAL is the real tree: the frozen evidence runner gives every command ECCODE_EVIDENCE, the real record's path.
const PY = 'import os, subprocess\nREAL = os.path.dirname(os.environ["ECCODE_EVIDENCE"])\ndef git(*a):\n    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], check=True)\n';
/** A backend page and a frontend page, a test whose body is `body`, committed; then the run. */
function runTest(body, { role = 'backend-engineer', files = {}, links = {} } = {}) {
  const ctx = team();
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'app/main.py', 'print("app")\n');
  for (const [k, v] of Object.entries(files)) put(ctx, k, v);
  for (const [k, v] of Object.entries(links)) { fs.mkdirSync(path.dirname(path.join(ctx.dir, k)), { recursive: true }); fs.symlinkSync(typeof v === 'function' ? v(ctx) : v, path.join(ctx.dir, k)); }
  put(ctx, 'tests/test_s21.py', `${PY}\ndef test_s21():\n${body.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  commitAll(ctx, 'two pages and a test');
  const before = { head: head(ctx), web: read(ctx, 'web/index.html'), app: read(ctx, 'app/main.py'), exclude: read(ctx, '.git/info/exclude') };
  const r = runner.run(ctx.store, ctx.config, role, { label: 's21', command: 'pytest -q tests/test_s21.py' });
  return { ctx, r, before };
}

// ------------------------------------------------------------------ the copy: only the caller's group's files come back
test('S2.1 positive: a run that changes and adds the caller\'s own group\'s files gets them back in the real tree', () => {
  const { ctx, r } = runTest('open("app/main.py", "a").write("# own\\n")\nopen("app/new.py", "w").write("x = 1\\n")');
  assert.strictEqual(r.status, 'passed', show(r));
  assert.match(read(ctx, 'app/main.py'), /# own/);
  assert.strictEqual(read(ctx, 'app/new.py'), 'x = 1\n');
  assert.deepStrictEqual([...r.copiedBack].sort(), ['app/main.py', 'app/new.py'], show(r));
});
test('S2.1 positive: a claimed file of the caller\'s group that the run deletes is deleted in the real tree', () => {
  const { ctx, r } = runTest('os.remove("app/__init__.py")', { files: { 'app/__init__.py': '' } });
  assert.strictEqual(r.status, 'passed', show(r));
  assert.strictEqual(exists(ctx, 'app/__init__.py'), false);
  assert.ok(r.copiedBack.includes('app/__init__.py'), show(r));
});
test('S2.1 negative: what comes back is inside the frozen integrity window: a tracked file of the group outside the claimed task fails the run', () => {
  const { r } = runTest('os.remove("app/old.py")', { files: { 'app/old.py': 'old = 1\n' } });
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.match(r.outputTail, /INTEGRITY: the command changed tracked files outside backend-engineer's claimed ownership: app\/old\.py/);
});
test('F2-1 (round 5): a relative write to another group\'s tracked file stays in the copy: the real file is unchanged and the write is reported as discarded', () => {
  const { ctx, r, before } = runTest('open("web/index.html", "a").write("<!-- injected by backend -->")');
  assert.strictEqual(read(ctx, 'web/index.html'), before.web, show(r));
  assert.ok(r.discarded.some((d) => d.path === 'web/index.html' && d.owner === 'frontend'), show(r));
});
test('S2.1 negative (round 5 bypass): a new file in another group\'s area stays in the copy', () => {
  const { ctx, r } = runTest('open("web/evil.js", "w").write("x")');
  assert.strictEqual(exists(ctx, 'web/evil.js'), false, show(r));
  assert.ok(r.discarded.some((d) => d.path === 'web/evil.js'), show(r));
});
test('S2.1 negative: a role in no group gets nothing back from the copy', () => {
  const { ctx, r, before } = runTest('open("app/main.py", "a").write("# reviewer\\n")', { role: 'technical-reviewer' });
  assert.strictEqual(read(ctx, 'app/main.py'), before.app, show(r));
  assert.deepStrictEqual(r.copiedBack, [], show(r));
  assert.ok(r.discarded.some((d) => d.path === 'app/main.py'), show(r));
});
test('S2.1: the tools\' caches stay in the copy and are not listed', () => {
  const { ctx, r } = runTest('assert True');
  assert.strictEqual(r.status, 'passed', show(r));
  assert.strictEqual(exists(ctx, '.pytest_cache'), false, 'pytest\'s cache stayed in the copy');
  assert.ok(!r.discarded.some((d) => /pytest_cache|__pycache__/.test(d.path)), show(r));
});
test('S2.1 negative: a relative write into .git or .eccode stays in the copy (the copy has neither)', () => {
  const { ctx, r } = runTest('os.makedirs(".git", exist_ok=True)\nopen(".git/planted", "w").write("x")\nos.makedirs(".eccode", exist_ok=True)\nopen(".eccode/planted", "w").write("x")');
  assert.strictEqual(exists(ctx, '.git/planted'), false, show(r));
  assert.strictEqual(exists(ctx, '.eccode/planted'), false, show(r));
});
test('S2.1 negative: a plan-pinned command runs in the copy too: the caller\'s file comes back, another group\'s does not', () => {
  const ctx = team();
  put(ctx, 'web/index.html', '<h1>Tasks</h1>\n');
  put(ctx, 'app/main.py', 'print("app")\n');
  commitAll(ctx, 'two pages');
  const command = 'echo backend >> web/index.html && echo "# own" >> app/main.py';
  F(ctx, 'task.rescoped', 'user', { task: 's0-app', files: null, command, reason: 'a pinned command that writes two groups\' files', from: ['app/main.py', 'app/__init__.py'] });
  const r = runner.run(ctx.store, ctx.config, 'backend-engineer', { label: 'pinned', command });
  assert.strictEqual(r.status, 'passed', show(r));
  assert.strictEqual(read(ctx, 'web/index.html'), '<h1>Tasks</h1>\n');
  assert.match(read(ctx, 'app/main.py'), /# own/);
});
test('S2.1 bypass: a symlink in the caller\'s paths does not carry a relative write into another group\'s file', () => {
  const { ctx, r, before } = runTest('open("app/link/index.html", "a").write("x")', { links: { 'app/link': '../web' } });
  assert.strictEqual(read(ctx, 'web/index.html'), before.web, show(r));
  assert.ok(r.discarded.some((d) => d.path === 'web/index.html'), show(r));
});

// ------------------------------------------------------------------ the real tree: hashed before and after, without git
test('S2.1 bypass: an absolute write to another group\'s file fails the run, names the file, and nothing comes back', () => {
  const { ctx, r, before } = runTest('open(os.path.join(REAL, "web/index.html"), "a").write("x")\nopen("app/main.py", "a").write("# own\\n")');
  assert.strictEqual(r.status, 'failed', show(r));
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.match(msgs(r), /GF-RUN-2 .*web\/index\.html/);
  assert.strictEqual(read(ctx, 'app/main.py'), before.app, 'a failed run copies nothing back');
  assert.deepStrictEqual(r.copiedBack, []);
});
test('S2.1 positive: an absolute write to the caller\'s own group\'s file does not fail the run', () => {
  const { r } = runTest('open(os.path.join(REAL, "app/main.py"), "a").write("# own\\n")');
  assert.strictEqual(r.status, 'passed', show(r));
});
test('S2.1 bypass: an absolute new file outside every group fails the run', () => {
  const { r } = runTest('open(os.path.join(REAL, "notes.txt"), "w").write("x")');
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.match(msgs(r), /notes\.txt/);
});
test('S2.1 bypass: a run that moves the real HEAD fails', () => {
  const { r } = runTest('git("-C", REAL, "commit", "-q", "--allow-empty", "-m", "moved")');
  assert.strictEqual(r.status, 'failed', show(r));
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.match(msgs(r), /\.git\//);
});
test('S2.1 bypass: a run that writes inside the real .git fails', () => {
  const { r } = runTest('open(os.path.join(REAL, ".git/info/exclude"), "a").write("\\nweb/x\\n")');
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.match(msgs(r), /\.git\/info\/exclude/);
});
test('S2.1 bypass: an absolute symlink in the caller\'s paths writes to the real tree, and the run fails', () => {
  const { r } = runTest('open("app/abs/index.html", "a").write("x")', { links: { 'app/abs': (ctx) => path.join(ctx.dir, 'web') } });
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.match(msgs(r), /web\/index\.html/);
});

test('G1-1 (round 6): a run that deletes the record through its absolute path fails, and the record is put back', () => {
  const { ctx, r } = runTest('os.remove(os.path.join(os.environ["ECCODE_EVIDENCE"], "events.jsonl"))');
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.ok(fs.existsSync(path.join(ctx.dir, '.eccode/events.jsonl')), 'the frozen record window put the log back');
  assert.ok(ctx.store.readEvents().some((e) => e.type === 'gf.project.initialized'));
});

// ------------------------------------------------------------------ the evasions of round 6, permanent
test('G2-1 (round 6): a run whose code commits its change to another group\'s file leaves the real file and HEAD unchanged', () => {
  const { ctx, r, before } = runTest('open("web/index.html", "a").write("<!-- backend -->")\ngit("commit", "-qam", "hidden")');
  assert.strictEqual(read(ctx, 'web/index.html'), before.web, show(r));
  assert.strictEqual(head(ctx), before.head, show(r));
});
test('G2-1 (round 6, by the real paths): a run whose code commits another group\'s file in the real tree fails', () => {
  const { r } = runTest('open(os.path.join(REAL, "web/index.html"), "a").write("<!-- backend -->")\ngit("-C", REAL, "commit", "-qam", "hidden")');
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.match(msgs(r), /web\/index\.html/);
});
test('G2-2 (round 6): a run whose code hides a new file of another group in .git/info/exclude leaves the real tree unchanged', () => {
  const { ctx, r, before } = runTest('open(".git/info/exclude", "a").write("\\nweb/evil.txt\\n")\nopen("web/evil.txt", "w").write("x")');
  assert.strictEqual(exists(ctx, 'web/evil.txt'), false, show(r));
  assert.strictEqual(read(ctx, '.git/info/exclude'), before.exclude, show(r));
});
test('G2-2 (round 6, by the real paths): a run whose code hides another group\'s new file in the real exclude file fails', () => {
  const { r } = runTest('open(os.path.join(REAL, ".git/info/exclude"), "a").write("\\nweb/evil.txt\\n")\nopen(os.path.join(REAL, "web/evil.txt"), "w").write("x")');
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.match(msgs(r), /web\/evil\.txt/);
  assert.match(msgs(r), /\.git\/info\/exclude/);
});
test('R3 (round 6): a run whose code marks another group\'s file assume-unchanged before changing it leaves the real file unchanged', () => {
  const { ctx, r, before } = runTest('git("update-index", "--assume-unchanged", "web/index.html")\nopen("web/index.html", "a").write("<!-- backend -->")');
  assert.strictEqual(read(ctx, 'web/index.html'), before.web, show(r));
});
test('R3 (round 6, by the real paths): marking another group\'s real file assume-unchanged and changing it fails the run', () => {
  const { r } = runTest('git("-C", REAL, "update-index", "--assume-unchanged", "web/index.html")\nopen(os.path.join(REAL, "web/index.html"), "a").write("<!-- backend -->")');
  assert.strictEqual(r.exitCode, 99, show(r));
  assert.match(msgs(r), /web\/index\.html/);
});
