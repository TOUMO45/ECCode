'use strict';
// Materializes the Phase 2 fixture service into a temporary git repository,
// with a seeded bug (as the working tree, or as a commit in a short history
// for bisect) or ready for a seeded behaviour change.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { BUGS, CHANGES } = require('./seeds');

const SRC = path.join(__dirname, 'shop');

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

/** The correct service, committed once. */
function materialize() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-phase2-'));
  copyTree(SRC, dir);
  git(dir, ['init', '-q']);
  const base = commitAll(dir, 'shop: the correct service');
  return { dir, base };
}

function applyPatch(dir, patch) {
  const steps = [{ file: patch.file, find: patch.find, replace: patch.replace }, ...(patch.also || []).map((p) => ({ file: patch.file, ...p }))];
  for (const s of steps) {
    const file = path.join(dir, s.file);
    const text = fs.readFileSync(file, 'utf8');
    const n = text.split(s.find).length - 1;
    if (n !== 1) throw new Error(`${patch.id}: ${JSON.stringify(s.find.slice(0, 40))} occurs ${n} times in ${s.file}`);
    fs.writeFileSync(file, text.replace(s.find, s.replace));
  }
}

/** Lines (1-based) of the buggy file that match the bug's faulty pattern. */
function faultyLines(dir, bug) {
  const lines = fs.readFileSync(path.join(dir, bug.file), 'utf8').split('\n');
  return lines.map((l, i) => (bug.faulty.test(l) ? i + 1 : null)).filter(Boolean);
}

/**
 * A repository with the bug in place: the bug committed on top of the base
 * (or inside a five-commit history for the bisect bug) and the regression
 * test written, uncommitted. Returns {dir, base, bugCommit, faulty, bug}.
 */
function seedBug(id) {
  const bug = BUGS.find((b) => b.id === id);
  if (!bug) throw new Error(`unknown bug ${id}`);
  const { dir, base } = materialize();
  let bugCommit;
  if (bug.history) {
    for (const h of bug.history) {
      if (h.bug) {
        applyPatch(dir, bug);
        bugCommit = commitAll(dir, h.message);
      } else {
        fs.writeFileSync(path.join(dir, h.file), h.content);
        commitAll(dir, h.message);
      }
    }
  } else {
    applyPatch(dir, bug);
    bugCommit = commitAll(dir, `bug: ${bug.id}`);
  }
  if (bug.repro.file) fs.writeFileSync(path.join(dir, bug.repro.file), bug.repro.content);
  return { dir, base, bugCommit, faulty: faultyLines(dir, bug), bug };
}

/** The correct service committed; the change is applied by the caller after the record is created. */
function seedChange(id) {
  const change = CHANGES.find((c) => c.id === id);
  if (!change) throw new Error(`unknown change ${id}`);
  const { dir, base } = materialize();
  return { dir, base, change, apply: () => applyPatch(dir, change) };
}

/** The interpreter with the fixture's dependencies, or null with the reason. */
function python() {
  const candidates = [process.env.ECCODE_PYTHON, 'python3'].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, ['-c', 'import fastapi, httpx, hypothesis, coverage, pytest'], { encoding: 'utf8' });
    if (r.status === 0) return { python: py };
  }
  return { python: null, reason: `no interpreter with fastapi, httpx, hypothesis, coverage and pytest (tried ${candidates.join(', ')}); set ECCODE_PYTHON to one` };
}

module.exports = { materialize, seedBug, seedChange, applyPatch, faultyLines, python, BUGS, CHANGES };
