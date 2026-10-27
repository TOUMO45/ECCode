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
// The proof run's suite: every eligible change of its window, no categories.
const MEALIE3 = { name: 'mealie3', dir: path.join(__dirname, '..', 'bench', 'suites', 'mealie3') };
// The multi-file run's suite: the large changes the size cap kept out.
const MEALIE4 = { name: 'mealie4', dir: path.join(__dirname, '..', 'bench', 'suites', 'mealie4') };

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
}

for (const { name, dir: SUITE } of [...SUITES, MEALIE3, MEALIE4]) {
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

test('mealie3: one task per accepted change of the window, fix or feature track by its subject, none used before', (t) => {
  const tasks = bench.listTasks(MEALIE3.dir);
  if (!tasks.length) return t.skip('mealie3 is not built yet (select.js --all, then build.js)');
  const selection = JSON.parse(fs.readFileSync(path.join(MEALIE3.dir, '_tools', 'selection.json'), 'utf8'));
  assert.strictEqual(selection.mode, 'all');
  assert.deepStrictEqual(tasks.map((t) => t.category).sort(), Object.keys(selection.accepted).sort(), 'every accepted change is a task, and no other');
  const used = new Set(SUITES.flatMap(({ dir }) => bench.listTasks(dir)).flatMap((t) => [t.fixCommit, t.source.commit]).filter(Boolean));
  for (const t of tasks) {
    const a = selection.accepted[t.category];
    assert.strictEqual(t.fixCommit, a.sha, `${t.id}: the task is the recorded draw`);
    assert.strictEqual(t.source.commit, a.parent);
    assert.strictEqual(t.track, /^fix/.test(a.subject) ? 'fix' : 'feature', `${t.id}: track by subject`);
    assert.match(t.id, /^mealie3-\d\d-(fix|feature)-[0-9a-f]{8}$/);
    assert.ok(t.hiddenChecks.some((c) => c.id === 'target') && t.hiddenChecks.some((c) => c.id === 'regression'), `${t.id}: target and regression checks`);
    assert.ok(t.prompt.length > 200, `${t.id}: an issue-style request`);
    assert.ok(!used.has(t.fixCommit), `${t.id}: used by an earlier suite`);
  }
  assert.deepStrictEqual(tasks.map((t) => t.order).sort((a, b) => a - b), tasks.map((_, i) => i + 1));
});

test('mealie4: one task per accepted multi-file change, fix or feature track by its subject, none used before', (t) => {
  const tasks = bench.listTasks(MEALIE4.dir);
  if (!tasks.length) return t.skip('mealie4 is not built yet (select.js --large, then build.js)');
  const { LARGE_POOL, earlierItems } = require(path.join(TOOLS, 'select.js'));
  const selection = JSON.parse(fs.readFileSync(path.join(MEALIE4.dir, '_tools', 'selection.json'), 'utf8'));
  assert.strictEqual(selection.mode, 'large');
  assert.deepStrictEqual(tasks.map((x) => x.category).sort(), Object.keys(selection.accepted).sort(), 'every accepted change is a task, and no other');
  const used = earlierItems(path.join(__dirname, '..', 'bench', 'suites'));
  for (const task of tasks) {
    const a = selection.accepted[task.category];
    assert.strictEqual(task.fixCommit, a.sha, `${task.id}: the task is the recorded draw`);
    assert.strictEqual(task.source.commit, a.parent);
    assert.strictEqual(task.track, /^fix/.test(a.subject) ? 'fix' : 'feature', `${task.id}: track by subject`);
    assert.match(task.id, /^mealie4-\d\d-(fix|feature)-[0-9a-f]{8}$/);
    assert.ok(task.hiddenChecks.some((c) => c.id === 'target') && task.hiddenChecks.some((c) => c.id === 'regression'), `${task.id}: target and regression checks`);
    assert.ok(task.prompt.length > 200, `${task.id}: an issue-style request`);
    assert.ok(!used.has(task.fixCommit), `${task.id}: an item of an earlier suite`);
    if (fs.existsSync(MIRROR)) {
      const numstat = spawnSync('git', ['--git-dir', MIRROR, 'diff', '--numstat', a.parent, a.sha], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\n').filter(Boolean).map((l) => {
        const [x, d, ...p] = l.split('\t');
        return { path: p.join('\t'), lines: (Number(x) || 0) + (Number(d) || 0) };
      });
      const files = numstat.map((r) => ({ status: 'M', path: r.path }));
      assert.ok(LARGE_POOL({ sha: a.sha, subject: a.subject, files, numstat }, new Set()), `${task.id}: meets the multi-file rule`);
    }
  }
  assert.deepStrictEqual(tasks.map((x) => x.order).sort((p, q) => p - q), tasks.map((_, i) => i + 1));
});

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

test('mealie select --all: every fix or feature with backend tests within the cap, no dependency bumps, named by kind and commit', () => {
  const { ALL_POOL, allKey } = require(path.join(TOOLS, 'select.js'));
  const commit = (subject, files, lines = 10) => ({ sha: 'abcdef0123456789', subject, files: files.map((p) => ({ status: 'M', path: p })), numstat: files.map((p) => ({ path: p, lines })) });
  const code = ['mealie/services/x.py', 'tests/unit_tests/test_x.py'];
  assert.strictEqual(ALL_POOL(commit('fix: keep servings when translating (#1)', code)), true);
  assert.strictEqual(ALL_POOL(commit('feat: instruction durations (#2)', code)), true);
  assert.strictEqual(ALL_POOL(commit('fix(deps): update pillow', code)), false, 'dependency update');
  assert.strictEqual(ALL_POOL(commit('fix: bump sqlalchemy (#8798)', code)), false, 'a bump is a dependency change');
  assert.strictEqual(ALL_POOL(commit('chore: tidy', code)), false);
  assert.strictEqual(ALL_POOL(commit('fix: no tests', ['mealie/services/x.py'])), false);
  assert.strictEqual(ALL_POOL(commit('fix: too big', code, 500)), false, 'over the size cap');
  assert.strictEqual(allKey(commit('fix: a', code)), 'fix-abcdef01');
  assert.strictEqual(allKey(commit('feat: b', code)), 'feature-abcdef01');
});

test('mealie build: test ids reach pytest intact through the shell (backticks, dollars, quotes, backslashes)', () => {
  // Found validating mealie4: a parametrised id with backticks ran as a command substitution.
  const { checksFor } = require(path.join(TOOLS, 'build.js'));
  const ids = ['t.py::test_a[support `,` seperated numbers]', 't.py::test_b[$HOME]', "t.py::test_c[it's]", 't.py::test_d[1 \\u6642 "q" !x]'];
  const [target, regression] = checksFor({ backend: { target: ids, failingBoth: [], regressionFiles: ['t.py'] } });
  const run = (command) => spawnSync('sh', ['-c', command.replace('python -m pytest -q -p no:cacheprovider', "printf '%s\\n'")], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.deepStrictEqual(run(target.command), ids);
  assert.deepStrictEqual(run(regression.command), ['t.py', ...ids.flatMap((id) => ['--deselect', id])]);
});

test('mealie select --large: multi-file fixes and features with backend tests, 100–1,500 counted lines, no earlier item', () => {
  const { LARGE_POOL, LARGE_RULE, largeCounts, earlierItems } = require(path.join(TOOLS, 'select.js'));
  assert.deepStrictEqual(LARGE_RULE, { files: 5, mealieFiles: 4, minLines: 100, maxLines: 1500 });
  const BACKEND = ['mealie/a.py', 'mealie/b.py', 'mealie/c.py', 'mealie/d.py'];
  // counted: the files whose lines are spread evenly (any remainder on the first);
  // extra: files that are present but not counted (tests, docs, translations, lockfiles).
  const big = (subject, counted, lines, extra = ['tests/unit_tests/test_x.py'], sha = 'abcdef0123456789') => {
    const each = Math.floor(lines / counted.length);
    const numstat = counted.map((p, i) => ({ path: p, lines: each + (i === 0 ? lines - each * counted.length : 0) })).concat(extra.map((p) => ({ path: p, lines: 50 })));
    return { sha, subject, files: [...counted, ...extra].map((p) => ({ status: 'M', path: p })), numstat };
  };
  const none = new Set();
  const five = [...BACKEND, 'frontend/pages/x.vue'];
  assert.strictEqual(LARGE_POOL(big('feat: organizer merge (#1)', five, 120), none), true);
  assert.strictEqual(LARGE_POOL(big('fix: harden http (#2)', five, 100), none), true, 'at exactly 100 lines');
  assert.strictEqual(LARGE_POOL(big('fix: harden http (#2)', five, 1500), none), true, 'at exactly 1,500 lines');
  assert.strictEqual(LARGE_POOL(big('fix: x', five, 99), none), false, 'under 100 lines');
  assert.strictEqual(LARGE_POOL(big('fix: x', five, 1501), none), false, 'over 1,500 lines');
  assert.strictEqual(LARGE_POOL(big('fix: x', BACKEND, 400), none), false, '4 counted files');
  assert.strictEqual(LARGE_POOL(big('fix: x', ['mealie/a.py', 'mealie/b.py', 'mealie/c.py', 'frontend/x.vue', 'frontend/y.ts'], 400), none), false, 'only 3 under mealie/');
  for (const uncounted of ['tests/unit_tests/test_y.py', 'docs/docs/x.md', 'frontend/lang/messages/en-US.json', 'uv.lock']) {
    assert.strictEqual(LARGE_POOL(big('fix: x', BACKEND, 400, ['tests/unit_tests/test_x.py', uncounted]), none), false, `${uncounted} is not counted`);
  }
  assert.strictEqual(LARGE_POOL(big('fix(deps): update pillow', five, 400), none), false, 'dependency update');
  assert.strictEqual(LARGE_POOL(big('fix: bump sqlalchemy', five, 400), none), false, 'a bump');
  assert.strictEqual(LARGE_POOL(big('chore: tidy', five, 400), none), false);
  assert.strictEqual(LARGE_POOL(big('feat: x', five, 400, []), none), false, 'no backend test');
  assert.strictEqual(LARGE_POOL(big('feat: x', five, 400), new Set(['abcdef0123456789'])), false, 'an earlier item');
  const binary = big('feat: x', five, 120);
  binary.numstat.push({ path: 'mealie/static/logo.png', lines: NaN });
  binary.files.push({ status: 'A', path: 'mealie/static/logo.png' });
  assert.deepStrictEqual(largeCounts(binary), { files: 6, mealieFiles: 5, lines: 120 }, 'a binary file counts as a file of 0 lines');
  const used = earlierItems(path.join(__dirname, '..', 'bench', 'suites'));
  assert.ok([...used].some((s) => s.startsWith('3be8f3d8')), 'mealie3\'s first item');
  assert.ok([...used].some((s) => s.startsWith('7808c944')), 'a pilot item');
  for (const s of used) assert.match(s, /^[0-9a-f]{40}$/);
});
