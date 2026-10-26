#!/usr/bin/env node
'use strict';
// The proof run, post hoc and not registered: would each run's patch pass
// Mealie's own lint and format step (its CI runs `pre-commit run`, whose ruff
// hooks are `ruff check --fix` and `ruff format`) on the Python files it
// touches? Only what the patch introduces counts: violations of a code beyond
// that code's count in the same file before the patch (a renamed file is
// compared with its old path), and files formatted before but not after (or
// new and unformatted). Each item's environment supplies ruff, and Mealie's
// own configuration applies. A ruff that does not run stops the tool.
// usage: node proof-lint.js <stage dir> <suite dir> <out.json>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const bench = require('../../../lib/bench');
const { commandEnv } = require('../../../lib/util');
const proof = require('../proof');

/**
 * The Python files a patch adds, changes or renames to (not those it deletes),
 * each with the path it had before. Quoted paths (non-ASCII names) are skipped.
 */
function changedPython(patch) {
  const out = [];
  for (const diff of String(patch || '').split(/^diff --git /m).slice(1)) {
    const to = /^\+\+\+ b\/(.+?\.py)\t?$/m.exec(diff);
    if (!to) continue;
    const from = /^rename from (.+)$/m.exec(diff);
    if (!out.some((x) => x.path === to[1])) out.push({ path: to[1], before: from ? from[1] : to[1] });
  }
  return out;
}

/** Throws unless ruff ran and exited 0 (clean) or 1 (findings). */
function ruffStatus(r, what) {
  if (r.status === null || r.error) throw new Error(`${what} did not run: ${r.error ? r.error.message : 'killed'}`);
  if (r.status !== 0 && r.status !== 1) throw new Error(`${what} exited ${r.status}: ${String(r.stderr || '').slice(0, 300)}`);
  return r;
}

/**
 * What a patch introduced, from ruff's view of the touched files before and
 * after it: {counts: {file: {code: n} or null}, unformatted: Set} each.
 */
function introduced(before, after) {
  let violations = 0;
  const codes = new Set();
  for (const [f, now] of Object.entries(after.counts)) {
    for (const [code, n] of Object.entries(now || {})) {
      const added = n - (((before.counts[f] || {})[code]) || 0);
      if (added > 0) { violations += added; codes.add(code); }
    }
  }
  const unformatted = [...after.unformatted].filter((f) => !before.unformatted.has(f)).sort();
  return { violations, codes: [...codes].sort(), unformatted, clean: violations === 0 && unformatted.length === 0 };
}

/** ruff's view of files in dir; names maps each file to the key it is reported under. */
function ruff(dir, names, env) {
  const exist = Object.keys(names).filter((f) => fs.existsSync(path.join(dir, f)));
  const counts = Object.fromEntries(Object.values(names).map((k) => [k, null]));
  const unformatted = new Set();
  if (exist.length) {
    const r = ruffStatus(spawnSync('ruff', ['check', '--no-fix', '--output-format', 'json', ...exist], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20 }), 'ruff check');
    const found = JSON.parse(r.stdout || '[]');
    for (const f of exist) {
      counts[names[f]] = {};
      for (const x of found.filter((v) => path.relative(dir, v.filename) === f)) {
        const code = `${x.code}${x.fix ? '*' : ''}`;
        counts[names[f]][code] = (counts[names[f]][code] || 0) + 1;
      }
    }
    // One file at a time: the exit code says whether it would be reformatted, whatever ruff prints.
    for (const f of exist) if (ruffStatus(spawnSync('ruff', ['format', '--check', f], { cwd: dir, env, encoding: 'utf8' }), 'ruff format').status === 1) unformatted.add(names[f]);
  }
  return { counts, unformatted };
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
    try {
      bench.exportSource({ repo: task.source.repo, commit: task.source.commit }, dir);
      execSync('git init -q . && git add -A && git -c user.email=x@x -c user.name=x -c commit.gpgsign=false commit -qm base', { cwd: dir });
      rows.forEach((r, i) => {
        if (r.task !== id) return;
        execSync('git checkout -q -- . && git clean -qfdx', { cwd: dir });
        const files = changedPython(r.patch);
        const before = ruff(dir, Object.fromEntries(files.map((f) => [f.before, f.path])), env);
        fs.writeFileSync(path.join(dir, '.run.patch'), r.patch || '');
        const ap = spawnSync('git', ['apply', '--whitespace=nowarn', '.run.patch'], { cwd: dir, encoding: 'utf8' });
        fs.rmSync(path.join(dir, '.run.patch'));
        if (ap.status !== 0) {
          out[keys[i]] = { variant: r.variant, error: `the patch does not apply: ${ap.stderr.slice(0, 200)}` };
          return;
        }
        const after = ruff(dir, Object.fromEntries(files.map((f) => [f.path, f.path])), env);
        const d = introduced(before, after);
        out[keys[i]] = { variant: r.variant, pyFiles: files.length, introduced: d.violations, codes: d.codes, newlyUnformatted: d.unformatted, clean: d.clean };
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 1)}\n`);
  for (const v of ['without', 'engine']) {
    const all = Object.values(out).filter((x) => x.variant === v);
    const ok = all.filter((x) => !x.error);
    process.stdout.write(`${v}: ${ok.filter((x) => x.clean).length}/${ok.length} clean${all.length > ok.length ? `; ${all.length - ok.length} patch(es) did not apply` : ''}\n`);
  }
}

module.exports = { changedPython, introduced, ruffStatus };

if (require.main === module) main(...process.argv.slice(2));
