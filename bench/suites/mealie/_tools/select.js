#!/usr/bin/env node
'use strict';
// The Mealie work items, drawn mechanically before any model sees them
// (spec Part B). Each category has a pool of commits in the window, filtered
// by subject and changed files; each pool is shuffled with seed 42 and taken
// front to back. A candidate is accepted only after live validation, twice:
//   - its new or changed tests fail on its parent (with the new tests copied in)
//     and pass at the commit: those tests are the item's target check;
//   - the other tests of those files pass on both sides: the regression check
//     (when there are none, the other test files of the same directories);
//   - a test failing on both sides is deselected and named in the request.
// Frontend items use vitest at the spec-file level. Every skip is recorded
// with its reason. The refactor item is not drawn (spec: no pure refactor
// with tests exists in the window); it is written by hand in prompts.json.
// usage: ECCODE_MEALIE_ENVS=<dir> node select.js [--range v3.20.0..v3.27.0] [--only <category>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../../../pilot/lib');
const bench = require('../../../../lib/bench');
const env = require('./env');

const OUT = path.join(__dirname, 'selection.json');
const FIX = /^fix(\([^)]*\))?!?:/;
const FEAT = /^feat(\([^)]*\))?!?:/;
const DEPS = /^fix\(deps\)/;
const SECURITY = /permission|ssrf|\bauth|harden|security|privilege|filter/i;
const ROUTE_LINE = /^[+-]\s*@\w*\.?(router|app)\.(get|post|put|patch|delete)\(/m;
const backendTests = (c) => c.files.filter((f) => f.status !== 'D' && /^tests\/(.*\/)?test_[^/]*\.py$/.test(f.path)).map((f) => f.path);
const frontSpecs = (c) => c.files.filter((f) => f.status !== 'D' && /^frontend\/.*\.(spec|test)\.ts$/.test(f.path)).map((f) => f.path);
const under = (c, dir) => c.files.filter((f) => f.path.startsWith(dir));
// One reviewable change a request can state fairly: at most 400 changed
// non-test lines in at most 12 non-test files (tests, lockfiles, translations
// and docs not counted). Added before registration, after the first draw
// accepted two features of 2,228 and 1,269 such lines.
const SIZE_CAP = { lines: 400, files: 12 };
const NOT_COUNTED = /^(tests\/|docs\/|frontend\/lang\/)|\.(spec|test)\.ts$|(^|\/)(uv\.lock|yarn\.lock|pnpm-lock\.yaml|package-lock\.json)$/;
const withinCap = (c) => {
  const counted = (c.numstat || []).filter((r) => !NOT_COUNTED.test(r.path));
  return counted.length <= SIZE_CAP.files && counted.reduce((n, r) => n + r.lines, 0) <= SIZE_CAP.lines;
};

/** Category -> predicate over a commit (with `diff` for the route pool). */
const BASE_POOLS = {
  fix: (c) => FIX.test(c.subject) && !DEPS.test(c.subject) && under(c, 'mealie/').length > 0 && backendTests(c).length > 0,
  quick: (c) => (FIX.test(c.subject) || FEAT.test(c.subject)) && !DEPS.test(c.subject) && under(c, 'mealie/').length >= 1 && under(c, 'mealie/').length <= 3 && backendTests(c).length > 0,
  feature: (c) => FEAT.test(c.subject) && under(c, 'mealie/').length > 0 && backendTests(c).length > 0,
  migration: (c) => c.files.some((f) => f.status === 'A' && /^mealie\/alembic\/versions\/.*\.py$/.test(f.path)) && backendTests(c).length > 0,
  routes: (c) => ROUTE_LINE.test(c.routeDiff || '') && backendTests(c).length > 0,
  frontend: (c) => under(c, 'frontend/').length > 0 && frontSpecs(c).length > 0,
  fullstack: (c) => FEAT.test(c.subject) && under(c, 'mealie/').length > 0 && under(c, 'frontend/').length > 0 && backendTests(c).length > 0,
  security: (c) => FIX.test(c.subject) && !DEPS.test(c.subject) && (SECURITY.test(c.subject) || under(c, 'mealie/core/security/').length > 0) && backendTests(c).length > 0,
};
const POOLS = Object.fromEntries(Object.entries(BASE_POOLS).map(([k, pred]) => [k, (c) => pred(c) && withinCap(c)]));
// The draw order: fix and debug share one pool, debug taking the next valid commit.
const ORDER = [['fix', 'fix'], ['debug', 'fix'], ['quick', 'quick'], ['feature', 'feature'], ['migration', 'migration'], ['routes', 'routes'], ['frontend', 'frontend'], ['fullstack', 'fullstack'], ['security', 'security']];

/** pytest node ids with their outcome, from a junit file (xunit1: file attributes). */
function junitOutcomes(xml) {
  const out = new Map();
  const collectionErrors = new Set();
  for (const m of String(xml).matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]));
    const body = m[3] || '';
    if (!a.file) {
      // A collection error: the module could not even be imported.
      collectionErrors.add(`${(a.classname || a.name || '').replace(/\./g, '/')}.py`);
      continue;
    }
    const mod = a.file.replace(/\.py$/, '').replace(/\//g, '.');
    const cls = a.classname && a.classname.startsWith(`${mod}.`) ? a.classname.slice(mod.length + 1) : '';
    const id = [a.file, ...(cls ? cls.split('.') : []), a.name].join('::');
    out.set(id, /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed');
  }
  return { outcomes: out, collectionErrors };
}

function pytestRun(tree, venvEnv, files, junit) {
  spawnSync(`python -m pytest -q -p no:cacheprovider -o junit_family=xunit1 --junitxml=${JSON.stringify(junit)} ${files.map((f) => JSON.stringify(f)).join(' ')}`, { cwd: tree, shell: true, encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...venvEnv } });
  return junitOutcomes(fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '');
}

function vitestRun(tree, specs) {
  const front = path.join(tree, 'frontend');
  return Object.fromEntries(specs.map((s) => {
    const r = spawnSync('npx', ['vitest', 'run', path.relative(front, path.join(tree, s))], { cwd: front, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
    return [s, r.status === 0 ? 'passed' : 'failed'];
  }));
}

function trees(c) {
  const parent = lib.treeAt(lib.MEALIE, c.parent, fs.mkdtempSync(path.join(os.tmpdir(), 'mealie-sel-p-')));
  const commit = lib.treeAt(lib.MEALIE, c.sha, fs.mkdtempSync(path.join(os.tmpdir(), 'mealie-sel-c-')));
  // Every file the fix changes under tests/ (helpers and fixtures too), and its spec files: the hidden set.
  const hidden = c.files.filter((f) => f.status !== 'D' && (f.path.startsWith('tests/') || /^frontend\/.*\.(spec|test)\.ts$/.test(f.path))).map((f) => f.path);
  for (const f of hidden) {
    fs.mkdirSync(path.dirname(path.join(parent, f)), { recursive: true });
    fs.copyFileSync(path.join(commit, f), path.join(parent, f));
  }
  return { parent, commit, hidden, cleanup: () => [parent, commit].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

/** Live validation of one backend candidate, two runs per side. Throws a recorded reason. */
function validateBackend(c, t) {
  const files = backendTests(c);
  const venvP = env.taskEnvVars(env.pythonEnv(t.parent));
  const venvC = env.taskEnvVars(env.pythonEnv(t.commit));
  const runs = (tree, venv, tag) => [1, 2].map((i) => pytestRun(tree, venv, files, path.join(os.tmpdir(), `mealie-sel-${process.pid}-${tag}${i}.xml`)));
  const [p1, p2] = runs(t.parent, venvP, 'p');
  const [c1, c2] = runs(t.commit, venvC, 'c');
  const same = (a, b) => JSON.stringify([...a.outcomes].sort()) === JSON.stringify([...b.outcomes].sort());
  if (!same(p1, p2) || !same(c1, c2)) throw new Error('flaky: outcomes differ between two runs');
  const pre = (id) => (p1.collectionErrors.has(id.split('::')[0]) ? 'failed' : p1.outcomes.get(id) || 'failed');
  const ids = [...c1.outcomes.keys()];
  const target = ids.filter((id) => c1.outcomes.get(id) === 'passed' && pre(id) === 'failed');
  if (!target.length) throw new Error('no test fails on the parent and passes at the commit');
  const failingBoth = ids.filter((id) => c1.outcomes.get(id) === 'failed' && pre(id) === 'failed');
  const failingAfterOnly = ids.filter((id) => c1.outcomes.get(id) === 'failed' && pre(id) === 'passed');
  if (failingAfterOnly.length) throw new Error(`the fix breaks ${failingAfterOnly.length} test(s) in this environment`);
  let regressionFiles = files;
  let regression = ids.filter((id) => c1.outcomes.get(id) === 'passed' && pre(id) === 'passed');
  if (!regression.length) {
    // No other test in the touched files: the other test files of their directories.
    const dirs = [...new Set(files.map((f) => path.posix.dirname(f)))];
    regressionFiles = dirs.flatMap((d) => fs.readdirSync(path.join(t.commit, d)).filter((f) => /^test_.*\.py$/.test(f)).map((f) => `${d}/${f}`)).filter((f) => !files.includes(f));
    if (!regressionFiles.length) throw new Error('no regression tests near the change');
    const [rp, rc] = [pytestRun(t.parent, venvP, regressionFiles, path.join(os.tmpdir(), `mealie-sel-${process.pid}-rp.xml`)), pytestRun(t.commit, venvC, regressionFiles, path.join(os.tmpdir(), `mealie-sel-${process.pid}-rc.xml`))];
    regression = [...rc.outcomes.keys()].filter((id) => rc.outcomes.get(id) === 'passed' && rp.outcomes.get(id) === 'passed');
    failingBoth.push(...[...rc.outcomes.keys()].filter((id) => rc.outcomes.get(id) === 'failed' && rp.outcomes.get(id) === 'failed'));
    if (!regression.length) throw new Error('no regression test passes on both sides');
  }
  return { tests: files, target, regressionFiles, regression: regression.length, failingBoth, venvKey: { parent: path.basename(venvP.VIRTUAL_ENV), commit: path.basename(venvC.VIRTUAL_ENV) } };
}

function validateFrontend(c, t) {
  env.nodeModules(t.parent);
  env.nodeModules(t.commit);
  const specs = frontSpecs(c);
  const all = fs.readdirSync(t.commit, { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => /^frontend\/(?!node_modules\/).*\.(spec|test)\.ts$/.test(f));
  const runs = (tree) => [vitestRun(tree, all), vitestRun(tree, all)];
  const [p1, p2] = runs(t.parent);
  const [c1, c2] = runs(t.commit);
  if (JSON.stringify(p1) !== JSON.stringify(p2) || JSON.stringify(c1) !== JSON.stringify(c2)) throw new Error('flaky: vitest outcomes differ between two runs');
  const target = specs.filter((s) => c1[s] === 'passed' && p1[s] === 'failed');
  if (!target.length) throw new Error('no spec file fails on the parent and passes at the commit');
  if (all.some((s) => c1[s] === 'failed' && p1[s] === 'passed')) throw new Error('the change breaks a spec file in this environment');
  const regression = all.filter((s) => !target.includes(s) && c1[s] === 'passed' && p1[s] === 'passed');
  if (!regression.length) throw new Error('no other spec file passes on both sides');
  return { specs: target, regressionSpecs: regression, failingBothSpecs: all.filter((s) => c1[s] === 'failed' && p1[s] === 'failed') };
}

function main(argv) {
  const range = argv.includes('--range') ? argv[argv.indexOf('--range') + 1] : 'v3.20.0..v3.27.0';
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const mirror = lib.mealieMirror();
  const commits = lib.commitsIn(mirror, range).filter((c) => c.parent && !c.merge);
  for (const c of commits) {
    c.numstat = spawnSync('git', ['--git-dir', mirror, 'diff', '--numstat', c.parent, c.sha], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\n').filter(Boolean).map((l) => {
      const [a, d, ...p] = l.split('\t');
      return { path: p.join('\t'), lines: (Number(a) || 0) + (Number(d) || 0) };
    });
    if (c.files.some((f) => f.path.startsWith('mealie/routes/'))) c.routeDiff = spawnSync('git', ['--git-dir', mirror, 'diff', '-U0', c.parent, c.sha, '--', 'mealie/routes'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
  }
  const pools = Object.fromEntries(Object.entries(POOLS).map(([k, pred]) => [k, lib.shuffle(commits.filter(pred), bench.mulberry32(42)).map((c) => c.sha)]));
  const prior = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  const selection = { ...(prior || {}), range, seed: 42, sizeCap: SIZE_CAP, pools, accepted: (prior && prior.accepted) || {}, skipped: (prior && prior.skipped) || [] };
  // An accepted commit the cap now excludes is cleared (and kept on record): its category draws again in pool order.
  for (const [category, a] of Object.entries(selection.accepted)) {
    const pool = (ORDER.find(([cat]) => cat === category) || [])[1];
    if (pool && !pools[pool].includes(a.sha)) {
      selection.sizeCapped = (selection.sizeCapped || []).concat({ category, sha: a.sha, subject: a.subject });
      delete selection.accepted[category];
    }
  }
  const used = new Set(Object.values(selection.accepted).map((a) => a.sha));
  const byId = new Map(commits.map((c) => [c.sha, c]));
  for (const [category, pool] of ORDER) {
    if (selection.accepted[category] || (only && only !== category)) continue;
    for (const sha of pools[pool]) {
      if (used.has(sha)) continue;
      if (selection.skipped.some((s) => s.sha === sha && s.category === category)) continue;
      const c = byId.get(sha);
      process.stderr.write(`select: ${category} candidate ${sha.slice(0, 8)} ${c.subject}\n`);
      let t;
      try {
        t = trees(c);
        const backend = backendTests(c).length ? validateBackend(c, t) : null;
        const frontend = category === 'frontend' || (category === 'fullstack' && frontSpecs(c).length) ? validateFrontend(c, t) : null;
        selection.accepted[category] = { sha, parent: c.parent, subject: c.subject, hidden: t.hidden, backend, frontend };
        used.add(sha);
        process.stderr.write(`select: ${category} accepted ${sha.slice(0, 8)}\n`);
        break;
      } catch (e) {
        selection.skipped.push({ category, sha, subject: c.subject, reason: String(e.message).split('\n')[0] });
        process.stderr.write(`select: ${category} skipped ${sha.slice(0, 8)}: ${String(e.message).split('\n')[0]}\n`);
      } finally {
        if (t) t.cleanup();
      }
      fs.writeFileSync(OUT, `${JSON.stringify(selection, null, 1)}\n`);
    }
    fs.writeFileSync(OUT, `${JSON.stringify(selection, null, 1)}\n`);
  }
  process.stdout.write(`${Object.keys(selection.accepted).length} accepted, ${selection.skipped.length} skipped\n`);
}

module.exports = { POOLS, BASE_POOLS, withinCap, SIZE_CAP, junitOutcomes };

if (require.main === module) main(process.argv.slice(2));
