'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const wt = require('../lib/worktree');
const { tmpProject, write } = require('./helpers');

function commit(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], { cwd: dir });
}

test('withSides: the baseline is the base commit, the candidate is HEAD plus the working tree, configuration travels, both are removed', () => {
  const ctx = tmpProject({ beforeInit: (dir) => { write(dir, 'src/a.py', 'A = 1\n'); write(dir, '.eccode/guards.json', '{"perf": {}}\n'); commit(dir, 'base'); } });
  const { dir } = ctx;
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  write(dir, 'src/a.py', 'A = 2\n');
  write(dir, 'src/new.py', 'B = 1\n');
  fs.mkdirSync(path.join(dir, '.venv'));
  let roots = null;
  const out = wt.withSides(dir, base, ({ baseline, candidate, changed }) => {
    roots = [baseline.root, candidate.root];
    assert.strictEqual(fs.readFileSync(path.join(baseline.root, 'src/a.py'), 'utf8'), 'A = 1\n');
    assert.strictEqual(fs.readFileSync(path.join(candidate.root, 'src/a.py'), 'utf8'), 'A = 2\n');
    assert.strictEqual(fs.readFileSync(path.join(candidate.root, 'src/new.py'), 'utf8'), 'B = 1\n');
    assert.ok(!fs.existsSync(path.join(baseline.root, 'src/new.py')));
    assert.ok(fs.lstatSync(path.join(candidate.root, '.venv')).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(path.join(candidate.root, '.eccode/guards.json'), 'utf8'), '{"perf": {}}\n');
    assert.deepStrictEqual(changed.sort(), ['src/a.py', 'src/new.py']);
    return 'done';
  });
  assert.strictEqual(out, 'done');
  for (const r of roots) assert.ok(!fs.existsSync(r), `${r} removed`);
  assert.strictEqual(execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').length, 1);
});
