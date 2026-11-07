'use strict';
// E2 reproductions on the closure's path checks (lib/greenfield/closure.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const COPY = path.resolve(__dirname, '..', 'copy');
const { gfProject } = require(path.join(COPY, 'tests/fixtures/gf/flow'));
const closure = require(path.join(COPY, 'lib/greenfield/closure'));
const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
const dispatch = (ctx, inputs) => { try { return { ok: true, data: closure.recordDispatch(ctx.store, ctx.config, 'orchestrator', { scope: 'S9', role: 'security-reviewer', step: 'critique', inputs }).event.data }; } catch (e) { return { ok: false, message: e.message }; } };

test('E2-6: a dispatch input that is a hard link to .eccode/events.jsonl is accepted (the symlink form is refused, D2-4)', () => {
  const ctx = gfProject();
  fs.mkdirSync(path.join(ctx.dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'docs/brief.md'), '# brief\n');
  fs.writeFileSync(path.join(ctx.dir, '.gitignore'), 'docs/*.jsonl\n');
  gitIn(ctx.dir, 'add', '-A');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'docs');
  fs.symlinkSync('../.eccode/events.jsonl', path.join(ctx.dir, 'docs/sym.jsonl'));
  fs.linkSync(path.join(ctx.dir, '.eccode/events.jsonl'), path.join(ctx.dir, 'docs/hard.jsonl'));
  const sym = dispatch(ctx, ['docs/brief.md', 'docs/sym.jsonl']);
  const hard = dispatch(ctx, ['docs/brief.md', 'docs/hard.jsonl']);
  const same = fs.statSync(path.join(ctx.dir, 'docs/hard.jsonl')).ino === fs.statSync(path.join(ctx.dir, '.eccode/events.jsonl')).ino;
  console.log(`symlink input -> ${sym.ok ? 'recorded' : `refused: ${sym.message.split('\n')[0]}`}`);
  console.log(`hard-link input (same inode as .eccode/events.jsonl: ${same}) -> ${hard.ok ? `recorded as ${JSON.stringify(hard.data.inputs)}` : `refused: ${hard.message}`}`);
  assert.strictEqual(sym.ok, false, 'control: the symlinked input is refused');
  assert.strictEqual(hard.ok, false, 'GF-CLOSE-5: an input that is the implementers\' event log is refused wherever it lands');
});

test('E2-7: an untracked source file hidden by .git/info/exclude or core.excludesFile (configuration outside the tree) leaves the tree "clean"', () => {
  const ctx = gfProject();
  fs.mkdirSync(path.join(ctx.dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'app/main.py'), 'from app.override import handler\n');
  gitIn(ctx.dir, 'add', '-A');
  gitIn(ctx.dir, 'commit', '-q', '-m', 'app');
  fs.writeFileSync(path.join(ctx.dir, 'app/override.py'), 'def handler():\n    return "not in the reviewed tree"\n');
  const plain = closure.treeState(ctx.dir).dirty;
  fs.appendFileSync(path.join(ctx.dir, '.git/info/exclude'), 'app/override.py\n');
  const viaInfo = closure.treeState(ctx.dir).dirty;
  fs.writeFileSync(path.join(ctx.dir, '.git/info/exclude'), '');
  const excl = path.join(ctx.dir, '.git', 'my-excludes');
  fs.writeFileSync(excl, 'app/override.py\n');
  gitIn(ctx.dir, 'config', 'core.excludesFile', excl);
  const viaConfig = closure.treeState(ctx.dir).dirty;
  const inTree = gitIn(ctx.dir, 'ls-tree', '-r', '--name-only', 'HEAD', 'app');
  console.log(`no exclude: dirty=${JSON.stringify(plain)}; .git/info/exclude: dirty=${JSON.stringify(viaInfo)}; core.excludesFile: dirty=${JSON.stringify(viaConfig)}; HEAD tree app/: ${JSON.stringify(inTree)}`);
  assert.ok(plain, 'control: the untracked file makes the tree dirty');
  assert.ok(viaInfo, 'D2-2: repository configuration must not hide a change (.git/info/exclude)');
  assert.ok(viaConfig, 'D2-2: repository configuration must not hide a change (core.excludesFile)');
});
