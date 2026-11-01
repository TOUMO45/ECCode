'use strict';
// Materializes the Phase 3 fixture app (ledger/) into a temporary git
// repository and applies a seeded flaw from seeds.js to it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { FLAWS } = require('./seeds');

const SRC = path.join(__dirname, 'ledger');
const REQUIRED_MODULES = ['fastapi', 'httpx', 'sqlalchemy', 'alembic', 'pytest'];

function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name.endsWith('.sqlite') || e.name === '.pytest_cache') continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(b, { recursive: true });
      copyTree(a, b);
    } else fs.copyFileSync(a, b);
  }
}

function git(dir, args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** The clean app, committed once. Returns {dir, base}. */
function materialize() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-phase3-'));
  copyTree(SRC, dir);
  git(dir, ['init', '-q']);
  const base = commitAll(dir, 'ledger: the clean app');
  return { dir, base };
}

/**
 * Applies a flaw's changes to `dir`. Every find must occur exactly once in
 * the file as it stands (earlier changes included). Returns the list of
 * files changed (relative paths), without duplicates.
 */
function applyChanges(dir, flaw) {
  const changed = [];
  for (const c of flaw.changes) {
    if (c.addFile) {
      const file = path.join(dir, c.addFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, c.content);
      changed.push(c.addFile);
    } else if (c.deleteFile) {
      fs.rmSync(path.join(dir, c.deleteFile));
      changed.push(c.deleteFile);
    } else {
      const file = path.join(dir, c.file);
      const text = fs.readFileSync(file, 'utf8');
      const n = text.split(c.find).length - 1;
      if (n !== 1) throw new Error(`${flaw.id}: ${JSON.stringify(c.find.slice(0, 60))} occurs ${n} times in ${c.file}`);
      fs.writeFileSync(file, text.replace(c.find, () => c.replace));
      changed.push(c.file);
    }
  }
  return [...new Set(changed)];
}

/** The clean app committed; `apply()` puts the flaw in the working tree and returns the files changed. */
function seedFlaw(id) {
  const flaw = FLAWS.find((f) => f.id === id);
  if (!flaw) throw new Error(`unknown flaw ${id}`);
  const { dir, base } = materialize();
  return { dir, base, flaw, apply: () => applyChanges(dir, flaw) };
}

/** The interpreter with the fixture's dependencies, or null with the reason. */
function python() {
  const candidates = [process.env.ECCODE_PYTHON, 'python3'].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, ['-c', `import ${REQUIRED_MODULES.join(', ')}`], { encoding: 'utf8' });
    if (r.status === 0) return { python: py };
  }
  return { python: null, reason: `no interpreter with ${REQUIRED_MODULES.slice(0, -1).join(', ')} and ${REQUIRED_MODULES.at(-1)} (tried ${candidates.join(', ')}); set ECCODE_PYTHON to one` };
}

/** Runs the app's pytest suite in `dir`. Returns {passed, summary, stdout, stderr}. */
function runSuite(dir, py, args = []) {
  // addopts is cleared so the options here are the whole command line (pyproject's own -q would stack into -qq and drop the summary line).
  const r = spawnSync(py, ['-m', 'pytest', '-o', 'addopts=', '-q', '-p', 'no:cacheprovider', '-W', 'ignore', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const lines = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  const summary = lines.reverse().find((l) => /\b(passed|failed|error|errors|no tests ran)\b/.test(l)) || lines[0] || '';
  return { passed: r.status === 0, summary: summary.trim(), stdout: r.stdout || '', stderr: r.stderr || '' };
}

module.exports = { materialize, seedFlaw, applyChanges, python, runSuite, FLAWS };
