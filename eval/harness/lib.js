'use strict';
// Shared helpers for the ECCode evaluation harness (zero dependencies).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const EVAL_ROOT = path.join(__dirname, '..');
const TASKS_DIR = path.join(EVAL_ROOT, 'tasks');
const KIT_DIR = path.join(EVAL_ROOT, 'kit', 'acme-kit');

function copyDir(src, dst, { skip = () => false } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (skip(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, { skip });
    else if (e.isSymbolicLink()) continue;
    else fs.copyFileSync(s, d);
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listTasks() {
  return fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(TASKS_DIR, e.name, 'meta.json')))
    .map((e) => ({ dir: path.join(TASKS_DIR, e.name), ...JSON.parse(fs.readFileSync(path.join(TASKS_DIR, e.name, 'meta.json'), 'utf8')) }));
}

/** Fresh working copy of a task's repo (optionally with an overlay applied), as its own git repo. */
function materialize(task, { overlay, into } = {}) {
  const work = into || tmpDir(`eccode-task-${task.id}-`);
  copyDir(path.join(task.dir, 'repo'), work);
  if (overlay) copyDir(path.join(task.dir, overlay), work);
  const git = (...a) => spawnSync('git', a, { cwd: work, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=eval@acme.test', '-c', 'user.name=eval', 'commit', '-q', '-m', 'service snapshot');
  return work;
}

/** Parse node:test TAP output into [{ id, name, ok }] for top-level tests. */
function parseTap(out) {
  const results = [];
  for (const line of out.split('\n')) {
    const m = /^(not )?ok \d+ - (.*)$/.exec(line);
    if (!m) continue;
    const name = m[2].replace(/\s+#\s*(SKIP|TODO).*$/, '').trim();
    results.push({ id: name.split(/\s+/)[0], name, ok: !m[1], traps: [...name.matchAll(/\[trap:([\w-]+)\]/g)].map((x) => x[1]), org: [...name.matchAll(/\[org:([\w-]+)\]/g)].map((x) => x[1]) });
  }
  return results;
}

/** Run the service's own test suite (npm test equivalent) in a workdir. */
function runVisible(work, { timeoutMs = 180000 } = {}) {
  const res = spawnSync(process.execPath, ['--test'], { cwd: work, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, NODE_ENV: 'test' } });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const total = /# tests (\d+)/.exec(out);
  const fail = /# fail (\d+)/.exec(out);
  return { ok: res.status === 0, exitCode: res.status, tests: total ? Number(total[1]) : 0, failed: fail ? Number(fail[1]) : null, tail: out.split('\n').slice(-30).join('\n') };
}

/** Run hidden grader checks against a workdir. The grader files never enter the workdir. */
function runGrader(task, work, { timeoutMs = 180000 } = {}) {
  const graderDir = path.join(task.dir, 'grader');
  const files = fs.readdirSync(graderDir).filter((f) => f.endsWith('.test.js')).map((f) => path.join(graderDir, f));
  const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: tmpDir('eccode-grade-'), encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, TASK_ROOT: work, NODE_ENV: 'test' } });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const checks = parseTap(out);
  return { checks, timedOut: Boolean(res.error && res.error.code === 'ETIMEDOUT'), exitCode: res.status, tail: out.split('\n').filter((l) => /^(not ok|# |\s+(error|expected|actual):)/.test(l)).slice(0, 80).join('\n') };
}

/** Summarise one graded attempt. */
function score(visible, grade) {
  const ac = grade.checks.filter((c) => c.id.startsWith('AC'));
  const reg = grade.checks.filter((c) => c.id.startsWith('REG'));
  const acPassed = ac.filter((c) => c.ok).length;
  return {
    success: visible.ok && ac.length > 0 && acPassed === ac.length && reg.every((c) => c.ok),
    acPassed,
    acTotal: ac.length,
    acRate: ac.length ? acPassed / ac.length : 0,
    regressions: reg.filter((c) => !c.ok).map((c) => c.id),
    visibleOk: visible.ok,
    failedTraps: [...new Set(grade.checks.filter((c) => !c.ok).flatMap((c) => c.traps))],
    failedOrg: [...new Set(grade.checks.filter((c) => !c.ok).flatMap((c) => c.org))],
    orgChecks: grade.checks.filter((c) => c.org.length).map((c) => ({ id: c.id, org: c.org, ok: c.ok })),
    discoverable: (() => {
      const d = grade.checks.filter((c) => c.id.startsWith('AC') && !c.org.length);
      return { passed: d.filter((c) => c.ok).length, total: d.length };
    })(),
    failed: grade.checks.filter((c) => !c.ok).map((c) => c.name),
  };
}

function sha256Dir(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        h.update(path.relative(dir, p));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

module.exports = { EVAL_ROOT, TASKS_DIR, KIT_DIR, copyDir, tmpDir, listTasks, materialize, parseTap, runVisible, runGrader, score, sha256Dir };
