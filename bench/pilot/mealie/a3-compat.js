#!/usr/bin/env node
'use strict';
// A3: ECCode's breaking-change checks replayed over Mealie's history.
//   - Every first-parent commit of the range: the compat check between its
//     parent and itself, over the files it touches (removed exports, removed
//     routes, edited or deleted migrations, destructive SQL in new ones).
//     Every detection is labelled by hand afterwards (labels/compat.json).
//   - Route recall: 20 commits touching mealie/routes (seed 42); the routes
//     FastAPI itself serves at parent and commit (fastapi-routes.py); every
//     removed route is matched against the commit's route detections (same
//     method, the served path ending with the declared one).
//   - For route detections, whether FastAPI still serves the route at the
//     commit (a hint for the hand labels: a route that moved files).
//   - Destructive migrations (reported, no criterion): every migration the
//     range adds, its upgrade() checked for drops, against the detections.
// usage: node a3-compat.js <range> [--route-sample 20]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');
const bench = require('../../../lib/bench');
const compat = require('../../../lib/compat');
const env = require('../../suites/mealie/_tools/env');

/** Compat detections between two trees over `files`, each with an id `<sha>:<kind>:<name>`. */
function detectBetween(parentDir, commitDir, files, sha = '') {
  const base = compat.snapshot(parentDir, files);
  return compat.detect(commitDir, base, files).map((d) => ({ id: `${sha}:${d.kind}:${d.name}`, sha, ...d }));
}

/** The upgrade() function of an Alembic migration (to the next top-level def). */
function upgradeBody(text) {
  const m = String(text).match(/^def upgrade\b[\s\S]*?(?=^def |(?![\s\S]))/m);
  return m ? m[0] : '';
}

const DROPS = /\bop\.drop_\w+|\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)|\bTRUNCATE\s|DELETE\s+FROM\s+(?![^;]*\bWHERE\b)/i;

function exists(mirror, commit, file) {
  return spawnSync('git', ['--git-dir', mirror, 'cat-file', '-e', `${commit}:${file}`]).status === 0;
}

function sideDir(mirror, commit, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-a3-'));
  const present = files.filter((f) => exists(mirror, commit, f));
  if (present.length) bench.exportPaths({ repo: lib.MEALIE, commit }, present, dir);
  return dir;
}

function servedRoutes(commit) {
  const tree = lib.treeAt(lib.MEALIE, commit, fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-a3-tree-')));
  try {
    const venv = env.pythonEnv(tree);
    const out = path.join(tree, '.pilot-routes.txt');
    const r = spawnSync(path.join(venv, 'bin', 'python'), [path.join(__dirname, 'fastapi-routes.py'), tree, out], { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env.taskEnvVars(venv) } });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`fastapi-routes failed at ${commit}: ${String(r.stderr).split('\n').filter(Boolean).slice(-1)[0]}`);
    return new Set(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean));
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

function matches(served, declared) {
  const [m1, p1] = served.split(' ');
  const [m2, p2] = declared.split(' ');
  return m1 === m2 && (p1 === p2 || p1.endsWith(p2));
}

function main(argv) {
  const range = argv[0];
  if (!range) throw new Error('usage: a3-compat.js <range> [--route-sample 20]');
  const k = argv.includes('--route-sample') ? Number(argv[argv.indexOf('--route-sample') + 1]) : 20;
  const mirror = lib.mealieMirror();
  const commits = lib.commitsIn(mirror, range);
  const log = (m) => process.stderr.write(`a3: ${m}\n`);
  log(`${commits.length} commits`);
  const replayed = lib.replay(commits, (c) => {
    if (!c.parent) throw new Error('root commit: no parent to compare');
    const files = [...new Set(c.files.flatMap((f) => [f.path, f.from].filter(Boolean)))];
    const p = sideDir(mirror, c.parent, files);
    const n = sideDir(mirror, c.sha, files);
    try {
      return { sha: c.sha, subject: c.subject, files: files.length, added: c.files.filter((f) => f.status === 'A').map((f) => f.path), detections: detectBetween(p, n, files, c.sha) };
    } finally {
      fs.rmSync(p, { recursive: true, force: true });
      fs.rmSync(n, { recursive: true, force: true });
    }
  });
  const detections = replayed.results.flatMap((r) => r.detections.map((d) => ({ ...d, subject: r.subject })));
  log(`${detections.length} detections, ${replayed.skipped.length} commits skipped`);

  // Hints for the route labels: is the route still served at the commit?
  const routeShas = [...new Set(detections.filter((d) => d.kind === 'route').map((d) => d.sha))];
  const served = new Map();
  const servedAt = (sha) => {
    if (!served.has(sha)) served.set(sha, servedRoutes(sha));
    return served.get(sha);
  };
  const hints = lib.replay(routeShas, (sha) => {
    const now = servedAt(sha);
    for (const d of detections.filter((x) => x.kind === 'route' && x.sha === sha)) d.stillServed = [...now].some((s) => matches(s, d.name));
    return sha;
  });

  // Route recall on a seeded sample of commits that touch mealie/routes.
  const touching = commits.filter((c) => c.parent && c.files.some((f) => f.path.startsWith('mealie/routes/')));
  const drawn = lib.sample(touching, k, 42);
  const recall = lib.replay(drawn, (c) => {
    const before = servedAt(c.parent);
    const after = servedAt(c.sha);
    const removed = [...before].filter((r) => !after.has(r));
    const declared = detections.filter((d) => d.sha === c.sha && d.kind === 'route').map((d) => d.name);
    const detected = removed.filter((r) => declared.some((d) => matches(r, d)));
    return { sha: c.sha, subject: c.subject, removedTruth: removed, detected, missed: removed.filter((r) => !detected.includes(r)) };
  });
  const truthN = recall.results.reduce((s, r) => s + r.removedTruth.length, 0);
  const detN = recall.results.reduce((s, r) => s + r.detected.length, 0);

  // Destructive migrations added in the range.
  const added = replayed.results.flatMap((r) => r.added.filter((f) => compat.MIGRATION_DIR.test(f) && f.endsWith('.py')).map((f) => ({ sha: r.sha, file: f })));
  const destructive = added.map(({ sha, file }) => {
    const text = spawnSync('git', ['--git-dir', mirror, 'show', `${sha}:${file}`], { encoding: 'utf8' }).stdout;
    const hit = upgradeBody(text).match(DROPS);
    return { sha, file, dropsInUpgrade: hit ? hit[0] : null, detected: detections.some((d) => d.sha === sha && d.kind === 'destructive-migration' && d.name === file) };
  });

  const result = {
    range,
    commits: commits.length,
    skipped: replayed.skipped,
    detections,
    byKind: detections.reduce((m, d) => ({ ...m, [d.kind]: (m[d.kind] || 0) + 1 }), {}),
    hintSkipped: hints.skipped,
    routeRecall: { sample: recall.results, skipped: recall.skipped, removedTruth: truthN, detected: detN, recall: truthN ? detN / truthN : null },
    destructiveMigrations: { added: added.length, withDropsInUpgrade: destructive.filter((d) => d.dropsInUpgrade).length, detectedOfThose: destructive.filter((d) => d.dropsInUpgrade && d.detected).length, rows: destructive },
  };
  const file = lib.writeResult('a3-compat', result, process.env.ECCODE_PILOT_RESULTS || lib.RESULTS);
  process.stdout.write(`${file}\n${JSON.stringify({ commits: result.commits, byKind: result.byKind, routeRecall: result.routeRecall.recall, removedTruth: truthN, skipped: replayed.skipped.length })}\n`);
}

module.exports = { detectBetween, upgradeBody, matches };

if (require.main === module) main(process.argv.slice(2));
