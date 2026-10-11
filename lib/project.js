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
  // A record inside a record would let the guard mistake the outer record for project files.
  const realRoot = (() => { try { return fs.realpathSync(path.resolve(root)); } catch { return path.resolve(root); } })();
  if (path.resolve(root).split(path.sep).includes('.eccode') || realRoot.split(path.sep).includes('.eccode')) {
    throw new EccodeError('INVALID_INPUT', `a project cannot be initialised inside an ECCode record directory (${path.resolve(root)})`);
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

/**
 * Every GIT_* variable. Inherited from the caller (an inline `GIT_DIR=…`, a git hook's GIT_DIR and
 * GIT_INDEX_FILE, a GIT_CONFIG_* override, GIT_ATTR_SOURCE), they made the engine's git calls look at
 * another repository, config or attributes, or none: no tree, no marker, no commit, no ownership
 * accounting (TK-6 R3-1). All of them, not a list, because git grows new ones (R4-4); the engine's calls
 * are local and read-only and need none (GIT_TERMINAL_PROMPT and the like go too, harmlessly).
 * Case-insensitive because Windows environment names are. A repository reachable only through
 * GIT_DIR/GIT_WORK_TREE is therefore outside git for the engine (R4-3); `.git` files, linked worktrees and
 * --separate-git-dir are found from the project directory as usual.
 */
const GIT_ENV = /^GIT_/i;

/** The environment the engine runs git with: the caller's, minus every GIT_* variable, so discovery starts from the project directory. */
function gitEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!GIT_ENV.test(k)) out[k] = v;
  return out;
}

function git(root, args, { trim = true, input } = {}) {
  try {
    const out = execFileSync('git', args, { cwd: root, env: gitEnv(), encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
    return trim ? out.trim() : out;
  } catch {
    return null;
  }
}

function gitHead(root) {
  return git(root, ['rev-parse', 'HEAD']);
}

/**
 * Whether `root` is inside a git work tree. This, not a HEAD that resolves, is what "inside git" means for
 * tree pinning: a fresh repository before its first commit, or one `git checkout --orphan` away, has a
 * work tree and an index but no HEAD commit, and was read as "outside git" by 0.3.4's first two rounds
 * (TK-6 R2-1).
 */
function insideWorkTree(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/**
 * A path git prints on its own line (`--show-toplevel`, `--show-prefix`), minus exactly the newline git
 * adds: a directory name may start or end with a space, and a trimmed name is another directory (TK-6 F3).
 */
function gitPathLine(root, args) {
  const out = git(root, args, { trim: false });
  return out === null ? null : out.replace(/\n$/, '');
}

/**
 * A path in git's C-quoted form ("…" with \\, \", \n, \r, \t and other control bytes escaped), which
 * `hash-object --stdin-paths` unquotes: a raw line splits a name holding a newline, loses a trailing CR,
 * and unquotes a name that itself starts with a double quote (TK-6 F4).
 */
function cQuote(p) {
  const named = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  return `"${p.replace(/["\\\x00-\x1f\x7f]/g, (c) => named[c] || `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;
}

/**
 * Files changed relative to a base commit, including untracked files. A staged rename is reported as both
 * paths (--no-renames): the old path left the tree and must be declared like any deletion, or a `git mv`
 * inside a task's ownership would move a file out of the reviewed set without any handoff naming it.
 */
function gitChangedFiles(root, base) {
  if (!base) return null;
  const diff = git(root, ['diff', '--name-only', '--no-renames', '--relative', base]); // --relative: paths from the project root, not the repo root
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (diff === null) return null;
  return [...new Set([...diff.split('\n'), ...(untracked || '').split('\n')].filter(Boolean))];
}

/**
 * Digest of the source tree's CONTENT: the git blob id of every file's working-tree bytes
 * (tracked and untracked, outside .eccode/), sorted by path. Deliberately independent of
 * HEAD, the index and git status codes, so staging or committing between a check and the
 * completion or review that cites it does not change the digest; only different bytes do.
 * Command evidence carries it, so a check is tied to the bytes it ran on. null when the
 * project is not inside a git work tree (or git fails); HEAD need not resolve (R2-1).
 *
 * The project may sit below the repository root (examples/<app>): `ls-files` reports paths
 * relative to the project, `status` relative to the repository, and `hash-object --stdin-paths`
 * resolves its input from the repository's top level whatever the working directory (TK-6), so
 * dirty files are hashed by their repository path, run from the top level.
 */
function treeDigest(root) {
  if (!insideWorkTree(root)) return null;
  const indexed = git(root, ['ls-files', '-s', '-z'], { trim: false }); // paths relative to the project root
  const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], { trim: false });
  const prefix = gitPathLine(root, ['rev-parse', '--show-prefix']); // the project may sit below the repository root
  const top = gitPathLine(root, ['rev-parse', '--show-toplevel']);
  if (indexed === null || status === null || prefix === null || !top) return null;
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
    if (rel.startsWith('.eccode/')) continue; // the record is excluded from the digest: never hash it (TK-6)
    dirty.push(rel);
  }
  const existing = dirty.filter((rel) => {
    try {
      return fs.statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  });
  const present = new Set(existing);
  for (const rel of dirty) if (!present.has(rel)) blobs.delete(rel);
  if (existing.length) {
    // --stdin-paths resolves its input from the repository's top level, not from `root` (TK-6): pass
    // repository paths and run from the top level, so a nested project's file is never read from its
    // same-named twin at the repository root, nor reported missing when it has none. One C-quoted
    // path per line, so no file name can split, shorten or unquote a line (F4).
    const input = existing.map((rel) => cQuote(prefix + rel)).join('\n') + '\n';
    const hashed = git(top, ['hash-object', '--stdin-paths'], { trim: false, input });
    if (hashed === null) return null;
    const ids = hashed.trim().split('\n');
    existing.forEach((rel, i) => blobs.set(rel, ids[i]));
  }
  const lines = [];
  for (const [rel, blob] of blobs) if (!rel.startsWith('.eccode/')) lines.push(`${rel} ${blob}`);
  return sha256(lines.sort().join('\n'));
}

/** What the CLI prints when a run, submission or release is recorded with tree pinning off (TK-6 F2, R2-4, R4-2). */
function treeUnavailableWarning(what) {
  const consequence = {
    run: 'this run cannot be cited while the digest is available again',
    submission: 'its commit is recorded; the review compares the checks it cites with the digest at review time',
    release: 'the release commit is recorded without the tree digest',
  }[what];
  return `tree pinning is off for this ${what}: the source tree digest could not be computed (the project is in a git work tree, or its record already pins trees, but git failed or no longer shows a work tree), so nothing ties it to the bytes it covers (threat model residual 16); ${consequence}`;
}

/**
 * Whether the record pins trees and commits (an engine of 0.3.0 or later wrote it): some command run
 * carries a tree (or the treeUnavailable marker), or some submission a commit. A record with none of them
 * is an older engine's, or one begun outside git, where a run or submission without them is the norm.
 */
function recordsPins(state) {
  if (Object.values(state.evidence || {}).some((e) => e.tree || e.treeUnavailable)) return true;
  return state.gateOrder.some((id) => state.gates[id].submissions.some((s) => s.commit || s.treeUnavailable));
}

/**
 * The tree fields a run, submission or release records: `{ tree }`; `{ treeUnavailable: true }` when the
 * digest is null inside a git work tree (whether or not HEAD resolves, R2-1) or in a record that already
 * pins (`pinned`: a project does not leave git in the middle of a delivery, so "not a work tree" there is
 * a failing git, R4-2) — a defect to see, not a reason to stay silent, as TK-6 was for a whole pilot;
 * `{}` otherwise (no git, an older record), where a check is legitimately unpinned and replays unchanged.
 */
function treePin(root, { pinned = false } = {}) {
  const tree = treeDigest(root);
  if (tree) return { tree };
  return pinned || insideWorkTree(root) ? { treeUnavailable: true } : {};
}

module.exports = { PROFILES, openProject, init, assertBudget, rolesFor, projectRelative, gitEnv, gitHead, insideWorkTree, gitChangedFiles, treeDigest, treePin, recordsPins, treeUnavailableWarning };
