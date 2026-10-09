'use strict';
// Project lifecycle helpers shared by all domain modules.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('./store');
const { loadConfig, writeDefaultConfig, configPath } = require('./config');
const { EccodeError, ensureDir, exists, toPosix, own, sha256, sha256File } = require('./util');
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

function git(root, args, { trim = true } = {}) {
  try {
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return trim ? out.trim() : out;
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

/**
 * Digest of the source tree as it is now: the HEAD commit plus one line per file git reports as changed
 * or untracked ("<status> <path> <sha256>", "-" for a deleted file), the record under .eccode/ excluded.
 * Command evidence carries it, so a check is tied to the bytes it ran on. null without git.
 */
function treeDigest(root) {
  const head = gitHead(root);
  if (!head) return null;
  const prefix = git(root, ['rev-parse', '--show-prefix']); // the project may sit below the repository root
  const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], { trim: false });
  if (prefix === null || status === null) return null;
  const lines = [];
  const fields = status.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    if (code[0] === 'R' || code[0] === 'C') i++; // the original path follows in its own field; the new path is on disk
    const repoPath = entry.slice(3);
    if (!repoPath.startsWith(prefix)) continue;
    const rel = repoPath.slice(prefix.length);
    if (rel.startsWith('.eccode/')) continue;
    let digest = '-';
    try {
      const abs = path.join(root, rel);
      if (fs.statSync(abs).isFile()) digest = sha256File(abs);
    } catch {
      /* deleted or unreadable: "-" */
    }
    lines.push(`${code} ${rel} ${digest}`);
  }
  return sha256([head, ...lines.sort()].join('\n'));
}

module.exports = { PROFILES, openProject, init, assertBudget, rolesFor, projectRelative, gitHead, gitChangedFiles, treeDigest };
