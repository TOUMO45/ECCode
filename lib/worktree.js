'use strict';
// Isolated worktrees for a baseline and a candidate (Phase 3). The same code
// as the behavior diff's (lib/behavior.js worktreeAt/overlay, which the H-B
// freeze keeps unexported): a detached worktree at a commit, dependency
// directories linked in, the project's .eccode configuration copied, and the
// working tree's changes laid over a worktree at HEAD for the candidate.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { git, gitHead, gitChangedFiles } = require('./project');
const { EccodeError, exists, toPosix } = require('./util');

const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];
const CONFIG_FILES = ['behavior.json', 'guards.json', 'security.json'];

function worktreeAt(root, sha, label) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  const prefix = git(root, ['rev-parse', '--show-prefix']) || '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `eccode-${label}-`));
  const wt = path.join(tmp, label);
  if (git(top, ['worktree', 'add', '--detach', '--quiet', wt, sha]) === null) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new EccodeError('GIT_FAILED', `Could not create the ${label} worktree at ${String(sha).slice(0, 12)}`);
  }
  const treeRoot = path.join(wt, prefix);
  for (const d of DEP_DIRS) {
    if (exists(path.join(root, d)) && !exists(path.join(treeRoot, d))) fs.symlinkSync(path.join(root, d), path.join(treeRoot, d), process.platform === 'win32' ? 'junction' : 'dir');
  }
  for (const f of CONFIG_FILES) {
    const cfg = path.join(root, '.eccode', f);
    if (exists(cfg)) {
      fs.mkdirSync(path.join(treeRoot, '.eccode'), { recursive: true });
      fs.copyFileSync(cfg, path.join(treeRoot, '.eccode', f));
    }
  }
  const remove = () => {
    git(top, ['worktree', 'remove', '--force', wt]);
    git(top, ['worktree', 'prune']);
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { root: treeRoot, tmp, remove };
}

/** The working tree's changes laid over a worktree: the candidate. */
function overlay(root, treeRoot, files) {
  for (const f of files) {
    const src = path.join(root, f);
    const dst = path.join(treeRoot, f);
    if (exists(src) && fs.statSync(src).isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } else fs.rmSync(dst, { force: true });
  }
}

/** Files changed since `base`, outside the record. */
function changedSince(root, base) {
  return ((base && gitChangedFiles(root, base)) || []).map(toPosix).filter((f) => !f.startsWith('.eccode/'));
}

/**
 * Run `fn({baseline, candidate, changed})` with a baseline worktree at `base`
 * and a candidate worktree at HEAD plus the working tree's changes; both are
 * removed afterwards whatever happens.
 */
function withSides(root, base, fn) {
  const baseSha = git(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (!baseSha) throw new EccodeError('NOT_FOUND', `Unknown base ${base}`);
  const head = gitHead(root);
  const changed = changedSince(root, base);
  const baseline = worktreeAt(root, baseSha, 'baseline');
  let candidate = null;
  try {
    candidate = worktreeAt(root, head, 'candidate');
    overlay(root, candidate.root, changed);
    return fn({ baseline, candidate, changed, baseSha, head });
  } finally {
    if (candidate) candidate.remove();
    baseline.remove();
  }
}

module.exports = { DEP_DIRS, worktreeAt, overlay, changedSince, withSides };
