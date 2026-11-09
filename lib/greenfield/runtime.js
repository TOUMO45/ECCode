'use strict';
// S3.1 (I2, I3): the engine-owned runtime for a generated FastAPI app. The Python package runtime/eccode_runtime is an
// ASGI guard (GF-VAL-1 body filters, docs closed by default); the engine vendors it into an app tree by hash,
// configured from the tree's sealed contracts/openapi.json, and the app mounts it with one line in its factory:
// `app.add_middleware(EccodeGuard)`. No builder writes the guard or its configuration.
//
// GF-RT-1, check(): the vendored files equal the engine's copy (config.json equal to configFromOpenapi of the tree's
// contracts/openapi.json, MANIFEST.sha256 equal to the expected manifest, no extra file), and a behavioural canary
// (a lone-surrogate JSON body sent to `app.main:app` through Starlette's TestClient, and GET /docs with
// ECCODE_DOCS_ENABLED unset) answers with the guard's x-eccode-rule header (422 GF-VAL-1, 404 GF-DOCS-1), so a
// guard that is vendored but not mounted fails. wrap.gateReview refuses the approval of
// the phase:build gate when the check reports a problem, for a project whose config declares
// gf.runtime.enforce === true (opt-in; see enforced()).
//
// Limits: the canary imports and runs the app's own code outside the group sandbox, as the reviewer's checks do; it
// proves the guard is in the stack for the canary request, not for every route (an app could wrap only part of
// itself). The canary ignores the tree's __pycache__ (pycache_prefix), so it checks the vendored source; a tree that
// ships its own __pycache__ is outside what the check covers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256File, sha256 } = require('../util');
const { ruleError } = require('./errors');

const RULE = 'GF-RT-1';
const PKG = 'eccode_runtime';
const ENGINE_PKG = path.join(__dirname, 'runtime', PKG);
const GENERATED = ['config.json', 'MANIFEST.sha256'];
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const LIMITS = { max_body_bytes: 1048576, max_depth: 64, max_string_length: 100000 };
/** The gate whose approval the runtime check guards. */
const GATE = 'phase:build';
const CANARY_PATH = '/__eccode_canary__';

const P = (message) => ({ rule: RULE, message });

/** The guard configuration the engine derives from an OpenAPI document: which operations are secured, the limits. */
function configFromOpenapi(openapi) {
  if (!openapi || typeof openapi !== 'object' || !openapi.paths || typeof openapi.paths !== 'object') {
    throw ruleError([P('the openapi document has no paths object; the runtime configuration is derived from contracts/openapi.json')]);
  }
  const globalSec = Array.isArray(openapi.security) ? openapi.security : [];
  const secured = [];
  const pub = [];
  for (const [p, item] of Object.entries(openapi.paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== 'object') continue;
      const sec = Array.isArray(op.security) ? op.security : globalSec;
      // security: [] is public; a requirement list holding an empty object makes authentication optional (public)
      const isSecured = sec.length > 0 && sec.every((req) => req && typeof req === 'object' && Object.keys(req).length > 0);
      (isSecured ? secured : pub).push({ method: m.toUpperCase(), pathTemplate: p });
    }
  }
  const order = (a, b) => (a.pathTemplate < b.pathTemplate ? -1 : a.pathTemplate > b.pathTemplate ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0);
  return { version: 1, secured: secured.sort(order), public: pub.sort(order), limits: { ...LIMITS }, docs_enabled: false };
}

const serialize = (cfg) => `${JSON.stringify(cfg, null, 2)}\n`;

/** The engine's own package files (names), excluding generated files and caches. */
function engineFiles() {
  return fs.readdirSync(ENGINE_PKG, { withFileTypes: true })
    .filter((d) => d.isFile() && !GENERATED.includes(d.name))
    .map((d) => d.name)
    .sort();
}

function manifestText(entries) {
  return Object.keys(entries).sort().map((p) => `${entries[p]}  ${p}`).join('\n') + '\n';
}

function readOpenapi(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/**
 * Vendor the package into <tree>/eccode_runtime (replacing what is there), write config.json from the openapi
 * document and MANIFEST.sha256 (sha256 of every vendored file, config.json included). Returns { dir, files }.
 */
function install(treeDir, openapiPath) {
  const tree = path.resolve(treeDir);
  const cfg = configFromOpenapi(readOpenapi(openapiPath || path.join(tree, 'contracts', 'openapi.json')));
  const dir = path.join(tree, PKG);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const f of engineFiles()) {
    fs.copyFileSync(path.join(ENGINE_PKG, f), path.join(dir, f));
    files[`${PKG}/${f}`] = sha256File(path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, 'config.json'), serialize(cfg));
  files[`${PKG}/config.json`] = sha256File(path.join(dir, 'config.json'));
  fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), manifestText(files));
  return { dir, files };
}

/** File problems: the vendored package against the engine's copy and the tree's contract. */
function fileProblems(tree) {
  const dir = path.join(tree, PKG);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [P(`${PKG}/ is not vendored in ${tree} (run the engine install)`)];
  const out = [];
  const expected = {};
  for (const f of engineFiles()) {
    const want = sha256File(path.join(ENGINE_PKG, f));
    expected[`${PKG}/${f}`] = want;
    const abs = path.join(dir, f);
    if (!fs.existsSync(abs)) out.push(P(`${PKG}/${f} is missing`));
    else if (!fs.statSync(abs).isFile() || sha256File(abs) !== want) out.push(P(`${PKG}/${f} differs from the engine's copy`));
  }
  const known = new Set([...engineFiles(), ...GENERATED, '__pycache__']);
  for (const name of fs.readdirSync(dir)) if (!known.has(name)) out.push(P(`${PKG}/${name} is not part of the engine's package`));
  let cfgText = null;
  try { cfgText = serialize(configFromOpenapi(readOpenapi(path.join(tree, 'contracts', 'openapi.json')))); } catch (e) {
    out.push(P(`contracts/openapi.json cannot be read for the runtime configuration: ${String(e.message).split('\n').pop()}`));
  }
  const cfgFile = path.join(dir, 'config.json');
  if (cfgText !== null) {
    expected[`${PKG}/config.json`] = sha256(cfgText);
    if (!fs.existsSync(cfgFile)) out.push(P(`${PKG}/config.json is missing`));
    else if (fs.readFileSync(cfgFile, 'utf8') !== cfgText) out.push(P(`${PKG}/config.json does not match the configuration derived from contracts/openapi.json`));
    const man = path.join(dir, 'MANIFEST.sha256');
    if (!fs.existsSync(man)) out.push(P(`${PKG}/MANIFEST.sha256 is missing`));
    else if (fs.readFileSync(man, 'utf8') !== manifestText(expected)) out.push(P(`${PKG}/MANIFEST.sha256 differs from the engine's manifest`));
  }
  return out;
}

const CANARY_PY = `
import json, os, sys
tree = sys.argv[1]
sys.path.insert(0, tree)
out = {}
try:
    import importlib
    from fastapi.testclient import TestClient
    mod = importlib.import_module("app.main")
    app = getattr(mod, "app")
    rt = sys.modules.get("eccode_runtime")
    out["runtime_file"] = os.path.realpath(rt.__file__) if rt is not None else None
    client = TestClient(app, raise_server_exceptions=False)
    r = client.post(${JSON.stringify(CANARY_PATH)}, content=b'{"c": "\\\\ud800"}', headers={"content-type": "application/json"})
    out["val"] = [r.status_code, r.headers.get("x-eccode-rule")]
    d = client.get("/docs")
    out["docs"] = [d.status_code, d.headers.get("x-eccode-rule")]
except BaseException as e:
    out["error"] = (type(e).__name__ + ": " + str(e))[:300]
sys.stdout.write("\\nECCODE-CANARY " + json.dumps(out) + "\\n")
`;

/** Behavioural canary: the app answers a lone-surrogate body with the guard's header, from the vendored copy. */
function canaryProblems(tree, python) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-rt-canary-'));
  try {
    const env = { ...process.env, DATABASE_URL: `sqlite:///${path.join(tmp, 'canary.db')}`, ADMIN_EMAIL: 'canary-admin@example.test', PYTHONDONTWRITEBYTECODE: '1' };
    delete env.ECCODE_SEED_KEY;
    delete env.ECCODE_DOCS_ENABLED;
    const r = spawnSync(python, ['-I', '-X', `pycache_prefix=${path.join(tmp, 'pyc')}`, '-c', CANARY_PY, tree], { cwd: tree, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error) return [P(`the canary could not run ${python}: ${r.error.code || r.error.message}`)];
    const line = String(r.stdout || '').split('\n').reverse().find((l) => l.startsWith('ECCODE-CANARY '));
    if (!line) return [P(`the canary produced no result (exit ${r.status}): ${String(r.stderr || '').trim().split('\n').slice(-1)[0] || ''}`)];
    const out = JSON.parse(line.slice('ECCODE-CANARY '.length));
    if (out.error) return [P(`the canary could not load or call app.main:app: ${out.error}`)];
    const problems = [];
    const vendored = path.join(fs.realpathSync(tree), PKG) + path.sep;
    if (!out.runtime_file || !out.runtime_file.startsWith(vendored)) problems.push(P(`the canary found no guard imported from the vendored ${PKG}/ (got ${out.runtime_file || 'none'})`));
    const [status, rule] = out.val || [];
    if (!(status === 422 && rule === 'GF-VAL-1')) problems.push(P(`the canary's lone-surrogate body to ${CANARY_PATH} got ${status} with x-eccode-rule ${rule || 'absent'} (expected 422 GF-VAL-1): the guard is not mounted in app.main:app`));
    const [dStatus, dRule] = out.docs || [];
    if (!(dStatus === 404 && dRule === 'GF-DOCS-1')) problems.push(P(`the canary's GET /docs got ${dStatus} with x-eccode-rule ${dRule || 'absent'} (expected 404 GF-DOCS-1: docs are closed unless ECCODE_DOCS_ENABLED=1)`));
    return problems;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** GF-RT-1 problems for an app tree: [] when the vendored guard is intact, matches the contract and is in the stack. */
function check(treeDir, { python, canary = true } = {}) {
  const tree = path.resolve(treeDir);
  const problems = fileProblems(tree);
  if (canary && fs.existsSync(path.join(tree, PKG))) problems.push(...canaryProblems(tree, python || defaultPython()));
  return problems;
}

const defaultPython = () => process.env.ECCODE_PYTHON || process.env.ECCODE_GF_PYTHON || 'python3';

/** Opt-in: the project config declares the runtime ({"gf": {"runtime": {"enforce": true, "tree": "."}}}). */
function enforced(config) {
  return Boolean(config && config.gf && config.gf.runtime && config.gf.runtime.enforce === true);
}

/** The app tree: the project root, or gf.runtime.tree relative to it (never outside it). */
function treeOf(root, config) {
  const rel = (config.gf.runtime && config.gf.runtime.tree) || '.';
  const abs = path.resolve(root, rel);
  const r = path.relative(path.resolve(root), abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw ruleError([P(`gf.runtime.tree ${rel} is outside the project`)]);
  return abs;
}

/** The gate rule: problems for the approval of `gateId`, or [] when the rule does not apply. */
function gateProblems(root, config, gateId, review) {
  if (gateId !== GATE || !review || review.decision !== 'approve' || !enforced(config)) return [];
  return check(treeOf(root, config), { python: defaultPython() });
}

module.exports = { configFromOpenapi, install, check, enforced, gateProblems, defaultPython, GATE, RULE, CANARY_PATH, ENGINE_PKG };
