'use strict';
// S2.4 (design 21): kernel-enforced group isolation. Three engine steps, all outside the sandbox:
//   GF-ISO-1  a group role's command runs in the group's own git worktree inside a kernel sandbox (sandbox.js) whose
//             write set is the group's owned paths and a private tmp; the worktree is a detached checkout of the real
//             tree's HEAD with the group's owned files synced in from the real tree before the run, and only the
//             group's own-path changes are synced back afterwards (nothing else can have changed: the kernel refused).
//   GF-ISO-2  the commit step: the group's changed files in the real tree, validated against the ownership map and the
//             claimed task BEFORE any git write (regular files only, no symlink in the path, one link, NFC names),
//             are hashed once and committed as exactly those blobs through plumbing onto the group's branch, with a
//             sanitized environment and no hook, filter, editor or pager; the ref update is compare-and-swap.
//   GF-ISO-3  the merge step: the groups' branches are merged into the integration branch in the breakdown's dependency
//             order, in memory (git merge-tree), only after the declared deterministic checks passed; a conflict is a
//             GF-OWN violation signal and stops the merge.
// Plus the engine-mediated dependency install (network allowed, write set = the dependency directories) and GF-ISO-4's
// widening record. The S2.x copy runner stays for roles in no group and as the owner's explicit fallback.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { matchesAny, newId } = require('../util');
const evidence = require('../evidence');
const ownership = require('./ownership');
const ownershipOps = require('./ownership-ops');
const sandbox = require('./sandbox');
const events = require('./events');
const { project } = require('./projection');
const { ruleError } = require('./errors');
const { CACHE } = require('./run-check');
const C = require('./constants');

const P = (rule, message) => ({ rule, message });
const WORKTREES = '.gf-worktrees';
const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];
const NEVER_COMMIT = new Set(['.gitattributes', '.gitmodules']);
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The sanitized environment every engine git call runs with (GF-ISO-2): no user or system config, no hook, no helper command. */
function gitEnv(gitDir, workTree) {
  return {
    PATH: SYSTEM_PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: '/nonexistent', TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', GIT_PAGER: 'cat', PAGER: 'cat', GIT_ASKPASS: '/bin/false', GIT_SSH_COMMAND: '/bin/false',
    GIT_DIR: gitDir, GIT_WORK_TREE: workTree, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
  };
}
const GIT_OPTS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false', '-c', 'core.autocrlf=false', '-c', 'core.filemode=true', '-c', 'core.symlinks=true', '-c', 'protocol.allow=never', '-c', 'uploadpack.allowFilter=false'];

function git(root, args, { gitDir, workTree = root, input, allowFail = false, env = {} } = {}) {
  const gd = gitDir || gitDirOf(root);
  const r = spawnSync('git', [...GIT_OPTS, ...args], { cwd: workTree, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, env: { ...gitEnv(gd, workTree), ...env } });
  if (r.status !== 0 && !allowFail) throw ruleError([P('GF-ISO-2', `git ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`)]);
  return r;
}
function gitDirOf(root) {
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-dir'], { encoding: 'utf8', env: { PATH: SYSTEM_PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (r.status !== 0) throw ruleError([P('GF-ISO-2', `${root} is not a git repository`)]);
  return r.stdout.trim();
}
function commonDirOf(root) {
  return spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: { PATH: SYSTEM_PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).stdout.trim();
}

/** GF-ISO-2: the repository's own config may not pull in other files or name helper programs the engine would run. */
function configProblems(root) {
  const r = git(root, ['config', '--file', path.join(commonDirOf(root), 'config'), '--list', '--name-only'], { allowFail: true });
  const names = (r.stdout || '').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = names.filter((n) => n.startsWith('include.') || n.startsWith('includeif.') || n.startsWith('filter.') || n.endsWith('.textconv') || n.endsWith('.command') || n === 'core.sshcommand' || n === 'core.gitproxy' || n === 'core.hookspath' || n === 'core.fsmonitor' || n.startsWith('credential.'));
  return bad.map((n) => P('GF-ISO-2', `the repository configuration sets ${n}: the engine commits only from a repository whose own config names no include, filter, textconv, external command or hook path (remove it, or move it to your user config, which the engine never reads)`));
}

function cfgOf(store, config) {
  const c = (config && config.gf) || {};
  return { isolation: c.isolation || 'kernel', sandboxEnv: Array.isArray(c.sandboxEnv) ? c.sandboxEnv : [] };
}

function groupOf(store, config, role) {
  const loaded = ownershipOps.loadMap(store, config);
  if (!loaded.map) return { problems: loaded.problems };
  return { map: loaded.map, group: ownership.groupOfRole(loaded.map, role) };
}

// ------------------------------------------------------------------ worktrees
function worktreeDir(root, group) { return path.join(root, WORKTREES, group); }

/** The engine's exclude entry for the worktrees directory (the engine writes the common dir; a group role cannot). */
function ensureExcluded(root) {
  const file = path.join(commonDirOf(root), 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!text.split('\n').includes(`/${WORKTREES}/`)) fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}/${WORKTREES}/\n`);
}

/** The group's worktree, a detached checkout of the real tree's HEAD, clean, with the dependency directories linked. */
function refreshWorktree(root, group) {
  ensureExcluded(root);
  const dir = worktreeDir(root, group);
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const exists = fs.existsSync(path.join(dir, '.git'));
  if (!exists) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    git(root, ['worktree', 'prune'], { allowFail: true });
    git(root, ['worktree', 'add', '-q', '--detach', dir, head]);
  } else {
    const wgd = gitDirOf(dir);
    git(dir, ['checkout', '-q', '--detach', head], { gitDir: wgd });
    git(dir, ['reset', '-q', '--hard'], { gitDir: wgd });
    git(dir, ['clean', '-fdxq'], { gitDir: wgd });
  }
  for (const d of DEP_DIRS) {
    const real = path.join(root, d); const link = path.join(dir, d);
    try { fs.lstatSync(link); continue; } catch { /* absent */ }
    if (fs.existsSync(real)) fs.symlinkSync(real, link);
  }
  return { dir, head };
}

/**
 * Entries under `base` (relative paths), caches skipped. Regular files always; symlinks and special files only when
 * `all`. For the commit step (`all`), a symlinked directory is also descended (following it, loop-guarded) so a regular
 * file reached through it surfaces and the resolve check refuses it; the symlink entry itself is listed too.
 */
function filesUnder(base, rel, out, all = false, seen = new Set(), depth = 0) {
  const abs = path.join(base, rel);
  let st; try { st = fs.lstatSync(abs); } catch { return out; }
  if (st.isDirectory()) {
    if (rel === '.git' || rel === '.eccode' || rel === WORKTREES || CACHE.test(rel)) return out;
    for (const n of fs.readdirSync(abs).sort()) filesUnder(base, rel ? `${rel}/${n}` : n, out, all, seen, depth);
    return out;
  }
  if (st.isSymbolicLink() && all) {
    let target; try { target = fs.statSync(abs); } catch { out.push(rel); return out; } // broken link: a non-regular entry the commit step refuses
    if (target.isDirectory() && depth < 40) {
      // Descend through the symlinked directory WITHOUT listing the link itself, so the regular files reached through it
      // surface and the resolve check is the only thing that refuses them (the link entry would trip the regular-file check).
      let real; try { real = fs.realpathSync(abs); } catch { return out; }
      if (seen.has(real)) return out; seen.add(real);
      for (const n of fs.readdirSync(abs).sort()) filesUnder(base, rel ? `${rel}/${n}` : n, out, all, seen, depth + 1);
      return out;
    }
    out.push(rel); // a symlink to a file or a special target: a non-regular entry the commit step refuses
    return out;
  }
  if (CACHE.test(rel)) return out;
  if (st.isFile() || all) out.push(rel);
  return out;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function same(a, b) {
  let sa, sb; try { sa = fs.lstatSync(a); } catch { sa = null; } try { sb = fs.lstatSync(b); } catch { sb = null; }
  if (!sa && !sb) return true; if (!sa || !sb || !sa.isFile() || !sb.isFile()) return false;
  if (sa.size !== sb.size || (sa.mode & 0o111) !== (sb.mode & 0o111)) return false;
  return sha(fs.readFileSync(a)) === sha(fs.readFileSync(b));
}
function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { if (fs.lstatSync(to).isSymbolicLink()) fs.unlinkSync(to); } catch { /* absent */ }
  fs.copyFileSync(from, to);
  fs.chmodSync(to, fs.statSync(from).mode & 0o777);
}

/** Mirror the group's owned files (regular files only, where the group's globs own them) from `from` into `to`. Returns the paths changed. */
function mirrorOwned(from, to, map, group, ws) {
  const changed = []; const discarded = [];
  const roots = [...ws.dirs, ...ws.files];
  const seen = new Set();
  for (const r of roots) {
    for (const rel of filesUnder(from, r, [])) {
      seen.add(rel);
      if (ownership.ownerOfPath(map, rel) !== group) { if (!same(path.join(from, rel), path.join(to, rel))) discarded.push(rel); continue; }
      if (same(path.join(from, rel), path.join(to, rel))) continue;
      copyFile(path.join(from, rel), path.join(to, rel)); changed.push(rel);
    }
    for (const rel of filesUnder(to, r, [])) {
      if (seen.has(rel) || ownership.ownerOfPath(map, rel) !== group) continue;
      fs.rmSync(path.join(to, rel), { force: true }); changed.push(rel); // deleted on the other side
    }
  }
  return { changed: changed.sort(), discarded: discarded.sort() };
}

// ------------------------------------------------------------------ GF-ISO-1: the sandboxed run
/**
 * Run `inner` (argv, or a shell string when `shell` is set) as `actor` in the group's worktree inside the sandbox,
 * through the frozen evidence runner. Returns the runner's result plus `isolation`.
 */
function run(store, config, actor, { label, command, display, purpose, task, shell = false }) {
  const cfg = cfgOf(store, config);
  const refused = sandbox.groupModeProblems(cfg);
  if (refused.length) throw ruleError(refused);
  const g = groupOf(store, config, actor);
  if (!g.map) throw ruleError(g.problems.map((p) => P('GF-ISO-1', `the ownership map cannot be loaded: ${p.message}`)));
  if (!g.group) throw ruleError([P('GF-ISO-1', `${actor} is in no group: the sandboxed runner is for group roles`)]);
  const ws = sandbox.writeSet(g.map, g.group);
  if (ws.problems.length) throw ruleError(ws.problems);
  const pr = sandbox.probe();
  // R-1 (S2.4 review): the mechanism must be one the self-test actually contained, not merely one that is available.
  const mechanism = sandbox.choose(pr, ws, sandbox.selfTest().usable);
  if (!mechanism) throw ruleError([P('GF-ISO-0', `no self-test-passing kernel mechanism is available for ${g.group}'s write set (fail closed): usable ${JSON.stringify(sandbox.selfTest().usable)}${ws.carveouts.length ? ', and the write set has carve-outs that need bubblewrap' : ''}`)]);
  const widened = [...ws.widened];
  if (mechanism === 'landlock' && ws.carveouts.length) for (const c of ws.carveouts) widened.push({ glob: `deny ${c}/**`, directory: c, reason: 'Landlock cannot carve a directory out of a writable one; the commit step refuses the path' });
  const checked = recordSelfTest(store, actor); // GF-ISO-0, recorded once per process
  // A1 (S2.4.1): authorize THIS run with a canary of the run's exact shape (same mechanism, write-set width, net, uid,
  // scrubbed env), so the self-test that clears the run cannot diverge from the run. Refuse fail-closed if not contained
  // or if the canary's mechanism is not the one the run will use (parity).
  const rwDirs = ws.dirs.length + ws.files.length;
  const canary = sandbox.authorizeRun(mechanism, { rwDirs: Math.max(1, rwDirs), net: false });
  if (!canary.ok || canary.mechanism !== mechanism) throw ruleError([P('GF-ISO-0', `the per-run canary for ${mechanism} (width ${rwDirs}, uid ${pr.uid}) was not contained or diverged from the run (${JSON.stringify({ mechanism: canary.mechanism, ok: canary.ok, ptraceSafe: canary.ptraceSafe })}); the run is refused (fail closed)`)]);
  const { dir: wt, head } = refreshWorktree(store.root, g.group);
  const syncedIn = mirrorOwned(store.root, wt, g.map, g.group, ws);
  for (const d of ws.dirs) fs.mkdirSync(path.join(wt, d), { recursive: true });
  const rw = ws.dirs.map((d) => path.join(wt, d));
  const rwFiles = ws.files.map((f) => path.join(wt, f)).filter((f) => { try { return fs.lstatSync(f).isFile(); } catch { return false; } });
  const carveouts = mechanism === 'bwrap' ? ws.carveouts.map((c) => { fs.mkdirSync(path.join(wt, c), { recursive: true }); return path.join(wt, c); }) : [];
  const tmp = sandbox.privateTmp(store.root, g.group);
  const others = Object.keys(g.map.groups).filter((x) => x !== g.group).map((x) => worktreeDir(store.root, x));
  const disjoint = sandbox.disjointProblems(wt, [...rw, ...rwFiles], tmp, [fs.realpathSync(store.root), ...others]);
  if (disjoint.length) { fs.rmSync(tmp, { recursive: true, force: true }); throw ruleError(disjoint); }
  const env = sandbox.scrubEnv(process.env, { tmp, project: store.root, pass: cfg.sandboxEnv });
  const innerArgv = shell ? ['sh', '-c', String(command)] : command;
  const a = sandbox.argv(mechanism, { cwd: wt, rw, rwFiles, carveouts, tmp, net: false, probe: pr }, innerArgv);
  const envPrefix = ['env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  const line = [...envPrefix, ...a].map(quote).join(' ');
  const weaker = mechanism !== 'both' ? (pr.weaker && pr.weaker[mechanism]) || `${mechanism} is weaker than the Landlock+bubblewrap combination` : null;
  const isolation = { rule: 'GF-ISO-1', mechanism, weaker, landlockAbi: pr.landlock ? pr.landlock.abi : null, bwrap: pr.bwrap ? pr.bwrap.version : null, pidns: pr.pidns, worktree: `${WORKTREES}/${g.group}`, head, writable: { dirs: ws.dirs, files: ws.files }, carveouts: ws.carveouts, widened, network: mechanism === 'landlock' ? 'TCP denied (Landlock net scope); UDP/DNS open (L-GF-79)' : 'denied', tmp: 'private, wiped', env: 'scrubbed', selfTest: checked, canary: { mechanism: canary.mechanism, rwDirs: canary.rwDirs, net: canary.net, uid: canary.uid, ok: canary.ok, ptraceSafe: canary.ptraceSafe, netUdpOpen: canary.netUdpOpen } };
  const ev = evidence.runCommand(store, actor, { label, command: line, purpose: purpose || 'check', task, externalCwd: wt, cwdLabel: `${WORKTREES}/${g.group}`, extra: { command: evidence.redact(String(display || (shell ? command : command.join(' ')))), isolation } });
  fs.rmSync(tmp, { recursive: true, force: true });
  // Only the group's own-path changes come back; anything else that changed in a widened directory is discarded.
  const back = mirrorOwned(wt, store.root, g.map, g.group, ws);
  const problems = [];
  if (ev.exitCode === 125) problems.push(P('GF-ISO-0', `the sandbox could not be applied (${(ev.outputTail || '').trim().split('\n').pop()}): the run is unverifiable here`));
  return { evidence: `ev:${ev.id}`, status: ev.status, exitCode: ev.exitCode, outputTail: ev.outputTail, problems, copiedBack: back.changed, discarded: back.discarded.map((p) => ({ path: p, owner: ownership.ownerOfPath(g.map, p) })), syncedIn: syncedIn.changed, isolation, ok: ev.status === 'passed' && problems.length === 0 };
}

let recorded = false;
/** GF-ISO-0: the self-test, recorded once per process in the log (the audit requires one before every sandboxed run). */
function recordSelfTest(store, actor) {
  const t = sandbox.selfTest();
  if (!recorded) {
    events.commit(store, 'gf.isolation.checked', actor, { ok: t.ok, platform: t.platform, usable: t.usable, landlockAbi: t.landlock ? t.landlock.abi : null, bwrap: t.bwrap ? t.bwrap.version : null, pidns: Boolean(t.pidns), reasons: t.reasons });
    recorded = true;
  }
  return { ok: t.ok, usable: t.usable };
}
function check(store, actor = 'orchestrator', { fresh = false } = {}) {
  const t = sandbox.selfTest({ fresh });
  events.commit(store, 'gf.isolation.checked', actor, { ok: t.ok, platform: t.platform, usable: t.usable, landlockAbi: t.landlock ? t.landlock.abi : null, bwrap: t.bwrap ? t.bwrap.version : null, pidns: Boolean(t.pidns), reasons: t.reasons });
  recorded = true;
  return t;
}

// ------------------------------------------------------------------ GF-ISO-2: the commit step
function hashBlob(root, buf) {
  return git(root, ['hash-object', '-w', '--no-filters', '--stdin'], { input: buf }).stdout.trim();
}

/** The problems with one changed path, judged before any git write. */
function pathProblems(root, rel, { map, group, task }) {
  const out = [];
  if (rel !== rel.normalize('NFC')) out.push(P('GF-ISO-2', `${rel} is not in Unicode NFC form: a name that normalises to another string is refused`));
  if (/[\u0000-\u001f\u007f]/.test(rel) || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) out.push(P('GF-ISO-2', `${rel} has a control character or an empty, . or .. segment`));
  if (NEVER_COMMIT.has(path.basename(rel))) out.push(P('GF-ISO-2', `${rel}: ${path.basename(rel)} is repository configuration, which a group role does not commit (ask the orchestrator)`));
  if (rel === '.git' || rel.startsWith('.git/') || rel === '.eccode' || rel.startsWith('.eccode/') || rel.startsWith(`${WORKTREES}/`)) out.push(P('GF-ISO-2', `${rel} is the repository, the record or a worktree, never a group's file`));
  if (ownership.ownerOfPath(map, rel) !== group) out.push(P('GF-ISO-2', `${rel} belongs to ${ownership.ownerOfPath(map, rel) || 'no group'}, not to ${group} (GF-OWN-2)`));
  if (!matchesAny(rel, task.files || [])) out.push(P('GF-ISO-2', `${rel} is outside task ${task.id}'s files [${(task.files || []).join(', ')}]`));
  const real = require('./permissions').resolveReal(root, rel);
  if (real.outside || real.rel !== rel) out.push(P('GF-ISO-2', `${rel} resolves to ${real.outside ? `outside the project (${real.real})` : real.rel} through a symlink: the commit step takes no path with a link in it`));
  let st = null; try { st = fs.lstatSync(path.join(root, rel)); } catch { /* deleted */ }
  if (st) {
    if (!st.isFile()) out.push(P('GF-ISO-2', `${rel} is not a regular file (${st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : 'a special file'}): the commit step commits regular files only`));
    else if (st.nlink > 1) out.push(P('GF-ISO-2', `${rel} has ${st.nlink} hard links: a hard-linked file is not committed (E2-2)`));
  }
  return out;
}

/** The changed paths of the group's write set in the real tree against the base tree: tracked and untracked (not ignored) files, and deletions. */
function changedPaths(root, baseTree, ws) {
  const prefixes = [...ws.dirs, ...ws.files];
  if (!prefixes.length) return [];
  const present = new Set();
  for (const r of prefixes) for (const rel of filesUnder(root, r, [], true)) present.add(rel);
  const ignored = new Set((git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...prefixes]).stdout || '').split('\0').filter(Boolean));
  const inBase = new Set(baseTree ? (git(root, ['ls-tree', '-r', '-z', '--name-only', baseTree, '--', ...prefixes]).stdout || '').split('\0').filter(Boolean) : []);
  const out = new Set();
  for (const p of present) if (!ignored.has(p) || inBase.has(p)) out.add(p);
  for (const p of inBase) out.add(p);
  return [...out].sort();
}

/**
 * GF-ISO-2: commit the group's validated changes onto its branch. `task` is a task the actor has claimed; every
 * changed path must be the group's and the task's. Nothing is written to git until every path passed.
 */
function commit(store, config, actor, { task: taskId, message } = {}) {
  const root = store.root;
  const g = groupOf(store, config, actor);
  if (!g.map) throw ruleError(g.problems);
  if (!g.group) throw ruleError([P('GF-ISO-2', `${actor} is in no group: the commit step commits a group's work`)]);
  const state = store.state();
  const task = taskId && state.tasks ? state.tasks[taskId] : null;
  if (!task) throw ruleError([P('GF-ISO-2', `task ${taskId || '(none)'} is not a task of this project`)]);
  if (task.status !== 'claimed' || !task.claim || task.claim.agent !== actor) throw ruleError([P('GF-ISO-2', `task ${taskId} is not claimed by ${actor} (status ${task.status}${task.claim ? `, claimed by ${task.claim.agent}` : ''})`)]);
  const cfgProblems = configProblems(root);
  if (cfgProblems.length) throw ruleError(cfgProblems);
  const ws = sandbox.writeSet(g.map, g.group);
  if (ws.problems.length) throw ruleError(ws.problems);
  const branch = `refs/heads/gf/${g.group}`;
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const tip = git(root, ['rev-parse', '--verify', '-q', branch], { allowFail: true });
  const parent = tip.status === 0 ? tip.stdout.trim() : head;
  const parentTree = git(root, ['rev-parse', `${parent}^{tree}`]).stdout.trim();
  const candidates = changedPaths(root, parent, ws);
  const problems = []; const changes = [];
  const lower = new Map();
  const headBlob = (rel) => { const e = (git(root, ['ls-tree', 'HEAD', '--', rel]).stdout || '').trim(); return e ? e.split(/\s+/)[2] : null; };
  const ownerTipBlob = (owner, rel) => { const t = git(root, ['rev-parse', '--verify', '-q', `refs/heads/gf/${owner}`], { allowFail: true }); if (t.status !== 0) return null; const e = (git(root, ['ls-tree', t.stdout.trim(), '--', rel]).stdout || '').trim(); return e ? e.split(/\s+/)[2] : null; };
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    let st = null; try { st = fs.lstatSync(abs); } catch { /* deleted */ }
    const baseEntry = (git(root, ['ls-tree', parent, '--', rel]).stdout || '').trim();
    const baseBlob = baseEntry ? baseEntry.split(/\s+/)[2] : null;
    const baseMode = baseEntry ? baseEntry.split(' ')[0] : null;
    const owner = ownership.ownerOfPath(g.map, rel);
    const curBlob = st && st.isFile() ? git(root, ['hash-object', '--no-filters', '--stdin'], { input: fs.readFileSync(abs) }).stdout.trim() : null;
    if (owner !== g.group) {
      // Another group's path under this group's directory prefix: ignore it when it is that group's committed work or
      // unchanged since HEAD; refuse an uncommitted cross-group change (defence in depth on the managed path; GF-ISO-1 stops it).
      if (!st) continue;
      if (!st.isFile()) { problems.push(...pathProblems(root, rel, { map: g.map, group: g.group, task })); continue; }
      if (curBlob === headBlob(rel) || curBlob === ownerTipBlob(owner, rel)) continue;
      problems.push(P('GF-ISO-2', `${rel} belongs to ${owner || 'no group'}, not to ${g.group} (GF-OWN-2): a cross-group change is not committed by ${g.group}`));
      continue;
    }
    // The group's own path: decide whether it actually CHANGED before validating; an unchanged, clean file is skipped.
    if (!st) { if (!baseBlob) continue; const pp = pathProblems(root, rel, { map: g.map, group: g.group, task }).filter((x) => !/regular file|hard links/.test(x.message)); problems.push(...pp); changes.push({ path: rel, action: 'delete' }); continue; }
    if (!st.isFile()) { problems.push(...pathProblems(root, rel, { map: g.map, group: g.group, task })); continue; }
    const mode = (st.mode & 0o111) ? '100755' : '100644';
    if (baseBlob === curBlob && baseMode === mode && st.nlink === 1 && require('./permissions').resolveReal(root, rel).rel === rel) continue; // unchanged and clean
    const pp = pathProblems(root, rel, { map: g.map, group: g.group, task });
    if (pp.length) { problems.push(...pp); continue; }
    const key = rel.toLowerCase();
    if (lower.has(key)) problems.push(P('GF-ISO-2', `${rel} and ${lower.get(key)} differ only by case`)); else lower.set(key, rel);
    changes.push({ path: rel, action: baseBlob ? 'modify' : 'add', mode, buf: fs.readFileSync(abs) });
  }
  if (problems.length) throw ruleError(problems);
  if (!changes.length) throw ruleError([P('GF-ISO-2', `nothing to commit: ${g.group}'s files in the real tree equal ${parent.slice(0, 12)}`)]);
  // Write the blobs of the validated bytes, build a temporary index from the parent tree, and commit through plumbing.
  const indexFile = path.join(commonDirOf(root), `gf-index-${g.group}-${process.pid}`);
  const idx = { env: { GIT_INDEX_FILE: indexFile } };
  try {
    git(root, ['read-tree', parentTree], idx);
    for (const ch of changes) {
      if (ch.action === 'delete') { git(root, ['update-index', '--force-remove', '--', ch.path], idx); continue; }
      ch.blob = hashBlob(root, ch.buf); delete ch.buf;
      git(root, ['update-index', '--add', '--cacheinfo', `${ch.mode},${ch.blob},${ch.path}`], idx);
    }
    const tree = git(root, ['write-tree'], idx).stdout.trim();
    const msg = `${(message && String(message).trim()) || `${g.group}: task ${taskId}`}\n\nGroup: ${g.group}\nActor: ${actor}\nTask: ${taskId}\nCommitted-By: ECCode engine (GF-ISO-2)\n`;
    const who = { GIT_AUTHOR_NAME: `${actor} (ECCode)`, GIT_AUTHOR_EMAIL: `${actor}@eccode.local`, GIT_COMMITTER_NAME: 'ECCode engine', GIT_COMMITTER_EMAIL: 'engine@eccode.local' };
    const commitId = git(root, ['commit-tree', tree, '-p', parent], { input: msg, env: who }).stdout.trim();
    git(root, ['update-ref', branch, commitId, tip.status === 0 ? parent : '0000000000000000000000000000000000000000']);
    const data = { id: newId('gc'), group: g.group, actor, task: taskId, branch: `gf/${g.group}`, parent, commit: commitId, tree, files: changes.map(({ path: p, action, mode, blob }) => ({ path: p, action, ...(mode ? { mode, blob } : {}) })), sanitized: ['no-system-config', 'no-global-config', 'no-hooks', 'no-filters', 'plumbing-only', 'cas-ref-update'] };
    events.commit(store, 'gf.group.committed', actor, data);
    return data;
  } finally { fs.rmSync(indexFile, { force: true }); }
}

// ------------------------------------------------------------------ GF-ISO-3: the merge step
/** The groups in dependency order: a group whose task another group's task depends on comes first; a cycle is refused. */
function dependencyOrder(state, map) {
  const groups = Object.keys(map.groups).sort();
  const groupOfTask = (t) => (t && t.owner ? ownership.groupOfRole(map, t.owner) : null);
  const edges = new Map(groups.map((g) => [g, new Set()]));
  for (const t of Object.values((state && state.tasks) || {})) {
    const gt = groupOfTask(t); if (!gt) continue;
    for (const d of t.dependencies || []) { const gd = groupOfTask(state.tasks[d]); if (gd && gd !== gt && edges.has(gd)) edges.get(gd).add(gt); }
  }
  const indeg = new Map(groups.map((g) => [g, 0]));
  for (const [, to] of edges) for (const g of to) indeg.set(g, indeg.get(g) + 1);
  const order = []; const ready = groups.filter((g) => indeg.get(g) === 0);
  while (ready.length) { const g = ready.shift(); order.push(g); for (const n of [...edges.get(g)].sort()) { indeg.set(n, indeg.get(n) - 1); if (indeg.get(n) === 0) ready.push(n); } ready.sort(); }
  if (order.length !== groups.length) return { problems: [P('GF-ISO-3', `the tasks' dependencies form a cycle between groups (${groups.filter((g) => !order.includes(g)).join(', ')}): no merge order exists`)] };
  return { order };
}

/**
 * GF-ISO-3: merge the groups' branches into the current branch of the real tree, in dependency order, in memory, after
 * `checks` (evidence ids of the declared deterministic checks, each passed). A conflict stops the merge.
 */
function merge(store, config, actor, { scope, checks = [] } = {}) {
  if (!['orchestrator', 'user'].includes(actor)) throw ruleError([P('GF-ISO-3', `the merge step is the orchestrator's or the user's (${actor})`)]);
  if (!scope || !String(scope).trim()) throw ruleError([P('GF-ISO-3', 'a merge names its scope')]);
  const root = store.root;
  const loaded = ownershipOps.loadMap(store, config);
  if (!loaded.map) throw ruleError(loaded.problems);
  const log = store.readEvents();
  const problems = [];
  const ids = Array.isArray(checks) ? checks.map((c) => String(c).replace(/^ev:/, '')) : [];
  if (!ids.length) problems.push(P('GF-ISO-3', 'a merge cites at least one passed deterministic check (ev:<id>)'));
  for (const id of ids) {
    const e = log.find((x) => x.type === 'evidence.recorded' && x.data && x.data.id === id);
    if (!e) problems.push(P('GF-ISO-3', `check ${id} is not recorded`)); else if (e.data.status !== 'passed') problems.push(P('GF-ISO-3', `check ${id} did not pass (${e.data.status})`));
  }
  const ord = dependencyOrder(store.state(), loaded.map);
  if (ord.problems) problems.push(...ord.problems);
  if (problems.length) throw ruleError(problems);
  const cfgProblems = configProblems(root);
  if (cfgProblems.length) throw ruleError(cfgProblems);
  const headRef = git(root, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true });
  if (headRef.status !== 0) throw ruleError([P('GF-ISO-3', 'the real tree is on a detached HEAD: the merge step integrates into a branch')]);
  const target = headRef.stdout.trim();
  const from = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  let current = from; const merges = [];
  for (const group of ord.order) {
    const tip = git(root, ['rev-parse', '--verify', '-q', `refs/heads/gf/${group}`], { allowFail: true });
    if (tip.status !== 0) continue;
    const branchCommit = tip.stdout.trim();
    const already = git(root, ['merge-base', '--is-ancestor', branchCommit, current], { allowFail: true });
    if (already.status === 0) continue; // nothing new on this branch
    const mt = git(root, ['merge-tree', '--write-tree', '--no-messages', '--name-only', current, branchCommit], { allowFail: true });
    if (mt.status !== 0) {
      const lines = (mt.stdout || '').trim().split('\n'); const conflicted = lines.slice(1).filter(Boolean);
      throw ruleError([P('GF-ISO-3', `merging gf/${group} conflicts on ${conflicted.join(', ') || 'unknown files'}: disjoint ownership cannot conflict, so this is a GF-OWN violation signal; the merge stops before ${group}`), ...merges.map((m) => P('GF-ISO-3', `merged before the stop (not applied to the branch): ${m.group}`))]);
    }
    const tree = (mt.stdout || '').trim().split('\n')[0];
    const who = { GIT_AUTHOR_NAME: 'ECCode engine', GIT_AUTHOR_EMAIL: 'engine@eccode.local', GIT_COMMITTER_NAME: 'ECCode engine', GIT_COMMITTER_EMAIL: 'engine@eccode.local' };
    const c = git(root, ['commit-tree', tree, '-p', current, '-p', branchCommit], { input: `Merge gf/${group} into ${target.replace('refs/heads/', '')} (${scope})\n\nMerged-By: ECCode engine (GF-ISO-3)\n`, env: who }).stdout.trim();
    merges.push({ group, branch: `gf/${group}`, commit: branchCommit, merge: c, tree });
    current = c;
  }
  if (!merges.length) throw ruleError([P('GF-ISO-3', 'no group branch has anything to merge')]);
  git(root, ['update-ref', target, current, from]);
  git(root, ['reset', '-q', '--mixed', current]); // the index follows; the working tree already holds the content
  const data = { id: newId('gm'), scope: String(scope), target: target.replace('refs/heads/', ''), from, to: current, order: ord.order, merges, checks: ids };
  events.commit(store, 'gf.groups.merged', actor, data);
  return data;
}

// ------------------------------------------------------------------ dependency installs
const INSTALL_FORMS = [/^(python3?|python) -m pip install -r (?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*$/, /^pip install -r (?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*$/, /^npm ci$/, /^uv sync$/, /^poetry install$/];
const LOCKFILES = ['requirements.txt', 'requirements-dev.txt', 'package-lock.json', 'uv.lock', 'poetry.lock', 'pyproject.toml'];

/** The engine-mediated dependency install: the orchestrator runs a pinned install form in the real tree, network allowed, writing only the dependency directories. */
function installDeps(store, config, actor, { command, label } = {}) {
  if (actor !== 'orchestrator') throw ruleError([P('GF-ISO-1', `dependency installs are the orchestrator's step (${actor}): a group's sandbox has no network`)]);
  const cmd = String(command || '').trim();
  if (!INSTALL_FORMS.some((re) => re.test(cmd))) throw ruleError([P('GF-ISO-1', `"${cmd}" is not a pinned install form (pip install -r <file>, python -m pip install -r <file>, npm ci, uv sync, poetry install)`)]);
  const refused = sandbox.groupModeProblems(cfgOf(store, config));
  if (refused.length) throw ruleError(refused);
  const pr = sandbox.probe();
  const mechanism = sandbox.choose(pr, {}, sandbox.selfTest().usable); // R-1: a self-test-passing mechanism only
  if (!mechanism) throw ruleError([P('GF-ISO-0', `no self-test-passing kernel mechanism is available for the dependency install (fail closed): usable ${JSON.stringify(sandbox.selfTest().usable)}`)]);
  const root = fs.realpathSync(store.root);
  const rw = DEP_DIRS.map((d) => path.join(root, d)).filter((d) => { fs.mkdirSync(d, { recursive: true }); return true; });
  const tmp = sandbox.privateTmp(root, 'deps');
  const env = sandbox.scrubEnv(process.env, { tmp, project: root, pass: ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'PIP_INDEX_URL', 'NPM_CONFIG_REGISTRY'] });
  const a = sandbox.argv(mechanism, { cwd: root, rw, tmp, net: true, probe: pr }, ['sh', '-c', cmd]);
  const line = [['env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)], a].flat().map(quote).join(' ');
  const lockfiles = LOCKFILES.filter((f) => fs.existsSync(path.join(root, f))).map((f) => ({ path: f, sha256: sha(fs.readFileSync(path.join(root, f))) }));
  const ev = evidence.runCommand(store, actor, { label: label || `deps: ${cmd}`, command: line, purpose: 'check', extra: { command: cmd, isolation: { rule: 'GF-ISO-1', step: 'deps', mechanism, network: 'allowed', writable: { dirs: DEP_DIRS }, lockfiles } } });
  fs.rmSync(tmp, { recursive: true, force: true });
  const data = { id: newId('gd'), command: cmd, evidence: `ev:${ev.id}`, status: ev.status, lockfiles, mechanism };
  events.commit(store, 'gf.deps.installed', actor, data);
  return data;
}

// ------------------------------------------------------------------ the audit's replay (GF-ISO-0, 2, 3, 4)
/** Problems the audit reports: each judged at its own seq against the map in force then. */
function auditProblems(store, config, log, gf, state) {
  const out = [];
  const E = (rule, message, seq) => out.push({ rule, seq, message });
  const base = ownershipOps.sealedBase(store, gf);
  const mapAt = (seq) => (base.map ? ownership.mapAt(base.map, gf.ownershipAmendments, seq) : null);
  // GF-ISO-0: a sandboxed run (an evidence event carrying `isolation`) follows a passed self-test in this log.
  let okSeen = false;
  for (const e of log) {
    if (e.type === 'gf.isolation.checked' && e.data && e.data.ok === true) okSeen = true;
    if (e.type === 'evidence.recorded' && e.data && e.data.isolation && e.data.isolation.rule === 'GF-ISO-1' && e.data.isolation.step !== 'deps') {
      if (!okSeen) E('GF-ISO-0', `sandboxed run ${e.data.id} precedes any passed isolation self-test in the record`, e.seq);
      // GF-ISO-4: the widening the run recorded is the widening the map in force gives.
      const map = mapAt(e.seq);
      const group = map ? ownership.groupOfRole(map, e.actor) : null;
      if (map && group) {
        const ws = sandbox.writeSet(map, group);
        const expected = new Set([...ws.widened.map((w) => w.directory), ...(e.data.isolation.mechanism === 'landlock' ? ws.carveouts : [])]);
        const recorded = new Set((e.data.isolation.widened || []).map((w) => w.directory));
        for (const d of expected) if (!recorded.has(d)) E('GF-ISO-4', `run ${e.data.id} did not record the widening of ${d}`, e.seq);
        for (const d of recorded) if (!expected.has(d)) E('GF-ISO-4', `run ${e.data.id} records a widening of ${d} that the map in force does not give`, e.seq);
      }
    }
  }
  // GF-ISO-2: every committed file is the group's under the map in force and inside the task's files.
  for (const c of gf.groupCommits) {
    const map = mapAt(c.seq);
    if (!map) { E('GF-ISO-2', `commit ${c.id}: the ownership map in force cannot be rebuilt`, c.seq); continue; }
    if (ownership.groupOfRole(map, c.actor) !== c.group) E('GF-ISO-2', `commit ${c.id}: ${c.actor} is not in ${c.group}`, c.seq);
    const task = state && state.tasks ? state.tasks[c.task] : null;
    for (const f of c.files) {
      if (ownership.ownerOfPath(map, f.path) !== c.group) E('GF-ISO-2', `commit ${c.id}: ${f.path} belongs to ${ownership.ownerOfPath(map, f.path) || 'no group'}, not ${c.group}`, c.seq);
      if (task && !matchesAny(f.path, task.files || [])) E('GF-ISO-2', `commit ${c.id}: ${f.path} is outside task ${c.task}'s files`, c.seq);
      if (NEVER_COMMIT.has(path.basename(f.path)) || f.path.startsWith('.git/') || f.path.startsWith('.eccode/')) E('GF-ISO-2', `commit ${c.id}: ${f.path} is never a group's file`, c.seq);
    }
    if (!task) E('GF-ISO-2', `commit ${c.id}: task ${c.task} is not in the task table`, c.seq);
  }
  // GF-ISO-3: a merge cites passed checks recorded before it, by the orchestrator or the user, in a dependency order of the map.
  for (const m of gf.merges) {
    if (!['orchestrator', 'user'].includes(m.actor)) E('GF-ISO-3', `merge ${m.id} was recorded by ${m.actor}`, m.seq);
    for (const id of m.checks) {
      const e = log.find((x) => x.type === 'evidence.recorded' && x.data && x.data.id === id && x.seq < m.seq);
      if (!e) E('GF-ISO-3', `merge ${m.id}: check ${id} is not an earlier recorded evidence`, m.seq); else if (e.data.status !== 'passed') E('GF-ISO-3', `merge ${m.id}: check ${id} did not pass`, m.seq);
    }
    const map = mapAt(m.seq);
    if (map) {
      const ord = dependencyOrder(state, map);
      if (ord.order && JSON.stringify(ord.order) !== JSON.stringify(m.order)) E('GF-ISO-3', `merge ${m.id}: its order [${m.order.join(', ')}] is not the dependency order [${ord.order.join(', ')}]`, m.seq);
      const pos = new Map(m.order.map((g, i) => [g, i]));
      let last = -1;
      for (const x of m.merges) { const i = pos.has(x.group) ? pos.get(x.group) : -1; if (i < last) E('GF-ISO-3', `merge ${m.id}: ${x.group} was merged out of order`, m.seq); last = i; }
    }
  }
  return out;
}

module.exports = { auditProblems, run, commit, merge, installDeps, check, dependencyOrder, refreshWorktree, worktreeDir, changedPaths, pathProblems, configProblems, gitEnv, WORKTREES, DEP_DIRS, INSTALL_FORMS, _resetRecorded: () => { recorded = false; } };
