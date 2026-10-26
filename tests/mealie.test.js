'use strict';
// The Mealie pilot suite (bench/suites/mealie): ten real changes to Mealie,
// run as work items on one record. No Mealie file lives in this repository:
// tasks name upstream commits and the harness exports what it needs from a
// local mirror. Live checks need ECCODE_MEALIE_VALIDATE=1 and the
// environments from _tools/setup.sh in ECCODE_MEALIE_ENVS.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const TOOLS = path.join(__dirname, '..', 'bench', 'suites', 'mealie', '_tools');

test('mealie env: envKey is stable and 12 hex characters', () => {
  const { envKey } = require(path.join(TOOLS, 'env.js'));
  assert.strictEqual(envKey('a'), envKey('a'));
  assert.match(envKey('a'), /^[0-9a-f]{12}$/);
  assert.notStrictEqual(envKey('a'), envKey('b'));
});

test('mealie env: the venv uses the Python the tree requires (Mealie moved to 3.14 in v3.28)', () => {
  const { pythonVersionFor } = require(path.join(TOOLS, 'env.js'));
  assert.strictEqual(pythonVersionFor('[project]\nrequires-python = ">=3.14,<3.15"\n'), '3.14');
  assert.strictEqual(pythonVersionFor('[project]\nrequires-python = ">=3.12"\n'), '3.12');
  assert.strictEqual(pythonVersionFor('[project]\nrequires-python = "==3.14.*"\n'), '3.14');
  assert.strictEqual(pythonVersionFor('[project]\nname = "mealie"\n'), '3.12', 'the pilot\'s default when the tree states none');
});

const fs = require('fs');
const { spawnSync } = require('child_process');
const bench = require('../lib/bench');

const CATEGORIES = ['fix', 'debug', 'quick', 'feature', 'migration', 'routes', 'refactor', 'frontend', 'fullstack', 'security'];
const TRACKS = ['quick', 'debug', 'fix', 'feature', 'refactor'];
const MIRROR = path.join(bench.cacheDir(), 'github.com-mealie-recipes-mealie.git');
// The pilot's suite, and the rerun's fresh draw from a later window under the same rules.
const SUITES = ['mealie', 'mealie2'].map((name) => ({ name, dir: path.join(__dirname, '..', 'bench', 'suites', name) }));

for (const { name, dir: SUITE } of SUITES) {
  test(`${name}: ten tasks, each with a track from the allowed set, the ten categories covered`, () => {
    const tasks = bench.listTasks(SUITE);
    assert.strictEqual(tasks.length, 10);
    assert.deepStrictEqual(tasks.map((t) => t.category).sort(), [...CATEGORIES].sort());
    const selection = JSON.parse(fs.readFileSync(path.join(SUITE, '_tools', 'selection.json'), 'utf8'));
    for (const t of tasks) {
      assert.ok(TRACKS.includes(t.track), `${t.id}: track ${t.track}`);
      assert.match(t.id, new RegExp(`^${name}-\\d\\d-`));
      assert.match(t.source.commit, /^[0-9a-f]{40}$/);
      assert.ok(t.hiddenChecks.some((c) => c.id === 'target') && t.hiddenChecks.some((c) => c.id === 'regression'), `${t.id}: target and regression checks`);
      assert.ok(!fs.existsSync(path.join(t.dir, 'hidden')), `${t.id}: no Mealie file is kept in the suite`);
      if (t.category !== 'refactor') {
        assert.strictEqual(selection.accepted[t.category].sha, t.fixCommit, `${t.id}: the task is the recorded draw`);
        assert.ok(t.hidden.fromSource.paths.length, `${t.id}: hidden tests come from the upstream fix`);
      }
      assert.ok(t.prompt.length > 200, `${t.id}: an issue-style request`);
    }
    assert.deepStrictEqual(tasks.map((t) => t.order).sort((a, b) => a - b), tasks.map((_, i) => i + 1), 'orders 1..10');
  });

  test(`${name}: no prompt contains a line of its fix or names a file it changes`, (t) => {
    if (!fs.existsSync(MIRROR)) return t.skip(`no Mealie mirror at ${MIRROR} (the first bench export creates it)`);
    for (const task of bench.listTasks(SUITE).filter((x) => x.fixCommit)) {
      const diff = spawnSync('git', ['--git-dir', MIRROR, 'diff', task.source.commit, task.fixCommit, '--', '.', ':(exclude)tests', ':(exclude)**/*.spec.ts', ':(exclude)**/*.test.ts'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout;
      const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
      for (const f of files) {
        const named = new RegExp(`(?<![\\w/.-])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
        assert.ok(!named.test(task.prompt), `${task.id}: the request names ${f}`);
      }
      const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter((l) => l.length >= 15 && !/^(#|\/\/|\*|import |from |<\/?\w+>?$)/.test(l));
      for (const line of added) assert.ok(!task.prompt.includes(line), `${task.id}: the request contains the fix line ${JSON.stringify(line)}`);
    }
  });

  test(`${name} live: each target check fails at the source and passes at the fix commit`, { skip: process.env.ECCODE_MEALIE_VALIDATE !== '1' && 'set ECCODE_MEALIE_VALIDATE=1 (and ECCODE_MEALIE_ENVS from _tools/setup.sh) to validate live' }, () => {
    const os = require('os');
    for (const task of bench.listTasks(SUITE).filter((x) => x.fixCommit)) {
      for (const [commit, want] of [[task.source.commit, false], [task.fixCommit, true]]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mealie-validate-${task.id}-`));
        try {
          bench.exportSource({ repo: task.source.repo, commit }, dir);
          const setup = bench.runSetup(task, dir);
          assert.ok(!setup || setup.ok, `${task.id}: setup failed\n${setup && setup.tail}`);
          bench.placeHidden(task, dir);
          const [target, regression] = ['target', 'regression'].map((id) => bench.runChecks({ ...task, hiddenChecks: task.hiddenChecks.filter((c) => c.id === id) }, dir)[0]);
          assert.strictEqual(target.passed, want, `${task.id}: target at ${commit.slice(0, 8)} should ${want ? 'pass' : 'fail'}\n${target.tail}`);
          assert.strictEqual(regression.passed, true, `${task.id}: regression at ${commit.slice(0, 8)} should pass\n${regression.tail}`);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
}

test('mealie2: the rerun\'s items are fresh: no commit and no refactor target of the pilot comes back', () => {
  const [pilot, rerun] = SUITES.map(({ dir }) => bench.listTasks(dir));
  const used = new Set(pilot.flatMap((t) => [t.fixCommit, t.source.commit]).filter(Boolean));
  for (const t of rerun.filter((x) => x.fixCommit)) assert.ok(!used.has(t.fixCommit), `${t.id}: ${t.fixCommit} was a pilot item`);
  const hashes = (tasks) => tasks.find((t) => t.category === 'refactor').hiddenChecks[0].command.split(' ').filter((w) => /^[0-9a-f]{16}$/.test(w));
  assert.deepStrictEqual(hashes(rerun).filter((h) => hashes(pilot).includes(h)), [], 'a different duplication to remove');
});

test('mealie: both suites carry the same refactor check script', () => {
  const [a, b] = SUITES.map(({ dir }) => fs.readFileSync(path.join(dir, '_hidden', 'dup_check.py'), 'utf8'));
  assert.strictEqual(a, b);
});

test('mealie env: the frontend lockfile names the package manager (yarn before #7663, pnpm after)', () => {
  const { lockfileOf } = require(path.join(TOOLS, 'env.js'));
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mealie-lock-'));
  assert.strictEqual(lockfileOf(dir), null);
  fs.writeFileSync(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
  assert.deepStrictEqual(lockfileOf(dir), { manager: 'yarn', file: 'yarn.lock' });
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  assert.deepStrictEqual(lockfileOf(dir), { manager: 'pnpm', file: 'pnpm-lock.yaml' }, 'pnpm wins when both exist (the switch kept no yarn.lock, but be explicit)');
});

test('mealie env: pnpm\'s pre-run deps check is off, so a linked node_modules is not reinstalled (it refuses one outside the tree)', () => {
  const { taskEnvVars } = require(path.join(TOOLS, 'env.js'));
  assert.strictEqual(taskEnvVars('/v').pnpm_config_verify_deps_before_run, 'false');
  for (const { dir } of SUITES) {
    for (const d of fs.readdirSync(dir).filter((x) => /^\d\d-/.test(x))) {
      const task = JSON.parse(fs.readFileSync(path.join(dir, d, 'task.json'), 'utf8'));
      assert.strictEqual(task.env.pnpm_config_verify_deps_before_run, 'false', `${path.basename(dir)}/${d}`);
    }
  }
});
