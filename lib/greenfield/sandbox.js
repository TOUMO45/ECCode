'use strict';
// GF-ISO-0, GF-ISO-1 and GF-ISO-4 (S2.4, design 21): the kernel sandbox a group role's command runs in. The engine
// stays outside it; this module decides the mechanism (Landlock first, bubblewrap as the fallback), builds a group's
// write set from the ownership map (directory prefixes; a glob that is not a prefix is widened and recorded, GF-ISO-4;
// a denied sub-glob is carved out with bubblewrap or widened under Landlock), scrubs the environment, and runs the
// self-test canary (GF-ISO-0) that refuses group mode when the kernel does not refuse the canary's cross-group write.
// Nothing here runs a command of the project on its own: isolate.js and runner.js call it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HELPER = path.join(__dirname, '..', '..', 'scripts', 'sandbox', 'landlock_run.py');
const P = (rule, message) => ({ rule, message });
const PYTHON = () => process.env.ECCODE_GF_PYTHON || 'python3';
/** Environment variables a sandboxed command inherits; everything else (secrets, proxies, ECCODE_* paths) is dropped. */
const ENV_PASS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'VIRTUAL_ENV', 'ECCODE_GF_PYTHON'];
const DEVICES = ['/dev/null', '/dev/zero', '/dev/urandom', '/dev/random', '/dev/tty', '/dev/full'];
const MAGIC = /[*?[]/;

let probeCache = null;
let selfTestCache = null;

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, ...opts });
}

/** What the machine offers: platform, python, Landlock ABI, bubblewrap, a pid namespace for process containment. */
function probe({ fresh = false } = {}) {
  if (probeCache && !fresh) return probeCache;
  const out = { platform: process.platform, release: os.release(), uid: typeof process.getuid === 'function' ? process.getuid() : null, python: null, landlock: null, bwrap: null, pidns: false, mechanisms: [] };
  if (process.platform !== 'linux') { probeCache = out; return out; } // Linux and WSL2 only (the owner's support matrix)
  const py = sh(PYTHON(), ['--version']);
  out.python = py.status === 0 ? (py.stdout || py.stderr).trim() : null;
  if (out.python) {
    const r = sh(PYTHON(), ['-I', HELPER, '--probe']);
    try { const j = JSON.parse(r.stdout || '{}'); if (j.abi > 0) out.landlock = { abi: j.abi }; else out.landlockError = j.error || (r.stderr || '').trim(); } catch { out.landlockError = (r.stderr || r.stdout || 'no answer').trim(); }
  } else out.landlockError = `${PYTHON()} is not available`;
  const bw = sh('bwrap', ['--version']);
  if (bw.status === 0) {
    // bubblewrap must also be able to build a namespace here (unprivileged user namespaces, or a setuid helper).
    const t = sh('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', 'true']);
    if (t.status === 0) out.bwrap = { version: bw.stdout.trim() }; else out.bwrapError = (t.stderr || '').trim().split('\n').pop();
  } else out.bwrapError = 'bwrap is not installed';
  const pid = sh('unshare', [...(out.uid === 0 ? [] : ['--user', '--map-root-user']), '--pid', '--fork', '--kill-child', 'true']);
  out.pidns = pid.status === 0;
  if (out.landlock) out.mechanisms.push('landlock');
  if (out.bwrap) out.mechanisms.push('bwrap');
  probeCache = out;
  return out;
}

/** The literal directory prefix of a glob: `app/**` -> {dir: 'app', exact: true}; `app/**\/*.py` -> {dir: 'app', exact: false}. */
function prefixOf(glob) {
  const g = String(glob).replace(/\/+$/, '');
  const m = g.search(MAGIC);
  if (m < 0) return { path: g, file: true, exact: true };
  const lit = g.slice(0, m).replace(/\/[^/]*$/, '');
  return { path: lit, dir: true, exact: g === `${lit}/**` || (lit === '' && g === '**') };
}

/**
 * GF-ISO-4: a group's write set from the map in force. Directories are the literal prefixes of its globs; a glob that
 * is not `<dir>/**` or a plain path is WIDENED to its prefix and listed; a widening to the whole project is refused;
 * `.eccode` and `.git` are never in the set; a denyGlob under a writable directory is a carve-out (read-only on top).
 */
function writeSet(map, group) {
  const g = map && map.groups && map.groups[group];
  if (!g) return { problems: [P('GF-ISO-4', `${group} is not a group of the ownership map`)] };
  const dirs = new Set(); const files = new Set(); const widened = []; const problems = [];
  for (const glob of g.globs || []) {
    const p = prefixOf(glob);
    if (p.path === '' || p.path === '.') { problems.push(P('GF-ISO-4', `${glob} would widen the write set to the whole project; a group's glob needs a literal directory prefix`)); continue; }
    if (p.path === '.git' || p.path.startsWith('.git/') || p.path === '.eccode' || p.path.startsWith('.eccode/')) { problems.push(P('GF-ISO-4', `${glob} reaches the repository or the record, which are never writable in a sandbox`)); continue; }
    if (p.file) files.add(p.path); else dirs.add(p.path);
    if (!p.exact) widened.push({ glob, directory: p.path });
  }
  const carveouts = [];
  for (const d of g.denyGlobs || []) {
    const p = prefixOf(d);
    if (p.path && [...dirs].some((w) => p.path === w || p.path.startsWith(`${w}/`))) carveouts.push(p.path);
  }
  return { dirs: [...dirs].sort(), files: [...files].sort(), widened, carveouts, problems };
}

/** The environment a sandboxed command gets: an allowlist, PATH without relative or in-project entries, HOME and TMPDIR in the private tmp. */
function scrubEnv(base, { tmp, project, pass = [] }) {
  const out = {};
  for (const k of [...ENV_PASS, ...pass]) if (base[k] !== undefined) out[k] = base[k];
  const keep = (p) => p && path.isAbsolute(p) && !(project && (p === project || p.startsWith(`${project}/`)));
  out.PATH = String(out.PATH || '/usr/local/bin:/usr/bin:/bin').split(':').filter(keep).join(':') || '/usr/bin:/bin';
  out.HOME = tmp; out.TMPDIR = tmp; out.TEMP = tmp; out.TMP = tmp;
  return out;
}

/** A private temporary directory for one run, outside every project tree (wiped by the caller). */
function privateTmp(root, group) {
  const base = path.join(os.tmpdir(), 'eccode-gf', crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12));
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(base, `${group}-`));
}

/** Refuse a write set that would contain a project tree (the spike's lesson): every writable path must be inside `cwd` or be the tmp. */
function disjointProblems(cwd, rw, tmp, trees) {
  const out = [];
  const inside = (p, base) => p === base || p.startsWith(`${base}/`);
  for (const p of rw) {
    if (p === tmp || inside(p, tmp)) continue;
    if (!inside(p, cwd)) out.push(P('GF-ISO-1', `${p} is outside the worktree ${cwd}: a writable path lies inside the group's worktree or is its private tmp`));
    for (const t of trees) if (inside(t, p)) out.push(P('GF-ISO-1', `${p} would contain the tree ${t}: a writable path never contains a project tree`));
  }
  for (const t of trees) if (inside(t, tmp) || inside(tmp, t)) out.push(P('GF-ISO-1', `the private tmp ${tmp} and the tree ${t} are not disjoint`));
  return out;
}

/**
 * The argv that runs `inner` (argv) in the sandbox. `rw` are absolute directories, `rwFiles` absolute files, all inside
 * `cwd` (the group's worktree); `tmp` the private tmp; `carveouts` absolute directories under `rw` to keep read-only.
 * Landlock cannot carve a directory out of a writable one: with carve-outs it is used only when bubblewrap is absent,
 * and the caller records the widening (GF-ISO-4).
 */
function argv(mechanism, { cwd, rw, rwFiles = [], carveouts = [], tmp, net = false, probe: pr }, inner) {
  const devs = DEVICES.filter((d) => { try { return fs.statSync(d).isCharacterDevice(); } catch { return false; } });
  if (mechanism === 'landlock') {
    const pidns = pr && pr.pidns ? ['unshare', ...(pr.uid === 0 ? [] : ['--user', '--map-root-user']), '--pid', '--fork', '--kill-child', '--'] : [];
    const flags = [...rw.flatMap((p) => ['--rw', p]), '--rw', tmp, ...rwFiles.flatMap((p) => ['--rw-file', p]), ...devs.flatMap((d) => ['--dev', d]), ...(net ? [] : ['--no-net'])];
    return [...pidns, PYTHON(), '-I', HELPER, ...flags, '--', ...inner];
  }
  if (mechanism === 'bwrap') {
    const binds = [...rw.flatMap((p) => ['--bind', p, p]), ...carveouts.flatMap((p) => ['--ro-bind', p, p]), ...rwFiles.flatMap((p) => ['--bind', p, p]), '--bind', tmp, tmp];
    return ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', ...binds, ...(net ? ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup'] : ['--unshare-all']), '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--chdir', cwd, ...inner];
  }
  throw new Error(`unknown sandbox mechanism ${mechanism}`);
}

/**
 * Which mechanism a run uses (R-1, S2.4 review): only a mechanism the self-test marked usable, since an available
 * mechanism that the canary did not contain (Landlock reporting an ABI it does not enforce) must never be chosen.
 * `usable` is the self-test's per-mechanism verdict (`selfTest().usable`); omit it to key on availability alone (for a
 * caller that gates on the self-test separately). Landlock first; bubblewrap when the write set has carve-outs.
 */
function choose(pr, { carveouts = [] } = {}, usable = null) {
  const ok = (m) => pr.mechanisms.includes(m) && (!usable || usable.includes(m));
  if (!pr.mechanisms.some(ok)) return null;
  if (carveouts.length && ok('bwrap')) return 'bwrap';
  return ok('landlock') ? 'landlock' : (ok('bwrap') ? 'bwrap' : null);
}

/**
 * GF-ISO-0: the canary. In a scratch tree with `own/` writable and `other/` not, a command inside the sandbox must
 * write own/ok and must FAIL to write other/x, to write the scratch root itself and to open a TCP connection. Each
 * available mechanism is tried; one that passes is usable. Refuses group mode (ok: false) when no mechanism passes,
 * when the platform is not Linux, or when the kernel lets a canary write through. Cached per process.
 */
function selfTest({ fresh = false } = {}) {
  if (selfTestCache && !fresh) return selfTestCache;
  const pr = probe({ fresh });
  const result = { ok: false, platform: pr.platform, mechanisms: {}, usable: [], reasons: [] };
  if (pr.platform !== 'linux') { result.reasons.push(`group mode runs on Linux and WSL2 only; this is ${pr.platform} (fail closed, single-agent mode)`); selfTestCache = result; return result; }
  if (!pr.mechanisms.length) result.reasons.push(`no kernel isolation here: Landlock ${pr.landlockError || 'absent'}; bubblewrap ${pr.bwrapError || 'absent'}`);
  for (const m of pr.mechanisms) {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-canary-'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-canary-tmp-'));
    fs.mkdirSync(path.join(tree, 'own')); fs.mkdirSync(path.join(tree, 'other'));
    fs.writeFileSync(path.join(tree, 'other', 'f'), 'keep');
    const script = `echo ok > own/ok; r=0; (echo x > other/x) 2>/dev/null && r=1; (echo y > other/f) 2>/dev/null && r=$((r+2)); (echo z > escaped) 2>/dev/null && r=$((r+4)); (ln own/ok other/link) 2>/dev/null && r=$((r+8)); (${PYTHON()} -c 'import socket; s=socket.socket(); s.settimeout(2); s.connect(("127.0.0.1", 9))' ) 2>/dev/null && r=$((r+16)); exit $r`;
    const a = argv(m, { cwd: tree, rw: [path.join(tree, 'own')], tmp, probe: pr }, ['sh', '-c', script]);
    const r = spawnSync(a[0], a.slice(1), { cwd: tree, encoding: 'utf8', timeout: 30000, env: scrubEnv(process.env, { tmp, project: tree }) });
    const wrote = fs.existsSync(path.join(tree, 'own', 'ok'));
    const leaked = ['other/x', 'escaped', 'other/link'].filter((p) => fs.existsSync(path.join(tree, p)));
    const changed = fs.readFileSync(path.join(tree, 'other', 'f'), 'utf8') !== 'keep';
    const code = r.status;
    // exit bits: 1 other/x, 2 other/f, 4 the root, 8 hard link, 16 tcp connect (a refused connect gives no bit)
    const verdict = { exit: code, ownWrite: wrote, leaked, changed, netOpen: code !== null && (code & 16) !== 0, stderr: (r.stderr || '').trim().split('\n').pop() };
    verdict.ok = wrote && !leaked.length && !changed && !verdict.netOpen && code !== null && (code & 7) === 0 && (code & 8) === 0;
    result.mechanisms[m] = verdict;
    if (verdict.ok) result.usable.push(m); else result.reasons.push(`${m}: the canary was not contained (${JSON.stringify(verdict)})`);
    fs.rmSync(tree, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
  }
  result.ok = result.usable.length > 0;
  result.landlock = pr.landlock; result.bwrap = pr.bwrap; result.pidns = pr.pidns;
  selfTestCache = result;
  return result;
}

/** Group mode is refused with this problem when the self-test fails (GF-ISO-0). */
function groupModeProblems(cfg = {}) {
  const t = selfTest();
  if (t.ok) return [];
  if (cfg.isolation === 'copy') return []; // the owner's explicit fallback to the S2.x copy runner (recorded as a limit)
  return [P('GF-ISO-0', `group mode is refused: ${t.reasons.join('; ')} (fail closed; the S2.x copy runner is used only when the configuration says isolation: "copy")`)];
}

module.exports = { probe, selfTest, groupModeProblems, writeSet, prefixOf, scrubEnv, privateTmp, disjointProblems, argv, choose, ENV_PASS, HELPER, _reset: () => { probeCache = null; selfTestCache = null; } };
