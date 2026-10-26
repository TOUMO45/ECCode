'use strict';
// Scratch repositories for replaying a real fix (A4, A5, A6): a git repo
// whose HEAD is the fix's parent and whose working tree holds the fix, as an
// engineer has it just before committing. Also the population of fixes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const lib = require('../lib');
const bench = require('../../../lib/bench');
const env = require('../../suites/mealie/_tools/env');

const FIX = /^fix(\([^)]*\))?!?:/;
const LINT_CONFIG = ['pyproject.toml', 'ruff.toml', '.ruff.toml', 'setup.cfg', 'mypy.ini'];

/** Code fixes (`fix:` or `fix(scope):`, not dependency bumps) that change both mealie/ and tests/. */
function fixPopulation(commits) {
  return commits.filter((c) => c.parent && !c.merge && FIX.test(c.subject) && !/^fix\(deps\)/.test(c.subject)
    && c.files.some((f) => f.path.startsWith('mealie/')) && c.files.some((f) => f.path.startsWith('tests/')));
}

function exists(mirror, commit, file) {
  return spawnSync('git', ['--git-dir', mirror, 'cat-file', '-e', `${commit}:${file}`]).status === 0;
}

const git = (cwd, args) => execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * The fix's parent committed as base, the fix written over it. Returns
 * {root, base, testFiles, testCmd, venvEnv, cleanup}. Throws (a recorded skip)
 * when no runnable test file is among the changes.
 */
function scratchRepo(mirror, c, { full = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-fix-'));
  const changed = c.files.filter((f) => f.status !== 'D').map((f) => f.path);
  const removed = c.files.filter((f) => f.status === 'D' || f.from).map((f) => f.from || f.path);
  if (full) lib.treeAt(lib.MEALIE, c.parent, root);
  else {
    // With the project's lint configuration, so the analyzers judge the change
    // as the project does (its Python target, its rule set).
    const before = [...new Set([...changed, ...removed, ...LINT_CONFIG])].filter((f) => exists(mirror, c.parent, f));
    if (before.length) bench.exportPaths({ repo: lib.MEALIE, commit: c.parent }, before, root);
  }
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--allow-empty', '-m', `base ${c.parent}`]);
  const base = git(root, ['rev-parse', 'HEAD']);
  for (const f of removed) fs.rmSync(path.join(root, f), { force: true });
  const present = changed.filter((f) => exists(mirror, c.sha, f));
  if (present.length) bench.exportPaths({ repo: lib.MEALIE, commit: c.sha }, present, root);
  const testFiles = present.filter((f) => /^tests\/.*\/test_[^/]*\.py$/.test(f) || /^tests\/test_[^/]*\.py$/.test(f));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  if (full && !testFiles.length) {
    cleanup();
    throw new Error('no runnable test file among the changes');
  }
  const venvEnv = full ? env.taskEnvVars(env.pythonEnv(root)) : null;
  const testCmd = `python -m pytest -q -p no:cacheprovider ${testFiles.join(' ')}`;
  return { root, base, testFiles, testCmd, venvEnv, cleanup };
}

/** Run a shell command in cwd with the venv first on PATH; {code, out, tail, ms} (out: the whole output). */
function run(command, cwd, venvEnv, timeoutMs = 1800000) {
  const started = Date.now();
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...venvEnv } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { code: typeof r.status === 'number' ? r.status : 1, out, tail: out.split('\n').slice(-40).join('\n'), ms: Date.now() - started };
}

/** The installed eccode CLI of this repository, run in cwd. */
function eccode(cwd, args, venvEnv) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'bin', 'eccode.js'), ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...venvEnv, ECCODE_ACTOR: '' } });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

module.exports = { fixPopulation, scratchRepo, run, eccode, exists };
