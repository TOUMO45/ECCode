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
const { ruleError } = require('./errors');

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
  // A2 (S2.4.1): the strongest combination first. `both` is Landlock applied inside a bubblewrap sandbox, so it has
  // bubblewrap's pid, net, ipc and mount namespaces AND Landlock's path-based write set; `bwrap` alone has the
  // namespaces; `landlock` alone is weaker (no mount namespace, and its net scope covers TCP only). Each is listed
  // only when available here; the self-test decides which are actually usable.
  if (out.landlock && out.bwrap) out.mechanisms.push('both');
  if (out.bwrap) out.mechanisms.push('bwrap');
  if (out.landlock) out.mechanisms.push('landlock');
  out.weaker = { landlock: 'no mount namespace; Landlock network scope is TCP only (UDP/DNS egress open)' };
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
function argv(mechanism, spec, inner) {
  const { cwd, rw, rwFiles = [], carveouts = [], tmp, net = false, probe: pr, masked = [] } = spec;
  // S3.1 I6 (GF-HID-1): `masked` paths (the hidden acceptance suite) are hidden from the sandboxed command: bubblewrap
  // mounts an empty read-only tmpfs over a directory (a file gets /dev/null), after every other mount. Landlock alone
  // restricts writes only and cannot hide a path from reads, so a masked run never uses it alone (fail closed).
  const masks = masked.filter((p) => { try { fs.statSync(p); return true; } catch { return false; } }).flatMap((p) => (fs.statSync(p).isDirectory() ? ['--tmpfs', p, '--remount-ro', p] : ['--ro-bind', '/dev/null', p]));
  if (masks.length && mechanism === 'landlock') throw ruleError([{ rule: 'GF-HID-1', message: 'the hidden acceptance suite must be masked from this run, and Landlock alone cannot hide a path from reads; bubblewrap is required (fail closed)' }]);
  const devs = DEVICES.filter((d) => { try { return fs.statSync(d).isCharacterDevice(); } catch { return false; } });
  const landlockCmd = [PYTHON(), '-I', HELPER, ...rw.flatMap((p) => ['--rw', p]), '--rw', tmp, ...rwFiles.flatMap((p) => ['--rw-file', p]), ...devs.flatMap((d) => ['--dev', d]), ...(net ? [] : ['--no-net']), '--', ...inner];
  const bwrapPrefix = () => ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    ...rw.flatMap((p) => ['--bind', p, p]), ...carveouts.flatMap((p) => ['--ro-bind', p, p]), ...rwFiles.flatMap((p) => ['--bind', p, p]), '--bind', tmp, tmp, ...masks,
    ...(net ? ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup'] : ['--unshare-all']), '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--chdir', cwd];
  if (mechanism === 'both') return [...bwrapPrefix(), ...landlockCmd]; // Landlock applied inside the bubblewrap namespaces
  if (mechanism === 'landlock') {
    // A pid + mount namespace with a fresh /proc hides the engine process from the sandboxed command (ptrace ESRCH),
    // which Landlock's write set alone does not do. Without a usable pid namespace the self-test marks landlock unusable.
    const pidns = pr && pr.pidns ? ['unshare', ...(pr.uid === 0 ? [] : ['--user', '--map-root-user']), '--pid', '--fork', '--mount-proc', '--kill-child', '--'] : [];
    return [...pidns, ...landlockCmd];
  }
  if (mechanism === 'bwrap') return [...bwrapPrefix(), ...inner];
  throw new Error(`unknown sandbox mechanism ${mechanism}`);
}

/**
 * Which mechanism a run uses (R-1, S2.4 review): only a mechanism the self-test marked usable, since an available
 * mechanism that the canary did not contain (Landlock reporting an ABI it does not enforce) must never be chosen.
 * `usable` is the self-test's per-mechanism verdict (`selfTest().usable`); omit it to key on availability alone (for a
 * caller that gates on the self-test separately). Landlock first; bubblewrap when the write set has carve-outs.
 */
function choose(pr, { carveouts = [] } = {}, usable = null) { // eslint-disable-line no-unused-vars
  // A2 (S2.4.1): the strongest usable combination, by rank (both > bwrap > landlock). `both` and `bwrap` enforce a
  // carve-out (a read-only bind on top of the writable bind); `landlock` alone cannot, so the caller records the
  // widening when it is chosen. R-1 (S2.4): only a mechanism the self-test marked usable; omit `usable` to rank on
  // availability alone (for a caller that gates on the self-test separately).
  const avail = (m) => pr.mechanisms.includes(m) && (!usable || usable.includes(m));
  const ranked = ['both', 'bwrap', 'landlock'].filter(avail);
  return ranked.length ? ranked[0] : null;
}

/**
 * A1 (S2.4.1): the per-run canary. Run the canary with the EXACT mechanism, write-set width, net policy, uid and
 * scrubbed environment the real run will use, so the self-test that authorizes a run cannot diverge from it. Cached by
 * that shape within a process. Returns the verdict (`ok`, `mechanism`, `rwDirs`, `net`, `uid`, `ptraceSafe`, …).
 */
const authorizeCache = new Map();
function authorizeRun(mechanism, { rwDirs = 1, net = false, fresh = false } = {}) {
  const pr = probe();
  const key = `${mechanism}|${rwDirs}|${net}|${pr.uid}`;
  if (!fresh && authorizeCache.has(key)) return authorizeCache.get(key);
  const v = runCanary(mechanism, pr, { rwDirs, net });
  authorizeCache.set(key, v);
  return v;
}

/**
 * GF-ISO-0: the canary. In a scratch tree with `own/` writable and `other/` not, a command inside the sandbox must
 * write own/ok and must FAIL to write other/x, to write the scratch root itself and to open a TCP connection. Each
 * available mechanism is tried; one that passes is usable. Refuses group mode (ok: false) when no mechanism passes,
 * when the platform is not Linux, or when the kernel lets a canary write through. Cached per process.
 */
const MECH_ORDER = { both: 3, bwrap: 2, landlock: 1 };
/**
 * The canary script. In a scratch tree with `own/` writable and the rest read-only, a contained command: writes own/ok;
 * fails to write another path, the root and a hard link (bits 1,2,4,8); fails a TCP connect (bit 16); fails to READ the
 * engine process's memory map, i.e. ptrace of the engine is blocked (bit 32 clear = safe, A2); and, informational, a UDP
 * sendto to an off-host address (bit 64 = UDP egress open, the Landlock-alone residual).
 */
function canaryScript(target) {
  // bit 32: the engine process is ADDRESSABLE from inside the sandbox (kill -0 succeeds), the precondition for ptrace /
  // process_vm_writev against it; a pid namespace makes the engine's pid unreachable (ESRCH), so bit 32 clear = safe.
  return `echo ok > own/ok; r=0; (echo x > other/x) 2>/dev/null && r=1; (echo y > other/f) 2>/dev/null && r=$((r+2)); (echo z > escaped) 2>/dev/null && r=$((r+4)); (ln own/ok other/link) 2>/dev/null && r=$((r+8)); (${PYTHON()} -c 'import socket; s=socket.socket(); s.settimeout(2); s.connect(("127.0.0.1", 9))' ) 2>/dev/null && r=$((r+16)); (kill -0 ${target} 2>/dev/null) && r=$((r+32)); (${PYTHON()} -c 'import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(1); s.sendto(b"x",("8.8.8.8",53))' ) 2>/dev/null && r=$((r+64)); exit $r`;
}

function runCanary(m, pr, { rwDirs = 1, net = false } = {}) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-canary-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-canary-tmp-'));
  fs.mkdirSync(path.join(tree, 'own')); fs.mkdirSync(path.join(tree, 'other'));
  fs.writeFileSync(path.join(tree, 'other', 'f'), 'keep');
  const rw = [path.join(tree, 'own')];
  for (let i = 1; i < rwDirs; i++) { const d = path.join(tree, `own${i}`); fs.mkdirSync(d); rw.push(d); } // mirror the run's write-set width
  const a = argv(m, { cwd: tree, rw, tmp, net, probe: pr }, ['sh', '-c', canaryScript(process.pid)]);
  const r = spawnSync(a[0], a.slice(1), { cwd: tree, encoding: 'utf8', timeout: 30000, env: { ...scrubEnv(process.env, { tmp, project: tree }), ECCODE_CANARY: '1' } });
  const code = r.status;
  const wrote = fs.existsSync(path.join(tree, 'own', 'ok'));
  const leaked = ['other/x', 'escaped', 'other/link'].filter((p) => fs.existsSync(path.join(tree, p)));
  const changed = fs.readFileSync(path.join(tree, 'other', 'f'), 'utf8') !== 'keep';
  const bit = (n) => code !== null && (code & n) !== 0;
  const verdict = {
    exit: code, ownWrite: wrote, leaked, changed,
    netOpen: bit(16), ptraceSafe: !bit(32), netUdpOpen: bit(64),
    mechanism: m, rwDirs: rw.length, net, uid: pr.uid,
    stderr: (r.stderr || '').trim().split('\n').pop(),
  };
  // Containment (filesystem + TCP) AND ptrace of the engine blocked. UDP-open is a recorded residual, not a refusal.
  verdict.contained = wrote && !leaked.length && !changed && !verdict.netOpen && code !== null && (code & 15) === 0;
  verdict.ok = verdict.contained && verdict.ptraceSafe;
  fs.rmSync(tree, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true });
  return verdict;
}

function selfTest({ fresh = false } = {}) {
  if (selfTestCache && !fresh) return selfTestCache;
  const pr = probe({ fresh });
  const result = { ok: false, platform: pr.platform, mechanisms: {}, usable: [], weaker: [], reasons: [] };
  if (pr.platform !== 'linux') { result.reasons.push(`group mode runs on Linux and WSL2 only; this is ${pr.platform} (fail closed, single-agent mode)`); selfTestCache = result; return result; }
  if (!pr.mechanisms.length) result.reasons.push(`no kernel isolation here: Landlock ${pr.landlockError || 'absent'}; bubblewrap ${pr.bwrapError || 'absent'}`);
  for (const m of pr.mechanisms) {
    const verdict = runCanary(m, pr);
    result.mechanisms[m] = verdict;
    if (verdict.ok) { result.usable.push(m); if (m !== 'both') result.weaker.push(m); }
    else if (verdict.contained && !verdict.ptraceSafe) result.reasons.push(`${m}: contained the filesystem but could read the engine's memory map (ptrace of the engine not blocked); refused`);
    else result.reasons.push(`${m}: the canary was not contained (${JSON.stringify({ leaked: verdict.leaked, changed: verdict.changed, netOpen: verdict.netOpen })})`);
  }
  result.usable.sort((a, b) => MECH_ORDER[b] - MECH_ORDER[a]);
  result.ok = result.usable.length > 0;
  result.strongest = result.usable[0] || null;
  result.landlock = pr.landlock; result.bwrap = pr.bwrap; result.pidns = pr.pidns;
  // A2: if no mode blocks ptrace of the engine, group mode is refused (the owner's refusal rule).
  if (!result.ok && Object.values(result.mechanisms).some((v) => v.contained && !v.ptraceSafe)) {
    result.reasons.push('no available mode blocks ptrace of the engine process (no pid namespace, and the engine cannot be made non-dumpable against a same-uid root tracer); group mode is refused (fail closed)');
  }
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

module.exports = { probe, selfTest, authorizeRun, runCanary, groupModeProblems, writeSet, prefixOf, scrubEnv, privateTmp, disjointProblems, argv, choose, ENV_PASS, HELPER, MECH_ORDER, _reset: () => { probeCache = null; selfTestCache = null; authorizeCache.clear(); } };
