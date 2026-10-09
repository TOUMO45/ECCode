'use strict';
// Project lifecycle helpers shared by all domain modules.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Store } = require('./store');
const { loadConfig, writeDefaultConfig, configPath } = require('./config');
const { EccodeError, ensureDir, exists, toPosix, own, sha256 } = require('./util');
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

function git(root, args, { trim = true, input } = {}) {
  try {
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
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
/**
 * Digest of the source tree's CONTENT: the git blob id of every file's working-tree bytes
 * (tracked and untracked, outside .eccode/), sorted by path. Deliberately independent of
 * HEAD, the index and git status codes, so staging or committing between a check and the
 * completion or review that cites it does not change the digest; only different bytes do.
 * null when the project is not inside a git repository.
 */
function treeDigest(root) {
  if (!gitHead(root)) return null;
  const indexed = git(root, ['ls-files', '-s', '-z'], { trim: false }); // paths relative to the project root
  const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], { trim: false });
  const prefix = git(root, ['rev-parse', '--show-prefix']); // the project may sit below the repository root
  if (indexed === null || status === null || prefix === null) return null;
  const blobs = new Map();
  for (const entry of indexed.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [, blob] = entry.slice(0, tab).split(' ');
    blobs.set(entry.slice(tab + 1), blob);
  }
  // Files whose working-tree bytes differ from the index (modified, deleted, untracked): re-hash them.
  const dirty = [];
  const fields = status.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    if (code[0] === 'R' || code[0] === 'C') i++; // the original path follows in its own field
    const repoPath = entry.slice(3);
    if (!repoPath.startsWith(prefix)) continue;
    const rel = repoPath.slice(prefix.length);
    if (code[1] === ' ') continue; // staged only: the index blob already is the working content
    dirty.push(rel);
  }
  const existing = dirty.filter((rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  });
  for (const rel of dirty) if (!existing.includes(rel)) blobs.delete(rel);
  if (existing.length) {
    const hashed = git(root, ['hash-object', '--stdin-paths'], { trim: false, input: existing.join('\n') + '\n' });
    if (hashed === null) return null;
    const ids = hashed.trim().split('\n');
    existing.forEach((rel, i) => blobs.set(rel, ids[i]));
  }
  const lines = [];
  for (const [rel, blob] of blobs) if (!rel.startsWith('.eccode/')) lines.push(`${rel} ${blob}`);
  return sha256(lines.sort().join('\n'));
}

module.exports = { PROFILES, openProject, init, assertBudget, rolesFor, projectRelative, gitHead, gitChangedFiles, treeDigest };
