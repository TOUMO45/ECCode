'use strict';
// S4-PREREQ D-1: the stack profile python-fastapi-postgres-worker-compose (lib/greenfield/profiles.js): selection,
// the engine-owned scaffold, compose validity without a daemon, a healthcheck on every service, ownership coverage of
// every generated path, and the v1 profile unchanged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const C = require('../lib/greenfield/constants');
const { initProject } = require('../lib/greenfield/init');
const profiles = require('../lib/greenfield/profiles');
const audit = require('../lib/greenfield/audit');
const { loadConfig } = require('../lib/config');

const NAME = 'python-fastapi-postgres-worker-compose';
const BIN = path.join(__dirname, '..', 'bin', 'eccode-gf.js');
const HAVE_DOCKER = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const NO_DAEMON = { ...process.env, DOCKER_HOST: 'unix:///nonexistent/eccode-test.sock' };
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-gf-profile-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}
const IDEA = 'A pipeline that ingests readings, aggregates them on a schedule, and shows them on a dashboard';

// ------------------------------------------------------------------ selection
test('D-1 selection: the new profile is selectable by name; the v1 list and the default are unchanged', () => {
  assert.deepStrictEqual(C.STACK_PROFILES, ['python-fastapi-sqlalchemy-sqlite']);
  assert.deepStrictEqual(profiles.supported(), ['python-fastapi-sqlalchemy-sqlite', NAME]);
  const dir = fresh();
  const store = initProject(dir, { name: 'Pipeline', idea: IDEA, stackProfile: NAME });
  const cfg = loadConfig(store.root);
  assert.strictEqual(cfg.gf.stackProfile, NAME);
  const ev = store.readEvents().find((e) => e.type === 'gf.project.initialized');
  assert.strictEqual(ev.data.stackProfile, NAME);
  // the default init writes exactly what it wrote before, and no scaffold
  const d2 = fresh();
  const s2 = initProject(d2, { name: 'Tasks', idea: IDEA });
  const c2 = loadConfig(s2.root);
  assert.deepStrictEqual(Object.keys(c2.gf).sort(), ['enabled', 'schemaVersion', 'stackProfile']);
  assert.strictEqual(c2.gf.stackProfile, 'python-fastapi-sqlalchemy-sqlite');
  assert.strictEqual(fs.existsSync(path.join(d2, 'compose.yaml')), false);
});

test('D-1 selection: an unknown profile is still refused with GF-INIT-1, and nothing is written', () => {
  const dir = fresh();
  let err;
  try { initProject(dir, { name: 'X', idea: IDEA, stackProfile: 'node-express' }); } catch (e) { err = e; }
  assert.ok(rulesOf(err).includes('GF-INIT-1'));
  assert.strictEqual(fs.existsSync(path.join(dir, '.eccode')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'compose.yaml')), false);
});

test('D-1 selection: the scaffold never overwrites an existing file (GF-STACK-0, no project is created)', () => {
  const dir = fresh();
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
  let err;
  try { initProject(dir, { name: 'X', idea: IDEA, stackProfile: NAME }); } catch (e) { err = e; }
  assert.ok(rulesOf(err).includes('GF-STACK-0'), String(err && err.message));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'compose.yaml'), 'utf8'), 'services: {}\n');
  assert.strictEqual(fs.existsSync(path.join(dir, '.eccode')), false);
});

// ------------------------------------------------------------------ the scaffold: structure only
test('D-1 scaffold: init writes the engine-owned files and no application code', () => {
  const dir = fresh();
  initProject(dir, { name: 'Pipeline', idea: IDEA, stackProfile: NAME });
  const files = Object.keys(profiles.scaffoldFiles(NAME)).sort();
  assert.deepStrictEqual(files, ['.dockerignore', '.env.example', 'compose.yaml', 'deploy/PROFILE.md', 'deploy/api.Dockerfile', 'deploy/dashboard.Dockerfile', 'deploy/worker.Dockerfile']);
  for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), f);
  // no application logic: nothing under services/, migrations/ or tests/
  for (const d of ['services', 'migrations', 'tests']) assert.strictEqual(fs.existsSync(path.join(dir, d)), false, d);
  // no secret default: the password is required, never given a value
  const compose = fs.readFileSync(path.join(dir, 'compose.yaml'), 'utf8');
  assert.match(compose, /POSTGRES_PASSWORD:\?/);
  assert.match(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), /^POSTGRES_PASSWORD=$/m);
});

test('D-1 conventions: services, health endpoints and the worker schedule are declared by the profile', () => {
  const p = profiles.get(NAME);
  assert.deepStrictEqual(Object.keys(p.services).sort(), ['api', 'dashboard', 'db', 'worker']);
  assert.deepStrictEqual(p.services.api.health, { method: 'GET', path: '/healthz', expect: 200 });
  assert.deepStrictEqual(p.services.dashboard.health, { method: 'GET', path: '/healthz', expect: 200 });
  assert.strictEqual(p.worker.intervalEnv, 'WORKER_INTERVAL_SECONDS');
  assert.strictEqual(p.worker.heartbeatEnv, 'WORKER_HEARTBEAT_FILE');
  assert.strictEqual(p.worker.idempotentTicks, true);
  const doc = profiles.composeOf(NAME);
  assert.strictEqual(doc.services.worker.environment.WORKER_HEARTBEAT_FILE, '/tmp/worker.heartbeat');
  assert.match(JSON.stringify(doc.services.api.healthcheck.test), /\/healthz/);
});

// ------------------------------------------------------------------ compose validity (no daemon)
test('D-1 GF-STACK-1: the generated compose file validates with docker compose config, no daemon', { skip: HAVE_DOCKER ? false : 'docker compose CLI absent' }, () => {
  const dir = fresh();
  initProject(dir, { name: 'Pipeline', idea: IDEA, stackProfile: NAME });
  const r = spawnSync('docker', ['compose', '-f', path.join(dir, 'compose.yaml'), 'config', '-q'], { encoding: 'utf8', env: { ...NO_DAEMON, POSTGRES_PASSWORD: 'validation-only' } });
  assert.strictEqual(r.status, 0, r.stderr);
  // without the password, compose refuses (no secret default)
  const bare = spawnSync('docker', ['compose', '-f', path.join(dir, 'compose.yaml'), 'config', '-q'], { encoding: 'utf8', env: { ...NO_DAEMON, POSTGRES_PASSWORD: '' } });
  assert.notStrictEqual(bare.status, 0);
  assert.deepStrictEqual(profiles.check(dir, NAME), []);
});

test('D-1 GF-STACK-1: a broken compose file is refused', () => {
  const dir = fresh();
  initProject(dir, { name: 'Pipeline', idea: IDEA, stackProfile: NAME });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), '{"services": {"api": ');
  assert.ok(profiles.check(dir, NAME).some((p) => p.rule === 'GF-STACK-1'));
  fs.rmSync(path.join(dir, 'compose.yaml'));
  assert.ok(profiles.check(dir, NAME).some((p) => p.rule === 'GF-STACK-1' && /missing/.test(p.message)));
});

// ------------------------------------------------------------------ every service has a healthcheck
test('D-1 GF-STACK-2: every service of the generated file has a healthcheck (4 of 4)', () => {
  const doc = profiles.composeOf(NAME);
  const svcs = Object.entries(doc.services);
  assert.strictEqual(svcs.length, 4);
  for (const [, s] of svcs) assert.ok(s.healthcheck && Array.isArray(s.healthcheck.test) && s.healthcheck.test.length > 1);
  assert.deepStrictEqual(profiles.composeProblems(NAME, doc), []);
});

test('D-1 GF-STACK-2: a service without a healthcheck, a disabled one, or a missing service is refused', () => {
  const noHc = profiles.composeOf(NAME);
  delete noHc.services.worker.healthcheck;
  assert.ok(profiles.composeProblems(NAME, noHc).some((p) => p.rule === 'GF-STACK-2' && /worker/.test(p.message)));
  const off = profiles.composeOf(NAME);
  off.services.api.healthcheck = { test: ['NONE'] };
  assert.ok(profiles.composeProblems(NAME, off).some((p) => p.rule === 'GF-STACK-2' && /api/.test(p.message)));
  const extra = profiles.composeOf(NAME);
  extra.services.cache = { image: 'redis:7' };
  assert.ok(profiles.composeProblems(NAME, extra).some((p) => /cache/.test(p.message)));
  const gone = profiles.composeOf(NAME);
  delete gone.services.dashboard;
  assert.ok(profiles.composeProblems(NAME, gone).some((p) => /dashboard/.test(p.message)));
  // on disk, through the full check
  const dir = fresh();
  initProject(dir, { name: 'Pipeline', idea: IDEA, stackProfile: NAME });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), JSON.stringify(noHc, null, 2));
  assert.ok(profiles.check(dir, NAME).some((p) => p.rule === 'GF-STACK-2'));
});

// ------------------------------------------------------------------ ownership covers every generated path
test('D-1 GF-STACK-3: the profile ownership map is valid and covers every generated path exactly once', () => {
  const p = profiles.get(NAME);
  assert.deepStrictEqual(require('../lib/greenfield/ownership').mapProblems(p.ownership), []);
  assert.deepStrictEqual(profiles.coverageProblems(NAME, p.ownership), []);
  for (const rel of Object.keys(profiles.scaffoldFiles(NAME))) assert.strictEqual(profiles.ownersOf(p.ownership, rel).length, 1, rel);
});

test('D-1 GF-STACK-3: a map that leaves a generated path uncovered, or covers one twice, is refused', () => {
  const p = profiles.get(NAME);
  const gap = JSON.parse(JSON.stringify(p.ownership));
  gap.groups.delivery.globs = gap.groups.delivery.globs.filter((g) => g !== 'deploy/**');
  assert.ok(profiles.coverageProblems(NAME, gap).some((x) => /deploy\/api\.Dockerfile is owned by no group/.test(x.message)));
  const twice = JSON.parse(JSON.stringify(p.ownership));
  twice.groups.backend.globs.push('compose.yaml');
  assert.ok(profiles.coverageProblems(NAME, twice).some((x) => /compose\.yaml is owned by 2 groups/.test(x.message)));
});

// ------------------------------------------------------------------ enforcement in the audit and the CLI
test('D-1 audit: a project on the new profile reports GF-STACK problems in the audit; the v1 audit is untouched', () => {
  const dir = fresh();
  const store = initProject(dir, { name: 'Pipeline', idea: IDEA, stackProfile: NAME });
  const clean = audit.run(store, loadConfig(dir));
  assert.deepStrictEqual(clean.errors.filter((e) => /^GF-STACK/.test(e.rule)), []);
  const doc = profiles.composeOf(NAME);
  delete doc.services.api.healthcheck;
  fs.writeFileSync(path.join(dir, 'compose.yaml'), JSON.stringify(doc, null, 2));
  const bad = audit.run(store, loadConfig(dir));
  assert.ok(bad.errors.some((e) => e.rule === 'GF-STACK-2'), JSON.stringify(bad.errors));
  assert.strictEqual(bad.ok, false);
});

test('D-1 CLI: init --stack selects the profile; stack check exits 0 on the scaffold and 2 on a broken one', () => {
  const dir = fresh();
  const run = (args) => spawnSync(process.execPath, [BIN, ...args, '--root', dir], { encoding: 'utf8', env: { ...process.env, ECCODE_ACTOR: '' } });
  const i = run(['init', '--name', 'Pipeline', '--idea', IDEA, '--stack', NAME]);
  assert.strictEqual(i.status, 0, i.stderr);
  const ok = run(['stack', 'check', '--json']);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepStrictEqual(JSON.parse(ok.stdout).problems, []);
  fs.writeFileSync(path.join(dir, 'compose.yaml'), '{');
  const bad = run(['stack', 'check']);
  assert.strictEqual(bad.status, 2, bad.stdout + bad.stderr);
  assert.match(bad.stdout + bad.stderr, /GF-STACK-1/);
});
