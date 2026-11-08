'use strict';
// GF-RUN-2's wrapper (design 18.4; S2.1, the owner's structural redesign of 2026-11-08). The runner has the frozen
// evidence runner execute this wrapper around the command, so the wrapper's verdict is the recorded result. It
//   (1) hashes every file of the REAL tree by walking the file system, not by asking git: content and mode, symlinks
//       by target (never followed), the git directories included (objects/ by name and size), .eccode/ included (S2.2)
//       except the three files the frozen record window restores and that window's lock files, the tools' caches
//       excepted;
//   (2) copies the tree without .git and .eccode/ into a new directory and runs the command there, where git finds no
//       repository;
//   (3) hashes the real tree again: any change outside the caller's group, anything in .git included, fails the run
//       (exit 99) and nothing is copied back;
//   (4) otherwise copies back each change of the copy whose path the caller's group owns, and discards (and lists)
//       every other change.
// Usage: node run-check.js <spec.json> -- <program> <args...>, where spec is {group, role, map, root, result}.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ownership = require('./ownership');

// The tools' own caches and result folders: not compared in the real tree, never copied back, not listed (18.4).
const CACHE = /(^|\/)(\.pytest_cache|__pycache__|\.ruff_cache|\.mypy_cache|test-results|playwright-report|htmlcov)(\/|$)|(^|\/)\.coverage$|\.pyc$/;
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'];
const isGit = (rel) => rel === '.git' || rel.startsWith('.git/');
const isRecord = (rel) => rel === '.eccode' || rel.startsWith('.eccode/');
// S2.2, H2-2: the files of .eccode/ the frozen record window restores (it puts them back and fails the run itself), and
// its lock files (another agent creates .lock.waiting-* while it waits to write the record). The rest of .eccode/ is
// compared, and counts as outside every group.
const RESTORED = /^\.eccode\/(events\.jsonl|state\.json|config\.json|\.lock|\.lock\.waiting-[^/]+)$/;

function hashFile(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** One entry's fingerprint: a symlink by its target, a file by mode and content (or size, for content-addressed files). */
function fingerprint(abs, st, bySize) {
  if (st.isSymbolicLink()) { try { return `l:${fs.readlinkSync(abs)}`; } catch { return 'l:?'; } }
  const mode = (st.mode & 0o7777).toString(8);
  if (st.isFile()) {
    if (bySize) return `o:${st.size}`;
    try { return `f:${mode}:${hashFile(abs)}`; } catch { return `f:${mode}:unreadable:${st.size}`; }
  }
  return `x:${st.mode.toString(8)}`;
}

/** Every file and symlink under `base`, keyed `prefix + relative path`; directories are walked, never followed through a link. */
function walk(base, prefix, out, skip = () => false, bySize = () => false) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let names;
    try { names = fs.readdirSync(rel ? path.join(base, rel) : base); } catch { out.set(`${prefix}${rel}/`, 'unreadable-directory'); continue; }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      let st;
      try { st = fs.lstatSync(path.join(base, r)); } catch { continue; }
      if (st.isDirectory()) stack.push(r);
      else out.set(`${prefix}${r}`, fingerprint(path.join(base, r), st, bySize(r)));
    }
  }
  return out;
}

/** The repository's git directories (the common one, and the worktree's own when it is elsewhere), absolute. */
function gitDirs(root) {
  const env = { ...process.env };
  for (const k of REPO_VARS) delete env[k];
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { encoding: 'utf8', env });
  if (r.status !== 0) return [];
  const [own, common] = r.stdout.trim().split('\n').map((p) => path.resolve(p));
  const inside = (p, d) => p === d || p.startsWith(d + path.sep);
  return inside(own, common) ? [{ dir: common, prefix: '.git/' }] : [{ dir: common, prefix: '.git/' }, { dir: own, prefix: '.git/(worktree)/' }];
}

/** The real tree's fingerprint (step 1 and step 3). */
function realSnapshot(root, dirs) {
  const out = new Map();
  walk(root, '', out, (r) => r === '.git' ? fs.lstatSync(path.join(root, r)).isDirectory() : (RESTORED.test(r) || CACHE.test(r)));
  for (const { dir, prefix } of dirs) walk(dir, prefix, out, () => false, (r) => r.startsWith('objects/'));
  return out;
}
const copySnapshot = (tree) => walk(tree, '', new Map(), (r) => CACHE.test(r));
const changedKeys = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();

/** Step 4: copy one change of the copy back to the real tree; returns null, or why it was discarded. */
function copyBack(root, tree, rel, present) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const a = path.join(root, ...parts.slice(0, i));
    let st = null;
    try { st = fs.lstatSync(a); } catch { break; } // missing from here down: created below
    if (st.isSymbolicLink()) return 'its real parent directory is a symlink';
    if (!st.isDirectory()) return 'its real parent is not a directory';
  }
  const dest = path.join(root, rel);
  let cur = null;
  try { cur = fs.lstatSync(dest); } catch { /* absent */ }
  if (cur && cur.isDirectory()) { try { fs.rmdirSync(dest); } catch { return 'the real path is a directory that is not empty'; } }
  if (!present) { if (cur && !cur.isDirectory()) fs.rmSync(dest, { force: true }); return null; }
  const src = path.join(tree, rel);
  const st = fs.lstatSync(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (cur && !cur.isDirectory()) fs.rmSync(dest, { force: true }); // replaced, never written through
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
  else if (st.isFile()) { fs.copyFileSync(src, dest); fs.chmodSync(dest, st.mode & 0o7777); }
  else return 'it is not a file or a symlink';
  return null;
}

function main() {
  const [specFile, sep, ...argv] = process.argv.slice(2);
  if (sep !== '--' || !argv.length) { process.stderr.write('usage: run-check.js <spec.json> -- <command...>\n'); return 64; }
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const root = fs.realpathSync(spec.root || process.cwd());
  const result = { outside: null, copiedBack: [], discarded: [] };
  const write = () => fs.writeFileSync(spec.result, JSON.stringify(result));
  const ownerOf = (rel) => (isGit(rel) || isRecord(rel) || !spec.map ? null : ownership.ownerOfPath(spec.map, rel));
  const say = (m) => process.stderr.write(`[gf-run] GF-RUN-2: ${m}\n`);
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-copy-'));
  try {
    const real = fs.realpathSync(holder);
    if (real === root || real.startsWith(root + path.sep)) { result.error = `the system's temporary directory (${os.tmpdir()}) is inside the project, so the copy would be part of the tree`; write(); say(`${result.error}: the run fails`); return 99; }
    const dirs = gitDirs(root);
    const before = realSnapshot(root, dirs);
    const tree = path.join(real, 'tree');
    fs.cpSync(root, tree, {
      recursive: true, verbatimSymlinks: true, preserveTimestamps: true,
      filter: (src) => {
        const r = path.relative(root, src).split(path.sep).join('/');
        if (r === '.git' || isRecord(r)) return false;
        try { const st = fs.lstatSync(src); return st.isDirectory() || st.isFile() || st.isSymbolicLink(); } catch { return false; }
      },
    });
    const copyBefore = copySnapshot(tree);
    const env = { ...process.env, PWD: tree, GIT_CEILING_DIRECTORIES: real };
    for (const k of REPO_VARS) delete env[k];
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', cwd: tree, env });
    const after = realSnapshot(root, dirs);
    result.outside = changedKeys(before, after).filter((k) => isGit(k) || isRecord(k) || !spec.group || ownerOf(k) !== spec.group);
    const copyAfter = copySnapshot(tree);
    const changes = changedKeys(copyBefore, copyAfter);
    const status = typeof r.status === 'number' ? r.status : (r.error && r.error.code === 'ENOENT' ? 127 : 1);
    if (result.outside.length) {
      result.discarded = changes.map((p) => ({ path: p, owner: ownerOf(p) }));
      write();
      say(`the run changed ${result.outside.join(', ')} in the real tree, outside ${spec.group ? `${spec.group}'s paths` : `any group's paths (${spec.role} is in no group)`}: the run fails, and nothing is copied back from its copy`);
      return 99;
    }
    // Deletions first (children before parents), then additions and changes.
    const order = [...changes.filter((p) => !copyAfter.has(p)).reverse(), ...changes.filter((p) => copyAfter.has(p))];
    for (const p of order) {
      const owner = ownerOf(p);
      if (isGit(p) || isRecord(p) || !spec.group || owner !== spec.group) { result.discarded.push({ path: p, owner }); continue; }
      const why = copyBack(root, tree, p, copyAfter.has(p));
      if (why) result.discarded.push({ path: p, owner, reason: why });
      else result.copiedBack.push(p);
    }
    write();
    if (result.discarded.length) say(`discarded (the run's change stays in its copy): ${result.discarded.map((d) => `${d.path} (${d.owner || 'no group'}${d.reason ? `; ${d.reason}` : ''})`).join(', ')}`);
    return status;
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
    write();
    say(`the runner could not run the command in a copy of the tree (${result.error}): the run fails`);
    return 99;
  } finally {
    try { fs.rmSync(holder, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { CACHE, realSnapshot, gitDirs };
if (require.main === module) process.exit(main());
