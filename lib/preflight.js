'use strict';
// Environment pre-flight: what the project's tooling will do to the work
// before it starts, reported as `environment.finding` events (never a gate).
//
// pytest basename collisions: pytest's default import modes (prepend, append)
// name a test module by its file's basename when its directory has no
// __init__.py, so two such files with the same name in different directories
// cannot be collected in one session ("import file mismatch"). A pinned check
// that collects both can never pass, whatever the fix; headless, a run that
// finds this out mid-way halts (0.A, mealie3-01 run #1). The pre-flight
// reports it when the Lab starts, with the two ways out: pin one file, or
// `--import-mode=importlib`.
const fs = require('fs');
const path = require('path');
const { toPosix, exists } = require('./util');

const TEST_FILE = /^(test_.*|.*_test)\.py$/;
const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', 'site-packages', '.eccode', '.claude', 'build', 'dist', '.tox', '.nox']);
const DEFAULT_ROOTS = ['tests', 'test'];
const IMPORTLIB = /import[-_]mode\s*=\s*importlib|--import-mode(?:=|\s+)importlib/;

/** The project's pytest configuration already selects importlib mode (then names never clash). */
function importlibConfigured(root, command) {
  if (command && IMPORTLIB.test(command)) return true;
  if (/^(1|true)$/i.test(process.env.PYTEST_ADDOPTS && IMPORTLIB.test(process.env.PYTEST_ADDOPTS) ? '1' : '')) return true;
  for (const f of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']) {
    const p = path.join(root, f);
    if (exists(p) && IMPORTLIB.test(fs.readFileSync(p, 'utf8'))) return true;
  }
  return false;
}

/** Every pytest-style test file under the roots (relative, posix), with whether its directory is a package. */
function testFiles(root, roots) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (TEST_FILE.test(e.name)) {
        out.push({ file: toPosix(path.relative(root, path.join(dir, e.name))), basename: e.name, inPackage: exists(path.join(dir, '__init__.py')) });
      }
    }
  };
  for (const r of roots) {
    const abs = path.join(root, r);
    if (!exists(abs)) continue;
    if (fs.statSync(abs).isDirectory()) walk(abs);
    else if (TEST_FILE.test(path.basename(abs))) out.push({ file: toPosix(r), basename: path.basename(abs), inPackage: exists(path.join(path.dirname(abs), '__init__.py')) });
  }
  return out;
}

/**
 * The roots a pytest command collects from (its path arguments), else the
 * project's conventional test directories. A command that is not a pytest run
 * gives the defaults too.
 */
function rootsOf(root, command) {
  const lab = require('./lab');
  const args = command ? lab.pytestArgs(command) : null;
  const paths = args ? lab.testPaths(args).map((p) => p.replace(/^['"]|['"]$/g, '')) : [];
  const given = paths.filter((p) => exists(path.join(root, p)));
  return given.length ? [...new Set(given)] : DEFAULT_ROOTS;
}

/**
 * Findings: each basename shared by two or more test files whose directory is
 * no package (those are the modules pytest names by basename alone). Files
 * inside a package get the package's dotted name and never clash with them.
 */
function pytestBasenameCollisions(root, { command = null } = {}) {
  if (importlibConfigured(root, command)) return [];
  const byName = new Map();
  for (const t of testFiles(root, rootsOf(root, command))) {
    if (t.inPackage) continue;
    if (!byName.has(t.basename)) byName.set(t.basename, new Set());
    byName.get(t.basename).add(t.file);
  }
  const out = [];
  for (const [basename, files] of byName) {
    if (files.size < 2) continue;
    const list = [...files].sort();
    out.push({
      kind: 'pytest-basename-collision',
      basename,
      files: list,
      message: `pytest cannot collect ${list.join(' and ')} in one session: both are module "${basename.replace(/\.py$/, '')}" (no __init__.py beside them), so a run that includes both fails with "import file mismatch" whatever the fix`,
      advice: 'pin a check that includes only one of them, or run pytest with --import-mode=importlib (pyproject [tool.pytest.ini_options] addopts)',
    });
  }
  return out.sort((a, b) => (a.basename < b.basename ? -1 : 1));
}

/**
 * Run the pre-flight for a work item and record what it found as
 * `environment.finding` events (one per finding; none when clean). Returns the
 * findings. Never throws on a project it cannot read: a pre-flight that fails
 * is no finding.
 */
function record(store, actor, { command = null } = {}) {
  let findings = [];
  try {
    findings = pytestBasenameCollisions(store.root, { command });
  } catch (err) {
    return [];
  }
  for (const f of findings) store.commit('environment.finding', actor, { ...f, command: command || null });
  return findings;
}

/** One line per finding, for the printed path, status and the report. */
function lines(findings) {
  return (findings || []).map((f) => `ENVIRONMENT (${f.kind}): ${f.message}. ${f.advice}`);
}

module.exports = { pytestBasenameCollisions, importlibConfigured, testFiles, rootsOf, record, lines, DEFAULT_ROOTS };
