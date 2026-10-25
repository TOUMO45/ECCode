#!/usr/bin/env node
'use strict';
// Writes the Mealie task directories from selection.json (the draw and its
// live validation) and prompts.json (the requests, written by hand). No Mealie
// file is written: tasks name commits, and hidden tests are exported from the
// mirror at run time (task.hidden.fromSource).
// Items run in upstream order: by the date of their source commit.
// usage: node build.js [--suite <dir>]   (default: this suite; another suite
// keeps its own _tools/selection.json and _tools/prompts.json, and its
// refactor item names its base commit as prompts.refactor.source)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('../../../pilot/lib');
const env = require('./env');

const argv = process.argv.slice(2);
const SUITE = argv.includes('--suite') ? path.resolve(argv[argv.indexOf('--suite') + 1]) : path.join(__dirname, '..');
const TOOLS = path.join(SUITE, '_tools');
const selection = JSON.parse(fs.readFileSync(path.join(TOOLS, 'selection.json'), 'utf8'));
const prompts = JSON.parse(fs.readFileSync(path.join(TOOLS, 'prompts.json'), 'utf8'));
const refactor = prompts.refactor;

const P = refactor.source || 'dbe84cc91b9e1dfc88b783a1e31d8a8495800337';
const FULL_SUITE = 'python -m pytest -q -p no:cacheprovider tests';
const TRACK = { fix: 'fix', debug: 'debug', quick: 'quick', feature: 'feature', migration: 'feature', fullstack: 'feature', security: 'fix', refactor: 'refactor' };
const q = (s) => JSON.stringify(s);

function trackOf(category, subject) {
  if (TRACK[category]) return TRACK[category];
  return /^fix/.test(subject) ? 'fix' : 'feature'; // routes, frontend: by what the change is
}

function venvKey(mirror, commit) {
  return env.envKey(execFileSync('git', ['--git-dir', mirror, 'show', `${commit}:uv.lock`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function checksFor(a) {
  const target = [];
  const regression = [];
  if (a.backend) {
    target.push(`python -m pytest -q -p no:cacheprovider ${a.backend.target.map(q).join(' ')}`);
    const deselect = [...a.backend.target, ...a.backend.failingBoth].map((id) => `--deselect ${q(id)}`).join(' ');
    regression.push(`python -m pytest -q -p no:cacheprovider ${a.backend.regressionFiles.map(q).join(' ')} ${deselect}`.trim());
  }
  if (a.frontend) {
    const rel = (f) => q(f.replace(/^frontend\//, ''));
    target.push(`(cd frontend && npx vitest run ${a.frontend.specs.map(rel).join(' ')})`);
    regression.push(`(cd frontend && npx vitest run ${a.frontend.regressionSpecs.map(rel).join(' ')})`);
  }
  return [
    { id: 'target', command: target.join(' && '), timeoutMs: 1800000 },
    { id: 'regression', command: regression.join(' && '), timeoutMs: 3600000 },
  ];
}

function main() {
  const mirror = lib.mealieMirror();
  const time = (c) => Number(execFileSync('git', ['--git-dir', mirror, 'log', '-1', '--format=%ct', c], { encoding: 'utf8' }).trim());
  const items = Object.entries(selection.accepted).map(([category, a]) => ({ category, a, source: a.parent, at: time(a.parent) }));
  items.push({ category: 'refactor', a: null, source: P, at: time(P) });
  items.sort((x, y) => x.at - y.at || x.category.localeCompare(y.category));
  for (const d of fs.readdirSync(SUITE)) if (/^\d\d-/.test(d)) fs.rmSync(path.join(SUITE, d), { recursive: true, force: true });
  items.forEach((it, i) => {
    const order = i + 1;
    const id = `${String(order).padStart(2, '0')}-${it.category}`;
    const prompt = prompts[it.category];
    if (!prompt) throw new Error(`prompts.json has no request for ${it.category}`);
    const common = {
      id: `${path.basename(SUITE)}-${id}`,
      category: it.category,
      order,
      source: { repo: lib.MEALIE, commit: it.source },
      env: { PATH: `\${ECCODE_MEALIE_ENVS}/py-${venvKey(mirror, it.source)}/bin:\${PATH}`, PYTHONDONTWRITEBYTECODE: '1', ECCODE_MEALIE_ENVS: '${ECCODE_MEALIE_ENVS}' },
      // The venv and node_modules live outside the sandbox; this links and
      // prepares them for the item's tree (cheap once built by setup.sh).
      setup: 'node "$ECCODE_BENCH_TASK_DIR/../_tools/env.js" python . > /dev/null && node "$ECCODE_BENCH_TASK_DIR/../_tools/env.js" node . > /dev/null',
      prompt: prompt.text,
    };
    const task = it.category === 'refactor'
      ? {
        ...common,
        title: refactor.title,
        track: 'refactor',
        behavior: FULL_SUITE,
        hiddenChecks: [
          { id: 'target', command: `python .bench-hidden/dup_check.py . ${refactor.hashes.join(' ')}`, timeoutMs: 120000 },
          { id: 'regression', command: FULL_SUITE, timeoutMs: 3600000 },
        ],
        measured: refactor.measured,
      }
      : {
        ...common,
        title: it.a.subject,
        track: trackOf(it.category, it.a.subject),
        fixCommit: it.a.sha,
        hidden: { fromSource: { commit: it.a.sha, paths: it.a.hidden } },
        hiddenChecks: checksFor(it.a),
        measured: {
          target: (it.a.backend ? it.a.backend.target.length : 0) + (it.a.frontend ? it.a.frontend.specs.length : 0),
          regression: (it.a.backend ? it.a.backend.regression : 0) + (it.a.frontend ? it.a.frontend.regressionSpecs.length : 0),
          failingBeforeAndAfter: it.a.backend ? it.a.backend.failingBoth : [],
        },
      };
    fs.mkdirSync(path.join(SUITE, id), { recursive: true });
    fs.writeFileSync(path.join(SUITE, id, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
    process.stdout.write(`${id}: ${task.track}, ${task.title}\n`);
  });
}

module.exports = { checksFor, trackOf };

if (require.main === module) main();
