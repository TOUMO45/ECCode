'use strict';
// S3.1 I2 (GF-VAL-1) and the runtime check (GF-RT-1). The engine-owned ASGI guard lib/greenfield/runtime/eccode_runtime
// is vendored into an app tree by hash (runtime.install), configured from the tree's contracts/openapi.json
// (runtime.configFromOpenapi), and checked (runtime.check): the vendored files match the engine's copy, and a
// behavioural canary on `app.main:app` shows the guard in the stack. The wrapped approval of the phase:build gate is
// refused with GF-RT-1 when the check fails, for a project whose config declares gf.runtime.enforce.
//
// The guard's own behaviour is tested by pytest (tests/runtime/), run here with ECCODE_PYTHON. These tests need an
// interpreter with fastapi and pytest; without one they skip and say so, and fail instead when ECCODE_REQUIRE_RUNTIME=1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const gates = require('../lib/gates');
const { loadConfig } = require('../lib/config');
const { gfProject } = require('./fixtures/gf/flow');

const ROOT = path.join(__dirname, '..');
const runtimePath = path.join(ROOT, 'lib', 'greenfield', 'runtime.js');
const load = () => require(runtimePath);
const wrapLoad = () => require('../lib/greenfield/wrap');

function findPython() {
  const candidates = [process.env.ECCODE_PYTHON, '/root/.cache/eccode/phase3-venv/bin/python', 'python3'].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, ['-c', 'import fastapi, httpx, pytest'], { encoding: 'utf8' });
    if (r.status === 0) return { python: py };
  }
  return { python: null, reason: `no interpreter with fastapi, httpx and pytest (tried ${candidates.join(', ')}); set ECCODE_PYTHON to one` };
}
const py = findPython();
const skip = py.python ? false : (process.env.ECCODE_REQUIRE_RUNTIME === '1' ? (() => { throw new Error(py.reason); })() : py.reason);
const PY_OPTS = { skip, timeout: 600000 };
const env = () => { const e = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }; delete e.ECCODE_SEED_KEY; return e; };

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rulesOf = (err) => ((err.details && err.details.problems) || []).map((p) => p.rule);
function refusal(fn) {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected a refusal, but the call succeeded');
}

const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/v1/register': { post: { security: [], requestBody: {}, responses: {} } },
    '/v1/login': { post: { security: [], responses: {} } },
    '/v1/tasks': { get: { responses: {} }, post: { responses: {} } },
    '/v1/tasks/{task_id}': { get: { responses: {} }, patch: { responses: {} }, parameters: [] },
    '/v1/open': { get: { security: [{}], responses: {} } },
    '/v1/admin': { delete: { security: [{ bearerAuth: [] }], responses: {} } },
  },
};

const MAIN_PY = (mount) => `from fastapi import Body, FastAPI
${mount ? 'from eccode_runtime import EccodeGuard\n' : ''}

def create_app():
    app = FastAPI()
${mount ? '    app.add_middleware(EccodeGuard)\n' : ''}
    @app.post("/v1/tasks")
    async def create(payload: dict = Body(...)):
        return payload

    @app.get("/v1/tasks")
    async def list_tasks():
        return []

    return app


app = create_app()
`;

/** A minimal app tree: app/main.py (mounted or not) and contracts/openapi.json. */
function appTree({ mount = true, dir } = {}) {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-rt-'));
  fs.mkdirSync(path.join(d, 'app'), { recursive: true });
  fs.mkdirSync(path.join(d, 'contracts'), { recursive: true });
  fs.writeFileSync(path.join(d, 'app', '__init__.py'), '');
  fs.writeFileSync(path.join(d, 'app', 'main.py'), MAIN_PY(mount));
  fs.writeFileSync(path.join(d, 'contracts', 'openapi.json'), JSON.stringify(OPENAPI, null, 2));
  return d;
}

// ---- the guard itself (pytest) ----------------------------------------------------------------------------------

test('I2 GF-VAL-1: the guard\'s pytest suite passes on a minimal default FastAPI app', PY_OPTS, () => {
  const r = spawnSync(py.python, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-o', 'addopts=', path.join('tests', 'runtime')], { cwd: ROOT, encoding: 'utf8', env: env() });
  const out = `${r.stdout}${r.stderr}`;
  assert.strictEqual(r.status, 0, out.slice(-4000));
  assert.match(out, /\d+ passed/);
  assert.doesNotMatch(out, /skipped|failed|error/i, out.slice(-2000));
});

// ---- configFromOpenapi ------------------------------------------------------------------------------------------

test('configFromOpenapi: global security, security: [] = public, an empty requirement = public, per-operation override', () => {
  const cfg = load().configFromOpenapi(OPENAPI);
  assert.strictEqual(cfg.version, 1);
  assert.strictEqual(cfg.docs_enabled, false);
  assert.deepStrictEqual(cfg.secured, [
    { method: 'DELETE', pathTemplate: '/v1/admin' },
    { method: 'GET', pathTemplate: '/v1/tasks' },
    { method: 'POST', pathTemplate: '/v1/tasks' },
    { method: 'GET', pathTemplate: '/v1/tasks/{task_id}' },
    { method: 'PATCH', pathTemplate: '/v1/tasks/{task_id}' },
  ]);
  assert.deepStrictEqual(cfg.public, [
    { method: 'POST', pathTemplate: '/v1/login' },
    { method: 'GET', pathTemplate: '/v1/open' },
    { method: 'POST', pathTemplate: '/v1/register' },
  ]);
  assert.deepStrictEqual(cfg.limits, { max_body_bytes: 1048576, max_depth: 64, max_string_length: 100000 });
  // no global security: every operation without its own requirement is public
  const noGlobal = load().configFromOpenapi({ ...OPENAPI, security: undefined });
  assert.deepStrictEqual(noGlobal.secured, [{ method: 'DELETE', pathTemplate: '/v1/admin' }]);
  assert.throws(() => load().configFromOpenapi(null), /openapi/i);
});

// ---- install ----------------------------------------------------------------------------------------------------

test('install: vendors the package, writes config.json and MANIFEST.sha256 covering every vendored file', () => {
  const rt = load();
  const tree = appTree();
  const res = rt.install(tree, path.join(tree, 'contracts', 'openapi.json'));
  const dir = path.join(tree, 'eccode_runtime');
  const engineDir = path.join(ROOT, 'lib', 'greenfield', 'runtime', 'eccode_runtime');
  const engineFiles = fs.readdirSync(engineDir).filter((f) => f.endsWith('.py'));
  assert.ok(engineFiles.includes('__init__.py'));
  for (const f of engineFiles) assert.strictEqual(sha(fs.readFileSync(path.join(dir, f))), sha(fs.readFileSync(path.join(engineDir, f))), f);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepStrictEqual(cfg, rt.configFromOpenapi(OPENAPI));
  const lines = fs.readFileSync(path.join(dir, 'MANIFEST.sha256'), 'utf8').trim().split('\n');
  const listed = Object.fromEntries(lines.map((l) => { const [h, p] = l.split(/\s+/); return [p, h]; }));
  assert.deepStrictEqual(Object.keys(listed).sort(), [...engineFiles, 'config.json'].map((f) => `eccode_runtime/${f}`).sort());
  for (const [p, h] of Object.entries(listed)) assert.strictEqual(h, sha(fs.readFileSync(path.join(tree, p))), p);
  assert.deepStrictEqual(res.files, listed);
});

// ---- check ------------------------------------------------------------------------------------------------------

test('check positive: an installed and mounted guard passes (files and canary)', PY_OPTS, () => {
  const rt = load();
  const tree = appTree();
  rt.install(tree);
  assert.deepStrictEqual(rt.check(tree, { python: py.python }), []);
});

test('check negative: a vendored but NOT mounted guard is refused by the canary', PY_OPTS, () => {
  const rt = load();
  const tree = appTree({ mount: false });
  rt.install(tree);
  const problems = rt.check(tree, { python: py.python });
  assert.ok(problems.length >= 1, 'refused');
  assert.ok(problems.every((p) => p.rule === 'GF-RT-1'));
  assert.ok(problems.some((p) => /canary/i.test(p.message)), JSON.stringify(problems));
});

test('check negative: a tampered vendored file is refused (even though the canary still passes)', PY_OPTS, () => {
  const rt = load();
  const tree = appTree();
  rt.install(tree);
  const f = path.join(tree, 'eccode_runtime', 'guard.py');
  fs.appendFileSync(f, '\n# changed\n');
  const problems = rt.check(tree, { python: py.python });
  assert.ok(problems.some((p) => p.rule === 'GF-RT-1' && /guard\.py/.test(p.message)), JSON.stringify(problems));
});

test('check negative: a changed config.json, a missing file, an extra file and a stale manifest are refused', () => {
  const rt = load();
  const mk = () => { const t = appTree(); rt.install(t); return t; };
  const msgs = (t) => rt.check(t, { python: null, canary: false }).map((p) => `${p.rule} ${p.message}`).join('\n');
  let t = mk();
  const cfgFile = path.join(t, 'eccode_runtime', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); cfg.docs_enabled = true; fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  assert.match(msgs(t), /GF-RT-1 .*config\.json/);
  t = mk(); fs.rmSync(path.join(t, 'eccode_runtime', '__init__.py'));
  assert.match(msgs(t), /GF-RT-1 .*__init__\.py/);
  t = mk(); fs.writeFileSync(path.join(t, 'eccode_runtime', 'extra.py'), 'x = 1\n');
  assert.match(msgs(t), /GF-RT-1 .*extra\.py/);
  t = mk(); fs.appendFileSync(path.join(t, 'eccode_runtime', 'MANIFEST.sha256'), 'x  y\n');
  assert.match(msgs(t), /GF-RT-1 .*MANIFEST/);
  t = mk(); // the contract changed after install: the vendored config no longer matches it
  const oa = JSON.parse(fs.readFileSync(path.join(t, 'contracts', 'openapi.json'), 'utf8')); oa.paths['/v1/x'] = { post: { responses: {} } };
  fs.writeFileSync(path.join(t, 'contracts', 'openapi.json'), JSON.stringify(oa));
  assert.match(msgs(t), /GF-RT-1 .*config\.json/);
  t = appTree(); // never installed
  assert.match(msgs(t), /GF-RT-1 .*not vendored|GF-RT-1 .*missing/);
  // and an intact install has no file problems
  t = mk();
  assert.strictEqual(msgs(t), '');
});

test('check: the canary fails closed when python cannot run the app', () => {
  const rt = load();
  const t = appTree(); rt.install(t);
  const problems = rt.check(t, { python: path.join(os.tmpdir(), 'no-such-python-eccode') });
  assert.ok(problems.some((p) => p.rule === 'GF-RT-1' && /canary/i.test(p.message)), JSON.stringify(problems));
});

// ---- the phase:build gate ---------------------------------------------------------------------------------------

/** A Greenfield-Senior project whose root is also the app tree; the frozen review is interposed so only the wrap runs. */
function gateCtx({ mount = true, enforce = true, install = true } = {}) {
  const ctx = gfProject();
  appTree({ mount, dir: ctx.dir });
  if (install) load().install(ctx.dir);
  const file = path.join(ctx.dir, '.eccode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (enforce) cfg.gf = { ...cfg.gf, runtime: { enforce: true } };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  ctx.config = loadConfig(ctx.dir);
  return ctx;
}
function withFrozenReview(fn) {
  const orig = gates.recordReview;
  const calls = [];
  gates.recordReview = (store, config, gateId, reviewer, review) => { calls.push({ gateId, decision: review.decision }); return { ok: true }; };
  try { return { result: fn(), calls }; } catch (e) { return { error: e, calls }; } finally { gates.recordReview = orig; }
}
const APPROVE = { decision: 'approve', criteria: [], findings: [] };
const REJECT = { decision: 'changes_requested', criteria: [], findings: [] };

test('gate positive: approving phase:build with an installed, mounted guard reaches the frozen review', PY_OPTS, () => {
  const ctx = gateCtx();
  process.env.ECCODE_PYTHON = py.python;
  const { error, calls } = withFrozenReview(() => wrapLoad().gateReview(ctx.store, ctx.config, 'phase:build', 'technical-reviewer', APPROVE));
  assert.ifError(error);
  assert.deepStrictEqual(calls, [{ gateId: 'phase:build', decision: 'approve' }]);
});

test('gate negative (bypass): a vendored but unmounted guard is refused with GF-RT-1; the frozen review is not reached', PY_OPTS, () => {
  const ctx = gateCtx({ mount: false });
  process.env.ECCODE_PYTHON = py.python;
  const { error, calls } = withFrozenReview(() => wrapLoad().gateReview(ctx.store, ctx.config, 'phase:build', 'technical-reviewer', APPROVE));
  assert.ok(error, 'refused');
  assert.strictEqual(error.code, 'GF_RULE');
  assert.ok(rulesOf(error).includes('GF-RT-1'), rulesOf(error).join(','));
  assert.deepStrictEqual(calls, []);
});

test('gate negative (bypass): a tampered vendored file is refused with GF-RT-1', PY_OPTS, () => {
  const ctx = gateCtx();
  process.env.ECCODE_PYTHON = py.python;
  fs.appendFileSync(path.join(ctx.dir, 'eccode_runtime', 'guard.py'), '\nGUARD_OFF = True\n');
  const { error, calls } = withFrozenReview(() => wrapLoad().gateReview(ctx.store, ctx.config, 'phase:build', 'technical-reviewer', APPROVE));
  assert.ok(error && rulesOf(error).includes('GF-RT-1'), error && error.message);
  assert.deepStrictEqual(calls, []);
});

test('gate negative: a runtime never installed is refused with GF-RT-1', () => {
  const ctx = gateCtx({ install: false });
  const { error, calls } = withFrozenReview(() => wrapLoad().gateReview(ctx.store, ctx.config, 'phase:build', 'technical-reviewer', APPROVE));
  assert.ok(error && rulesOf(error).includes('GF-RT-1'), error && error.message);
  assert.deepStrictEqual(calls, []);
});

test('gate scope: a rejection, another phase gate, and a project without gf.runtime.enforce are not checked', () => {
  let ctx = gateCtx({ install: false });
  let r = withFrozenReview(() => wrapLoad().gateReview(ctx.store, ctx.config, 'phase:build', 'technical-reviewer', REJECT));
  assert.ifError(r.error); assert.strictEqual(r.calls.length, 1);
  r = withFrozenReview(() => wrapLoad().gateReview(ctx.store, ctx.config, 'phase:skeleton', 'technical-reviewer', APPROVE));
  assert.ifError(r.error); assert.strictEqual(r.calls.length, 1);
  ctx = gateCtx({ install: false, enforce: false });
  r = withFrozenReview(() => wrapLoad().gateReview(ctx.store, ctx.config, 'phase:build', 'technical-reviewer', APPROVE));
  assert.ifError(r.error); assert.strictEqual(r.calls.length, 1);
});
