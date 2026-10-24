'use strict';
// Environments for Mealie trees, built once and kept outside every sandbox:
// one Python venv per uv.lock and one node_modules per frontend/yarn.lock,
// each keyed by its lockfile's hash, under $ECCODE_MEALIE_ENVS.
//
// The project itself is not installed into the venv: a venv shared by many
// sandboxes must not point into one of them, and Mealie runs from its tree
// (tests import `mealie` from the repository root, and no code reads the
// package's installed metadata).
//
// CLI: node env.js python <tree>   prints the venv path, building it if needed
//      node env.js node <tree>     prints the node_modules path and links it
//                                  into <tree>/frontend/node_modules
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** First 12 hex characters of the lockfile text's sha256. */
function envKey(lockText) {
  return crypto.createHash('sha256').update(lockText).digest('hex').slice(0, 12);
}

function envsDir(envs) {
  if (!envs) throw new Error('ECCODE_MEALIE_ENVS is not set: see bench/suites/mealie/README.md');
  fs.mkdirSync(envs, { recursive: true });
  return path.resolve(envs);
}

function run(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd} (exit ${r.status}):\n${`${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-25).join('\n')}`);
  return r.stdout;
}

/** The venv for this tree's uv.lock (Python 3.12, dev group included). */
function pythonEnv(tree, { envs = process.env.ECCODE_MEALIE_ENVS } = {}) {
  const key = envKey(fs.readFileSync(path.join(tree, 'uv.lock'), 'utf8'));
  const venv = path.join(envsDir(envs), `py-${key}`);
  const ready = path.join(venv, '.eccode-ready');
  if (fs.existsSync(ready)) return venv;
  run('uv', ['sync', '--frozen', '--python', '3.12', '--no-install-project'], tree, { ...process.env, UV_PROJECT_ENVIRONMENT: venv });
  fs.writeFileSync(ready, `${new Date().toISOString()}\n`);
  return venv;
}

/** node_modules for this tree's frontend/yarn.lock, linked into <tree>/frontend. */
function nodeModules(tree, { envs = process.env.ECCODE_MEALIE_ENVS } = {}) {
  const front = path.join(tree, 'frontend');
  const lock = fs.readFileSync(path.join(front, 'yarn.lock'), 'utf8');
  const home = path.join(envsDir(envs), `node-${envKey(lock)}`);
  const modules = path.join(home, 'node_modules');
  if (!fs.existsSync(path.join(home, '.eccode-ready'))) {
    fs.mkdirSync(home, { recursive: true });
    for (const f of ['package.json', 'yarn.lock', '.npmrc', '.yarnrc']) {
      if (fs.existsSync(path.join(front, f))) fs.copyFileSync(path.join(front, f), path.join(home, f));
    }
    // Lifecycle scripts (nuxt prepare) belong to a tree, not to the cache.
    run('yarn', ['install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'], home, process.env);
    fs.writeFileSync(path.join(home, '.eccode-ready'), `${new Date().toISOString()}\n`);
  }
  const link = path.join(front, 'node_modules');
  if (!fs.existsSync(link)) fs.symlinkSync(modules, link, 'dir');
  return modules;
}

/** Environment variables that put a venv first, for a task's env or a script. */
function taskEnvVars(venv) {
  return {
    PATH: `${path.join(venv, 'bin')}${path.delimiter}${process.env.PATH}`,
    VIRTUAL_ENV: venv,
    UV_PROJECT_ENVIRONMENT: venv,
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

module.exports = { envKey, pythonEnv, nodeModules, taskEnvVars };

if (require.main === module) {
  const [what, tree] = process.argv.slice(2);
  if (!['python', 'node'].includes(what) || !tree) {
    process.stderr.write('usage: node env.js python|node <tree>\n');
    process.exit(2);
  }
  process.stdout.write(`${what === 'python' ? pythonEnv(path.resolve(tree)) : nodeModules(path.resolve(tree))}\n`);
}
