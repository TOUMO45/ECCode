#!/usr/bin/env node
'use strict';
// A2: does `eccode impact` name the tests that actually exercise a module?
// Ground truth, backend: the whole suite runs once under coverage with one
// context per test (coverage-map.py); a module's truth is the set of test
// files with a test that ran a line of it. Sample: 40 backend modules,
// stratified by package, seed 42; modules no test runs are excluded and
// counted. For each, static `impact` and impact merged with one runtime
// trace of the whole suite are scored by recall, precision and the share of
// all test files they select.
// Second truth: 10 of the 40 get a behavioural fault (fault.py: every
// function and method raises) and the suite runs; the test files that fail,
// minus those failing without any fault, are compared with the prediction.
// Frontend: 10 modules under frontend/app/lib and frontend/app/composables;
// truth from running each vitest spec file alone and recording the modules it
// loads (a2-loaded.mjs; Mealie's coverage provider cannot run at the pin).
// usage: node a2-impact.js <commit> [--sample 40] [--faults 10] [--jobs 3] [--skip-frontend]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const lib = require('../lib');
const codebase = require('../../../lib/codebase');
const env = require('../../suites/mealie/_tools/env');

const HERE = __dirname;
const SUITE_HOURS = 4 * 3600 * 1000;

/** `tests/x/test_y.py::test_z|run` -> `tests/x/test_y.py`. */
function testFilesFromContexts(contexts) {
  return new Set(contexts.filter(Boolean).map((c) => c.split('|')[0].split('::')[0]).filter(Boolean));
}

function stratumOf(file) {
  const m = file.match(/^mealie\/(routes|services|repos|schema|core|db\/models)\//);
  return m ? m[1] : 'other';
}

/** The module's text with every function and method raising (fault.py, run by `python`). */
function faultSource(text, python = 'python3') {
  return execFileSync(python, [path.join(HERE, 'fault.py')], { input: text, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Test files with a failing or erroring testcase in a pytest junit file (xunit1, with file attributes). */
function junitFailures(xml, tree) {
  const out = new Set();
  for (const m of String(xml).matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (!/<(failure|error)\b/.test(m[3] || '')) continue;
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (attrs.file) out.add(attrs.file);
    else {
      // A collection error: name is the dotted module ("tests.unit_tests.test_x").
      const parts = (attrs.classname || attrs.name || '').split('.');
      for (let i = parts.length; i > 0; i--) {
        const f = `${parts.slice(0, i).join('/')}.py`;
        if (fs.existsSync(path.join(tree, f))) {
          out.add(f);
          break;
        }
      }
    }
  }
  return out;
}

function pytestCmd(junit) {
  return `python -m pytest -q -p no:cacheprovider -o junit_family=xunit1 --junitxml=${JSON.stringify(junit)} tests`;
}

function runAsync(command, cwd, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...extraEnv }, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), SUITE_HOURS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function score(predicted, truth, allTests) {
  return { ...lib.recallPrecision(predicted, truth), predicted: predicted.size, truth: truth.size, selectedShare: allTests ? predicted.size / allTests : null };
}

async function backend(tree, venvEnv, index, opts, log) {
  const allTests = Object.keys(index.files).filter((f) => f.startsWith('tests/') && codebase.isRunnableTest(tree, f, index.files[f].lang));
  log(`coverage run of the whole suite (${allTests.length} test files)`);
  const covOut = path.join(os.tmpdir(), `pilot-a2-cov-${process.pid}.json`);
  spawnSync(path.join(venvEnv.VIRTUAL_ENV, 'bin', 'python'), [path.join(HERE, 'coverage-map.py'), tree, covOut], { cwd: tree, env: { ...process.env, ...venvEnv }, stdio: 'ignore', timeout: SUITE_HOURS });
  const cov = JSON.parse(fs.readFileSync(covOut, 'utf8'));
  log('trace run of the whole suite (also the no-fault baseline)');
  const baseJunit = path.join(os.tmpdir(), `pilot-a2-base-${process.pid}.xml`);
  const trace = codebase.traceRun(tree, `PATH=${JSON.stringify(path.join(venvEnv.VIRTUAL_ENV, 'bin'))}:"$PATH" PYTHONDONTWRITEBYTECODE=1 ${pytestCmd(baseJunit)}`, { timeoutMs: SUITE_HOURS });
  const baseline = junitFailures(fs.existsSync(baseJunit) ? fs.readFileSync(baseJunit, 'utf8') : '', tree);

  const population = Object.keys(index.files).filter((f) => /^mealie\/.*\.py$/.test(f) && !/(^|\/)__init__\.py$/.test(f) && !f.startsWith('mealie/alembic/'));
  const covered = population.filter((f) => (cov.map[f] || []).length);
  const drawn = lib.sample(covered, opts.sample, 42, stratumOf);
  const sample = drawn.map((module) => {
    const truth = testFilesFromContexts(cov.map[module]);
    const st = codebase.impact(tree, [module], { index });
    const merged = codebase.mergeTrace(st, trace);
    const traced = new Set([...st.tests, ...merged.runtime.runtimeDependents.filter((f) => f.startsWith('tests/') && codebase.isRunnableTest(tree, f, (index.files[f] || {}).lang))]);
    return { module, stratum: stratumOf(module), truth: [...truth].sort(), static: score(new Set(st.tests), truth, allTests.length), trace: score(traced, truth, allTests.length), predictedStatic: [...st.tests].sort() };
  });

  const faultModules = lib.sample(drawn, opts.faults, 42);
  log(`fault runs: ${faultModules.length}, ${opts.jobs} at a time`);
  const faults = await pool(faultModules, opts.jobs, async (module) => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-a2-fault-'));
    try {
      fs.cpSync(tree, copy, { recursive: true });
      const file = path.join(copy, module);
      fs.writeFileSync(file, faultSource(fs.readFileSync(file, 'utf8'), path.join(venvEnv.VIRTUAL_ENV, 'bin', 'python')));
      const junit = path.join(copy, '.pilot-fault.xml');
      await runAsync(pytestCmd(junit), copy, venvEnv);
      const failing = junitFailures(fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '', copy);
      const truth = new Set([...failing].filter((f) => !baseline.has(f)));
      const predicted = new Set(sample.find((s) => s.module === module).predictedStatic);
      return { module, failingTests: [...truth].sort(), predicted: predicted.size, ...lib.recallPrecision(predicted, truth) };
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });
  return { allTests: allTests.length, coverageExitCode: cov.exitCode, traceExitCode: trace.exitCode, baselineFailing: [...baseline].sort(), population: population.length, excludedUncovered: population.length - covered.length, sample, faults };
}

/**
 * Tree-relative source files a spec file loaded, from the lines a2-loaded.mjs
 * appended: absolute paths inside the tree only (no node_modules, no vitest
 * mock ids, no builtins, not our setup file). A line of null means vitest's
 * internals had no module map; it adds nothing.
 */
function loadedModules(text, tree, { setupFile = null } = {}) {
  const out = new Set();
  for (const line of String(text).split('\n').filter((l) => l.trim())) {
    for (const file of JSON.parse(line) || []) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || file === setupFile) continue;
      const rel = path.relative(tree, file);
      if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('node_modules')) continue;
      out.add(rel.split(path.sep).join('/'));
    }
  }
  return out;
}

// The truth: each spec file run alone, our setup file recording the modules it
// loaded (vitest's module graph). Mealie's coverage provider at the pin is
// @vitest/coverage-v8 3.2.4 under vitest 4.1.9, which fails ("Running mixed
// versions is not supported"), so coverage cannot give it.
function frontend(tree, index, opts, log) {
  const front = path.join(tree, 'frontend');
  try {
    env.nodeModules(tree);
  } catch (e) {
    return { ran: false, cause: String(e.message).split('\n')[0] };
  }
  const base = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'].find((c) => fs.existsSync(path.join(front, c)));
  if (!base) return { ran: false, cause: 'no vitest config in frontend/' };
  // Inside the tree: vite serves setup files only from under its root.
  const setupFile = path.join(front, 'eccode-a2-loaded.mjs');
  fs.copyFileSync(path.join(HERE, 'a2-loaded.mjs'), setupFile);
  fs.writeFileSync(path.join(front, 'vitest.eccode-a2.config.mjs'), `import { mergeConfig } from 'vitest/config';\nimport base from './${base}';\nexport default mergeConfig(base, { test: { setupFiles: ['./eccode-a2-loaded.mjs'] } });\n`);
  const specs = Object.keys(index.files).filter((f) => f.startsWith('frontend/') && /\.(spec|test)\.[jt]sx?$/.test(f));
  const coveredBy = new Map();
  const failures = [];
  for (const spec of specs) {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-a2-vitest-')), 'loaded.jsonl');
    const rel = path.relative(front, path.join(tree, spec));
    const r = spawnSync('npx', ['vitest', 'run', rel, '--config', 'vitest.eccode-a2.config.mjs'], { cwd: front, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ECCODE_A2_LOADED: out } });
    const loaded = fs.existsSync(out) ? loadedModules(fs.readFileSync(out, 'utf8'), tree, { setupFile }) : new Set();
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    if (!loaded.size) {
      failures.push({ spec, exit: r.status, tail: `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-5).join('\n') });
      continue;
    }
    for (const mod of loaded) {
      if (mod === spec) continue;
      if (!coveredBy.has(mod)) coveredBy.set(mod, new Set());
      coveredBy.get(mod).add(spec);
    }
  }
  if (!coveredBy.size) return { ran: false, cause: 'no spec file reported the modules it loaded', failures };
  const population = Object.keys(index.files).filter((f) => /^frontend\/app\/(lib|composables)\/.*\.ts$/.test(f) && !/\.(spec|test)\.ts$/.test(f));
  const covered = population.filter((f) => coveredBy.has(f));
  const sample = lib.sample(covered, opts.frontend, 42).map((module) => {
    const truth = coveredBy.get(module);
    const st = codebase.impact(tree, [module], { index });
    return { module, truth: [...truth].sort(), static: score(new Set(st.tests.filter((t) => specs.includes(t))), truth, specs.length) };
  });
  log(`frontend: ${specs.length} spec files, ${failures.length} failed to run, ${covered.length} covered modules`);
  return { ran: true, truth: 'modules each spec file loaded (vitest module graph)', specs: specs.length, specFailures: failures, population: population.length, excludedUncovered: population.length - covered.length, sample };
}

function medians(rows, pick) {
  return lib.median(rows.map(pick).filter((x) => x !== null && x !== undefined));
}

async function main(argv) {
  const commit = argv[0];
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('usage: a2-impact.js <full commit sha> [--sample n] [--faults n] [--jobs n] [--frontend n] [--skip-frontend]');
  const flag = (name, dflt) => (argv.includes(`--${name}`) ? Number(argv[argv.indexOf(`--${name}`) + 1]) : dflt);
  const opts = { sample: flag('sample', 40), faults: flag('faults', 10), jobs: flag('jobs', 3), frontend: flag('frontend', 10) };
  const log = (m) => process.stderr.write(`a2: ${m}\n`);
  const tree = lib.treeAt(lib.MEALIE, commit, fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-a2-')));
  try {
    const g = (args) => execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', ...args], { cwd: tree, stdio: 'ignore' });
    g(['init', '-q']);
    g(['add', '-A']);
    g(['commit', '-qm', 'tree']);
    const venvEnv = env.taskEnvVars(env.pythonEnv(tree));
    const index = codebase.indexProject(tree);
    const back = await backend(tree, venvEnv, index, opts, log);
    const front = argv.includes('--skip-frontend') ? { ran: false, cause: 'skipped by flag' } : frontend(tree, index, opts, log);
    const result = {
      commit,
      options: opts,
      backend: back,
      frontend: front,
      medians: {
        staticRecall: medians(back.sample, (s) => s.static.recall),
        traceRecall: medians(back.sample, (s) => s.trace.recall),
        staticPrecision: medians(back.sample, (s) => s.static.precision),
        staticSelectedShare: medians(back.sample, (s) => s.static.selectedShare),
        faultRecall: medians(back.faults, (f) => f.recall),
        frontendRecall: front.ran ? medians(front.sample, (s) => s.static.recall) : null,
      },
    };
    const file = lib.writeResult('a2-impact', result, process.env.ECCODE_PILOT_RESULTS || lib.RESULTS);
    process.stdout.write(`${file}\n${JSON.stringify(result.medians)}\n`);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

module.exports = { testFilesFromContexts, stratumOf, faultSource, junitFailures, loadedModules, frontend };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exit(1);
  });
}
