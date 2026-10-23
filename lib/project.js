'use strict';
// Project lifecycle helpers shared by all domain modules.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('./store');
const { loadConfig, writeDefaultConfig, configPath } = require('./config');
const { EccodeError, ensureDir, exists, toPosix, sha256File } = require('./util');
const { gateKind } = require('./reducer');

function openProject(root) {
  const store = new Store(root);
  return { store, config: store.isInitialized() ? loadConfig(store.root) : null };
}

function init(root, { name, idea, actor = 'orchestrator', track, quick } = {}) {
  const store = new Store(root);
  if (store.isInitialized()) {
    throw new EccodeError('ALREADY_INITIALIZED', `ECCode project already exists at ${store.root}`);
  }
  if (!name || !idea) throw new EccodeError('INVALID_INPUT', 'init requires --name and --idea');
  // A quick record without its one-task plan has nothing to claim: build the
  // plan before anything is written, so a refusal leaves no record behind.
  let quickPlan = null;
  if (track === 'quick') {
    if (!quick || !quick.owner || !quick.files || !quick.command) {
      throw new EccodeError('INVALID_INPUT', 'A quick record needs its one task: eccode quick "<request>" sets it up (or pass --owner, --files and --command to init)');
    }
    quickPlan = require('./works').quickPlan(loadConfig(store.root), { ...quick, title: quick.title || idea });
  }
  for (const sub of ['artifacts', 'evidence', 'reviews', 'handoffs', 'memory', 'delivery']) ensureDir(store.path(sub));
  if (!exists(configPath(store.root))) writeDefaultConfig(store.root);
  const gitignore = store.path('.gitignore');
  if (!exists(gitignore)) fs.writeFileSync(gitignore, '.lock\n*.tmp\ncache/\n');
  // The git base lets delivery prove that every file changed since the project
  // started was reviewed. Files already dirty now are pinned by hash so that
  // pre-existing local changes are not attributed to the delivery.
  const baseCommit = gitHead(store.root);
  const dirtyAtInit = {};
  for (const f of (baseCommit && gitChangedFiles(store.root, baseCommit)) || []) {
    const abs = path.join(store.root, f);
    if (!f.startsWith('.eccode/') && exists(abs) && fs.statSync(abs).isFile()) dirtyAtInit[f] = sha256File(abs);
  }
  store.commit('project.initialized', actor, { name, idea, ...(track ? { track } : {}), ...(quickPlan ? { title: quickPlan.tasks[0].title } : {}), ...(baseCommit ? { baseCommit, dirtyAtInit } : {}) });
  if (quickPlan) store.commit('plan.imported', actor, { phases: quickPlan.phases, tasks: quickPlan.tasks, source: 'auto:quick' });
  return store;
}

/** Throws when recorded spend or runtime is at/over the configured limit. */
function assertBudget(state, config) {
  const { maxCostUsd, maxRuntimeMinutes } = config.limits;
  const problems = [];
  if (state.totals.costUsd >= maxCostUsd) problems.push(`cost $${state.totals.costUsd} >= limit $${maxCostUsd}`);
  if (state.totals.runtimeMinutes >= maxRuntimeMinutes) {
    problems.push(`runtime ${state.totals.runtimeMinutes}min >= limit ${maxRuntimeMinutes}min`);
  }
  if (problems.length) {
    throw new EccodeError('BUDGET_EXCEEDED', `Budget exhausted: ${problems.join('; ')}`, {
      recovery: 'Stop and report to the user. Raising limits in .eccode/config.json requires the user\'s explicit authorization.',
    });
  }
}

function rolesFor(config, gateId) {
  const roles = config.roles[gateKind(gateId)];
  if (!roles) throw new EccodeError('UNKNOWN_GATE', `No role configuration for gate kind "${gateKind(gateId)}"`);
  return roles;
}

/** Resolve a user-supplied path to a project-relative posix path, refusing escapes. */
function projectRelative(root, p) {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new EccodeError('PATH_OUTSIDE_PROJECT', `Path ${p} is outside the project root`);
  }
  return toPosix(rel);
}

function git(root, args) {
  try {
    // 64 MiB: file listings of large repositories overflow Node's 1 MiB default buffer.
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

function gitHead(root) {
  return git(root, ['rev-parse', 'HEAD']);
}

/** Files changed relative to a base commit, including untracked files. */
function gitChangedFiles(root, base) {
  if (!base) return null;
  const diff = git(root, ['diff', '--name-only', '--relative', base]); // --relative: paths from the project root, not the repo root
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (diff === null) return null;
  return [...new Set([...diff.split('\n'), ...(untracked || '').split('\n')].filter(Boolean))];
}

module.exports = { openProject, init, assertBudget, rolesFor, projectRelative, git, gitHead, gitChangedFiles };
