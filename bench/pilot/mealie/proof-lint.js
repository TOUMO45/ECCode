#!/usr/bin/env node
'use strict';
// The proof run, post hoc and not registered: would each run's patch pass
// Mealie's own lint and format step (its CI runs `pre-commit run`, whose ruff
// hooks are `ruff check --fix` and `ruff format`) on the Python files it
// touches? Only what the patch introduces counts: violations beyond the same
// file's count at the item's source commit, and files that were formatted
// before and are not after (or new and unformatted). Each item's environment
// supplies ruff, and Mealie's own configuration applies.
// usage: node proof-lint.js <stage dir> <suite dir> <out.json>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const bench = require('../../../lib/bench');
const { commandEnv } = require('../../../lib/util');
const proof = require('../proof');

/** The Python files a patch adds or changes (not those it deletes). */
const changedPython = (patch) => [...new Set([...String(patch || '').matchAll(/^\+\+\+ b\/(\S+\.py)$/gm)].map((m) => m[1]))];

/**
 * What a patch introduced, from ruff's view of the touched files before and
 * after it: {counts: {file: violations or null}, unformatted: Set} each.
 */
function introduced(before, after) {
  const files = Object.keys(after.counts);
  const violations = files.reduce((a, f) => a + Math.max(0, (after.counts[f] || 0) - (before.counts[f] || 0)), 0);
  const unformatted = [...after.unformatted].filter((f) => !before.unformatted.has(f)).sort();
  return { violations, unformatted, clean: violations === 0 && unformatted.length === 0 };
}

function ruff(dir, files, env) {
  const exist = files.filter((f) => fs.existsSync(path.join(dir, f)));
  const counts = Object.fromEntries(files.map((f) => [f, null]));
  const unformatted = new Set();
  let found = [];
  if (exist.length) {
    found = JSON.parse(spawnSync('ruff', ['check', '--no-fix', '--output-format', 'json', ...exist], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '[]');
    for (const f of exist) counts[f] = found.filter((x) => path.relative(dir, x.filename) === f).length;
    // One file at a time: the exit code says whether it would be reformatted, whatever ruff prints.
    for (const f of exist) if (spawnSync('ruff', ['format', '--check', f], { cwd: dir, env, encoding: 'utf8' }).status === 1) unformatted.add(f);
  }
  return { counts, unformatted, codes: [...new Set(found.map((x) => `${x.code}${x.fix ? '*' : ''}`))] };
}

function main(stage, suite, outFile) {
  const rows = proof.readRuns(stage);
  const keys = proof.runKeys(rows);
  const tasks = Object.fromEntries(bench.listTasks(suite).map((t) => [t.id, t]));
  const out = {};
  for (const id of [...new Set(rows.map((r) => r.task))].sort()) {
    const task = tasks[id];
    const env = commandEnv(bench.taskEnv(task));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-lint-'));
    bench.exportSource({ repo: task.source.repo, commit: task.source.commit }, dir);
    execSync('git init -q . && git add -A && git -c user.email=x@x -c user.name=x -c commit.gpgsign=false commit -qm base', { cwd: dir });
    rows.forEach((r, i) => {
      if (r.task !== id) return;
      execSync('git checkout -q -- . && git clean -qfd', { cwd: dir });
      const files = changedPython(r.patch);
      const before = ruff(dir, files, env);
      fs.writeFileSync(path.join(dir, '.run.patch'), r.patch || '');
      const ap = spawnSync('git', ['apply', '--whitespace=nowarn', '.run.patch'], { cwd: dir, encoding: 'utf8' });
      fs.rmSync(path.join(dir, '.run.patch'));
      if (ap.status !== 0) {
        out[keys[i]] = { variant: r.variant, error: `the patch does not apply: ${ap.stderr.slice(0, 200)}` };
        return;
      }
      const after = ruff(dir, files, env);
      const d = introduced(before, after);
      out[keys[i]] = { variant: r.variant, pyFiles: files.length, introduced: d.violations, codes: d.violations ? after.codes : [], newlyUnformatted: d.unformatted, clean: d.clean };
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 1)}\n`);
  const of = (v) => Object.values(out).filter((x) => x.variant === v && !x.error);
  for (const v of ['without', 'engine']) process.stdout.write(`${v}: ${of(v).filter((x) => x.clean).length}/${of(v).length} clean\n`);
}

module.exports = { changedPython, introduced };

if (require.main === module) main(...process.argv.slice(2));
