'use strict';
// Project lifecycle helpers shared by all domain modules.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('./store');
const { loadConfig, writeDefaultConfig, configPath } = require('./config');
const { EccodeError, ensureDir, exists, toPosix, own } = require('./util');
const { gateKind } = require('./reducer');

function openProject(root) {
  const store = new Store(root);
  return { store, config: store.isInitialized() ? loadConfig(store.root) : null };
}

// delivery: a product idea through architecture -> design -> plan -> phases -> verification.
// change:   a change request on an existing codebase through plan -> phases.
const PROFILES = ['delivery', 'change'];

function init(root, { name, idea, actor = 'orchestrator', profile = 'delivery' }) {
  const store = new Store(root);
  if (store.isInitialized()) {
    throw new EccodeError('ALREADY_INITIALIZED', `ECCode project already exists at ${store.root}`);
  }
  if (!name || !idea) throw new EccodeError('INVALID_INPUT', 'init requires --name and --idea');
  if (!PROFILES.includes(profile)) throw new EccodeError('INVALID_INPUT', `--profile must be ${PROFILES.join('|')}`);
  for (const sub of ['artifacts', 'evidence', 'reviews', 'handoffs', 'memory', 'delivery']) ensureDir(store.path(sub));
  if (!exists(configPath(store.root))) writeDefaultConfig(store.root);
  const gitignore = store.path('.gitignore');
  if (!exists(gitignore)) fs.writeFileSync(gitignore, '.lock\n*.tmp\n');
  // The profile is written only when it is not the default, so default logs replay unchanged.
  store.commit('project.initialized', actor, profile === 'delivery' ? { name, idea } : { name, idea, profile });
  return store;
}

/**
 * Throws when the recorded spend or runtime is at/over its limit, or when the
 * recorded spend plus the in-flight reservation (limits.reserveUsdPerRun for
 * every open run and for the run the new work implies) would exceed maxCostUsd.
 * Recorded spend is what the orchestrator reported after each run: runs with
 * unknown usage make it a lower bound, and the refusal says so.
 */
function assertBudget(state, config) {
  const { maxCostUsd, maxRuntimeMinutes } = config.limits;
  const { spendAccounting } = require('./runs'); // required here: lib/runs.js requires this module for assertBudget
  const spend = spendAccounting(state, config);
  const problems = [];
  if (spend.costUsd >= maxCostUsd) {
    problems.push(`cost $${spend.costUsd} >= limit $${maxCostUsd}`);
  } else if (spend.reserveUsdPerRun) {
    const slots = spend.running.length + 1;
    const reserved = Math.round(slots * spend.reserveUsdPerRun * 10000) / 10000;
    if (spend.costUsd + reserved > maxCostUsd) {
      problems.push(`cost $${spend.costUsd} + $${reserved} reserved for ${slots} run(s) in flight (${spend.running.length} open + 1 new, $${spend.reserveUsdPerRun} each) > limit $${maxCostUsd}`);
    }
  }
  if (spend.runtimeMinutes >= maxRuntimeMinutes) {
    problems.push(`runtime ${spend.runtimeMinutes}min >= limit ${maxRuntimeMinutes}min`);
  }
  if (problems.length) {
    const unknown = spend.unknownUsage.length
      ? ` Recorded spend is a lower bound: ${spend.unknownUsage.length} run(s) closed with unknown usage (${spend.unknownUsage.join(', ')}); fill them in first: eccode run correct <runId> --tokens <n> --cost-usd <x> --reason <text> --actor orchestrator.`
      : '';
    throw new EccodeError('BUDGET_EXCEEDED', `Budget exhausted: ${problems.join('; ')}.${unknown}`, {
      recovery: 'Stop and report to the user. Raising limits in .eccode/config.json requires the user\'s explicit authorization.',
      unknownUsage: spend.unknownUsage,
    });
  }
}

function rolesFor(config, gateId) {
  const roles = own(config.roles, gateKind(gateId));
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
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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

module.exports = { PROFILES, openProject, init, assertBudget, rolesFor, projectRelative, gitHead, gitChangedFiles };
