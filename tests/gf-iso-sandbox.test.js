'use strict';
// S2.4 (design 21): the sandbox module. GF-ISO-0 (the self-test canary refuses group mode when the kernel does not
// contain it; Linux and WSL2 only), GF-ISO-4 (the write set from the map: prefixes, widening, carve-outs, refusals),
// the scrubbed environment, the disjointness check and the argv of each mechanism. Rows that need a kernel mechanism
// skip with the reason when this machine has none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sandbox = require('../lib/greenfield/sandbox');

const pr = sandbox.probe();
const HAVE = pr.mechanisms.length > 0;
const skipReason = `no kernel isolation on this machine (Landlock ${pr.landlockError || 'absent'}; bubblewrap ${pr.bwrapError || 'absent'})`;
const MAP = { groups: {
  backend: { globs: ['app/**'], denyGlobs: ['app/db/**', 'app/auth/**'] },
  db: { globs: ['app/db/**', 'migrations/**', 'seed/**'], denyGlobs: [] },
  delivery: { globs: ['Dockerfile', 'docs/**', 'src/**/*.py'], denyGlobs: [] },
  bad: { globs: ['*.py'], denyGlobs: [] },
  record: { globs: ['.eccode/drafts/record/**', '.git/hooks/**'], denyGlobs: [] },
} };

test('probe: reports the platform, the Landlock ABI, bubblewrap and a pid namespace, and lists the usable mechanisms', () => {
  assert.strictEqual(pr.platform, process.platform);
  assert.ok(Array.isArray(pr.mechanisms));
  if (pr.landlock) { assert.ok(pr.landlock.abi >= 1); assert.ok(pr.mechanisms.includes('landlock')); }
  if (pr.bwrap) assert.ok(pr.mechanisms.includes('bwrap'));
  if (pr.landlock && pr.bwrap) assert.ok(pr.mechanisms.includes('both'), 'the Landlock+bubblewrap combination is listed when both are present');
  for (const m of pr.mechanisms) assert.ok(['both', 'landlock', 'bwrap'].includes(m));
});

test('GF-ISO-4 positive: a directory glob maps to its directory, a plain path to a file, a denied sub-glob to a carve-out', () => {
  assert.deepStrictEqual(sandbox.writeSet(MAP, 'backend'), { dirs: ['app'], files: [], widened: [], carveouts: ['app/db', 'app/auth'], problems: [] });
  assert.deepStrictEqual(sandbox.writeSet(MAP, 'db').dirs, ['app/db', 'migrations', 'seed']);
});
test('GF-ISO-4 positive: a glob that is not a prefix is widened to its directory and listed', () => {
  const ws = sandbox.writeSet(MAP, 'delivery');
  assert.deepStrictEqual(ws.dirs, ['docs', 'src']); assert.deepStrictEqual(ws.files, ['Dockerfile']);
  assert.deepStrictEqual(ws.widened, [{ glob: 'src/**/*.py', directory: 'src' }]);
});
test('GF-ISO-4 negative: a glob that would widen to the whole project, and a glob into the record or the repository, are refused', () => {
  assert.match(sandbox.writeSet(MAP, 'bad').problems[0].message, /whole project/);
  const r = sandbox.writeSet(MAP, 'record');
  assert.strictEqual(r.problems.length, 2); assert.deepStrictEqual(r.dirs, []);
  assert.match(sandbox.writeSet(MAP, 'nobody').problems[0].message, /not a group/);
});
test('GF-ISO-4 bypass: prefixOf never returns a directory above the literal part of the glob', () => {
  assert.deepStrictEqual(sandbox.prefixOf('app/**'), { path: 'app', dir: true, exact: true });
  assert.deepStrictEqual(sandbox.prefixOf('app/*/x/**'), { path: 'app', dir: true, exact: false });
  assert.deepStrictEqual(sandbox.prefixOf('app/sub/**/'), { path: 'app/sub', dir: true, exact: true });
  assert.deepStrictEqual(sandbox.prefixOf('Makefile'), { path: 'Makefile', file: true, exact: true });
  assert.deepStrictEqual(sandbox.prefixOf('**'), { path: '', dir: true, exact: true });
});

test('env: only the allowlist passes, PATH loses relative and in-project entries, HOME and TMPDIR are the private tmp; secrets and ECCODE_* are dropped', () => {
  const e = sandbox.scrubEnv({ PATH: '/usr/bin:.:/proj/.venv/bin:relative/bin:/bin', HOME: '/root', ANTHROPIC_API_KEY: 'x', ECCODE_EVIDENCE: '/proj/.eccode/e', HTTPS_PROXY: 'http://p', LANG: 'C.UTF-8', GITHUB_TOKEN: 't', MY_VAR: '1' }, { tmp: '/tmp/t', project: '/proj', pass: ['MY_VAR'] });
  assert.deepStrictEqual(e, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', MY_VAR: '1', HOME: '/tmp/t', TMPDIR: '/tmp/t', TEMP: '/tmp/t', TMP: '/tmp/t' });
});

test('disjoint: a writable path must be inside the worktree, and no writable path or the tmp may contain a project tree', () => {
  const ok = sandbox.disjointProblems('/w/wt', ['/w/wt/app'], '/tmp/x', ['/w/real']);
  assert.deepStrictEqual(ok, []);
  assert.match(sandbox.disjointProblems('/w/wt', ['/w'], '/tmp/x', ['/w/real'])[0].message, /outside the worktree|would contain/);
  assert.match(sandbox.disjointProblems('/w/wt', ['/w/wt/app'], '/tmp', ['/tmp/proj'])[0].message, /not disjoint/);
  assert.match(sandbox.disjointProblems('/tmp/proj/wt', ['/tmp/proj/wt/app'], '/tmp/proj/wt/tmp', ['/tmp/proj'])[0].message, /not disjoint/);
});

test('argv: Landlock gets the helper with every rw path, the tmp, the device files and --no-net; bubblewrap gets a read-only root, binds, carve-outs on top and --unshare-all', () => {
  const a = sandbox.argv('landlock', { cwd: '/w', rw: ['/w/app'], rwFiles: ['/w/Dockerfile'], tmp: '/t', probe: { pidns: false, landlock: { abi: 7 } } }, ['sh', '-c', 'true']);
  assert.ok(a.includes(sandbox.HELPER)); assert.ok(a.includes('--no-net'));
  assert.deepStrictEqual(a.slice(a.indexOf('--rw'), a.indexOf('--rw') + 4), ['--rw', '/w/app', '--rw', '/t']);
  assert.ok(a.indexOf('--rw-file') > 0 && a[a.indexOf('--rw-file') + 1] === '/w/Dockerfile');
  assert.deepStrictEqual(a.slice(-3), ['sh', '-c', 'true']);
  const b = sandbox.argv('bwrap', { cwd: '/w', rw: ['/w/app'], carveouts: ['/w/app/db'], tmp: '/t', probe: {} }, ['true']);
  assert.deepStrictEqual(b.slice(0, 3), ['bwrap', '--ro-bind', '/']);
  assert.ok(b.indexOf('--ro-bind', 3) > b.indexOf('--bind'), 'the carve-out is mounted after the writable bind, so it wins');
  assert.ok(b.includes('--unshare-all') && b.includes('--cap-drop') && b.includes('--die-with-parent'));
  const n = sandbox.argv('bwrap', { cwd: '/w', rw: [], tmp: '/t', net: true, probe: {} }, ['true']);
  assert.ok(!n.includes('--unshare-all') && n.includes('--unshare-pid'), 'with the network allowed every other namespace is still unshared');
});

test('A2 choose: the strongest usable combination (both > bwrap > landlock); null with no mechanism', () => {
  const all = { mechanisms: ['both', 'bwrap', 'landlock'], landlock: { abi: 7 }, bwrap: {} };
  assert.strictEqual(sandbox.choose(all), 'both'); // strongest available
  assert.strictEqual(sandbox.choose(all, {}, ['bwrap', 'landlock']), 'bwrap'); // both not usable -> next strongest
  assert.strictEqual(sandbox.choose(all, {}, ['landlock']), 'landlock'); // only landlock usable
  assert.strictEqual(sandbox.choose(all, {}, []), null); // none usable -> fail closed
  assert.strictEqual(sandbox.choose({ mechanisms: ['bwrap'], bwrap: {} }), 'bwrap'); // no landlock, no combination
  assert.strictEqual(sandbox.choose({ mechanisms: [] }), null);
});

test('GF-ISO-0: the self-test passes here with at least one mechanism, and names what it tried', { skip: HAVE ? false : skipReason }, () => {
  const t = sandbox.selfTest({ fresh: true });
  assert.strictEqual(t.ok, true, JSON.stringify(t));
  for (const m of t.usable) assert.strictEqual(t.mechanisms[m].ok, true);
  assert.deepStrictEqual(sandbox.groupModeProblems({}), []);
});

test('GF-ISO-0 negative: group mode is refused (fail closed) when the self-test fails, unless the configuration names the copy fallback', () => {
  const t = sandbox.selfTest();
  sandbox._reset();
  // Force a failing probe by pointing the helper at a Python that does not exist and hiding bwrap.
  const oldPy = process.env.ECCODE_GF_PYTHON; const oldPath = process.env.PATH;
  process.env.ECCODE_GF_PYTHON = '/nonexistent/python3'; process.env.PATH = '/nonexistent';
  try {
    const f = sandbox.selfTest({ fresh: true });
    assert.strictEqual(f.ok, false);
    const p = sandbox.groupModeProblems({});
    assert.strictEqual(p.length, 1); assert.strictEqual(p[0].rule, 'GF-ISO-0'); assert.match(p[0].message, /fail closed/);
    assert.deepStrictEqual(sandbox.groupModeProblems({ isolation: 'copy' }), []);
  } finally {
    if (oldPy === undefined) delete process.env.ECCODE_GF_PYTHON; else process.env.ECCODE_GF_PYTHON = oldPy;
    process.env.PATH = oldPath; sandbox._reset(); sandbox.selfTest({ fresh: true });
  }
  assert.strictEqual(sandbox.selfTest().ok, t.ok);
});

test('GF-ISO-0 bypass: a canary that writes through is not contained, whatever the exit code says', { skip: HAVE ? false : skipReason }, () => {
  // The same checks the self-test applies, run on a bare `sh` (no sandbox) stand in for a kernel that lets a write through.
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-canary-bare-'));
  fs.mkdirSync(path.join(tree, 'own')); fs.mkdirSync(path.join(tree, 'other')); fs.writeFileSync(path.join(tree, 'other', 'f'), 'keep');
  spawnSync('sh', ['-c', 'echo ok > own/ok; echo x > other/x; exit 0'], { cwd: tree });
  const leaked = ['other/x'].filter((p) => fs.existsSync(path.join(tree, p)));
  assert.deepStrictEqual(leaked, ['other/x'], 'the bare shell wrote through, as expected');
  // and the self-test's verdict logic marks such a run as not ok (exit 0 does not rescue it)
  const verdictOk = fs.existsSync(path.join(tree, 'own', 'ok')) && leaked.length === 0;
  assert.strictEqual(verdictOk, false);
  fs.rmSync(tree, { recursive: true, force: true });
});

test('helper: the Landlock helper refuses a malformed call and reports its ABI with --probe', { skip: pr.landlock ? false : 'no Landlock here' }, () => {
  const r = spawnSync('python3', ['-I', sandbox.HELPER, '--probe'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0); assert.strictEqual(JSON.parse(r.stdout).abi, pr.landlock.abi);
  assert.strictEqual(spawnSync('python3', ['-I', sandbox.HELPER, '--bogus', '--', 'true'], { encoding: 'utf8' }).status, 2);
  assert.strictEqual(spawnSync('python3', ['-I', sandbox.HELPER, '--rw', '/tmp'], { encoding: 'utf8' }).status, 2);
});

// R-1 (S2.4 independent review): choose() must not return a mechanism the self-test did not mark usable. On a host
// where Landlock reports an ABI but does not enforce (LSM off), the canary excludes landlock from `usable`; choose must
// then NOT pick it (fail closed), or a run would proceed under a non-enforcing sandbox.
test('R-1: choose never returns a mechanism absent from the usable set, and returns null when none is usable', () => {
  const both = { mechanisms: ['landlock', 'bwrap'], landlock: { abi: 7 }, bwrap: {} };
  // landlock available but the canary failed it (not usable); bwrap usable -> bwrap
  assert.strictEqual(sandbox.choose(both, {}, ['bwrap']), 'bwrap');
  // only landlock available and not usable -> null (fail closed), not landlock
  assert.strictEqual(sandbox.choose({ mechanisms: ['landlock'], landlock: { abi: 7 } }, {}, []), null);
  // both available, neither usable -> null
  assert.strictEqual(sandbox.choose(both, {}, []), null);
  // a carve-out needs bwrap, but only landlock is usable -> landlock (contained by copy-back; the widening is recorded)
  assert.strictEqual(sandbox.choose(both, { carveouts: ['app/db'] }, ['landlock']), 'landlock');
  // usable omitted ranks on availability alone; with landlock+bwrap but no combination listed, bwrap is strongest
  assert.strictEqual(sandbox.choose(both, {}), 'bwrap');
});

// ============ A2 (S2.4.1): layered isolation, the ptrace and UDP canary rows ============
test('A2: the self-test ranks usable modes strongest-first and flags the weaker ones', { skip: HAVE ? false : skipReason }, () => {
  const t = sandbox.selfTest({ fresh: true });
  assert.ok(t.usable.length >= 1);
  // usable is sorted by strength; the strongest is the first
  assert.strictEqual(t.strongest, t.usable[0]);
  const rank = sandbox.MECH_ORDER;
  for (let i = 1; i < t.usable.length; i++) assert.ok(rank[t.usable[i - 1]] >= rank[t.usable[i]], `ranked: ${t.usable}`);
  // every usable mode blocked ptrace of the engine (a precondition for being usable)
  for (const m of t.usable) assert.strictEqual(t.mechanisms[m].ptraceSafe, true, `${m} is ptrace-safe`);
  // a weaker mode is any usable mode other than the combination
  for (const m of t.weaker) assert.notStrictEqual(m, 'both');
});

test('A2: the canary measures ptrace-addressability of the engine and UDP egress; a mode that cannot block ptrace is not usable', { skip: HAVE ? false : skipReason }, () => {
  const t = sandbox.selfTest({ fresh: true });
  for (const [m, v] of Object.entries(t.mechanisms)) {
    assert.ok('ptraceSafe' in v && 'netUdpOpen' in v, `${m} canary records ptraceSafe and netUdpOpen`);
    if (v.contained && !v.ptraceSafe) assert.ok(!t.usable.includes(m), `${m} is not usable when it cannot block ptrace of the engine`);
  }
  // here the combination and bubblewrap close UDP (network namespace); Landlock alone leaves UDP open (its residual)
  if (t.mechanisms.both) assert.strictEqual(t.mechanisms.both.netUdpOpen, false);
  if (t.mechanisms.landlock && t.usable.includes('landlock')) assert.strictEqual(t.mechanisms.landlock.netUdpOpen, true, 'Landlock alone: UDP/DNS egress open (L-GF-79)');
});

test('A2: the combined mode runs Landlock inside bubblewrap (both prefixes present in its argv)', () => {
  const a = sandbox.argv('both', { cwd: '/w', rw: ['/w/app'], tmp: '/t', net: false, probe: { landlock: { abi: 7 }, bwrap: {} } }, ['sh', '-c', 'true']);
  assert.strictEqual(a[0], 'bwrap');
  assert.ok(a.includes(sandbox.HELPER), 'the Landlock helper runs inside bubblewrap');
  assert.ok(a.includes('--unshare-all') && a.includes('--no-net'));
});

// ============ A1 (S2.4.1): canary parity — the authorizing canary matches the run it clears ============
test('A1: authorizeRun runs a canary with the exact mechanism, write-set width, net and uid it is asked for', { skip: HAVE ? false : skipReason }, () => {
  const v = sandbox.authorizeRun('both', { rwDirs: 3, net: false, fresh: true });
  assert.strictEqual(v.mechanism, 'both');
  assert.strictEqual(v.rwDirs, 3);
  assert.strictEqual(v.net, false);
  assert.strictEqual(v.uid, sandbox.probe().uid);
  assert.strictEqual(v.ok, true);
});

