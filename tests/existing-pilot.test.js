'use strict';
// The W4 pilot's hidden oracle must agree with the product: the current tree has all three changes, so each task
// scores full marks here, and the base commit (when the clone has it) does not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ORACLE = path.join(ROOT, 'tools', 'existing', 'oracle.js');
const META = require('../tools/existing/base.json');
const score = (task, tree) => {
  const r = spawnSync(process.execPath, [ORACLE, task, tree], { encoding: 'utf8' });
  const m = /SCORE (\d+)\/(\d+)/.exec(r.stdout);
  assert.ok(m, r.stdout + r.stderr);
  return [Number(m[1]), Number(m[2])];
};

test('the current tree scores full marks on every pilot task', () => {
  for (const task of ['t1', 't2', 't3']) {
    const [passed, total] = score(task, ROOT);
    assert.strictEqual(passed, total, `${task}: ${passed}/${total}`);
  }
});

const hasBase = spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${META.base}^{commit}`]).status === 0;
test('the base commit fails part of every task, and each reference patch brings it to full marks', { skip: !hasBase || process.platform === 'win32' }, () => {
  const expectBase = { t1: 3, t2: 2, t3: 4 };
  for (const task of ['t1', 't2', 't3']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w4-base-'));
    const tar = execFileSync('git', ['-C', ROOT, 'archive', META.base, 'bin', 'lib', 'schemas', 'package.json', 'agents', 'skills', 'commands', 'scripts'], { maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
    assert.strictEqual(score(task, dir)[0], expectBase[task], `${task} on base`);
    const p = spawnSync('patch', ['-s', '-p1', '-i', path.join(ROOT, 'tools', 'existing', 'reference', `${task}.patch`)], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stdout + p.stderr);
    const [passed, total] = score(task, dir);
    assert.strictEqual(passed, total, `${task} with the reference patch: ${passed}/${total}`);
  }
});
