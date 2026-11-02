'use strict';
// Detector v2, the endpoint-source join (docs/build/plan.md, register row 158).
// A change that reaches a route declared behind nested APIRouter prefixes, a
// bound-method endpoint or an endpoint wrapped by a decorator from another
// module must be probed on the route's FULL path, and the coverage verdict
// must say so. The same changes on the frozen v1 tree (git blobs of the
// H-B freeze commit) are not flagged: v1 matches a decorator's own path against
// full OpenAPI paths, finds no probe for them, and either says
// `insufficient-coverage` or, when direct function probes ran on an unrelated
// handler, a lenient `ok` with no difference. That control is what makes these
// tests discriminating rather than self-fulfilling.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { materialize, python } = require('./fixtures/phase2/build');
const { frozenTreeFromGit } = require('./helpers');
const { loadConfig } = require('../lib/config');
const { init } = require('../lib/project');
const behavior = require('../lib/behavior');
const runner = require('../bench/pilot/phase2-hb/run');

const HUB = path.join(__dirname, 'fixtures', 'phase2', 'hub');
const py = python();
const skip = py.python ? false : (process.env.ECCODE_REQUIRE_PHASE2 === '1' ? (() => { throw new Error(py.reason); })() : py.reason);
if (py.python) process.env.ECCODE_PYTHON = py.python;
const PY = py.python;

const CHANGES = {
  // Service layer: the route files only reach it by importing it.
  pricing: { file: 'hub/pricing.py', find: 'subtotal = sum(quantity * unit for quantity, unit in lines)', replace: 'subtotal = sum(quantity * unit * (0.95 if quantity >= 5 else 1) for quantity, unit in lines)' },
  // The route file itself, behind /api + /orders.
  orders: { file: 'hub/orders_routes.py', find: 'return {"orders": [', replace: 'return {"count": len(ORDERS), "orders": [' },
  // A bound-method endpoint registered with add_api_route.
  ping: { file: 'hub/health_routes.py', find: 'return {"status": "ok"}', replace: 'return {"status": "ok", "uptime": 1}' },
  // A route whose request body refers to itself: corpus generation must not recurse without bound.
  tree: { file: 'hub/tree_routes.py', find: 'return {"depth": depth(node)}', replace: 'return {"depth": depth(node), "kind": "tree"}' },
  // The decorator module: the endpoint is its wrapper, the handler lives in another file.
  deco: { file: 'hub/deco.py', find: 'return fn(*args, **kwargs)', replace: 'result = fn(*args, **kwargs)\n        result["wrapped"] = True\n        return result' },
};

function hub(change) {
  const m = materialize(HUB);
  const apply = () => {
    const file = path.join(m.dir, change.file);
    const text = fs.readFileSync(file, 'utf8');
    assert.strictEqual(text.split(change.find).length - 1, 1, `${change.file}: the anchor occurs once`);
    fs.writeFileSync(file, text.replace(change.find, change.replace));
  };
  return { ...m, apply };
}

function suitePasses(dir) {
  return spawnSync(PY, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-W', 'ignore'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).status === 0;
}

/** Run the real route -> diff path on the engine at ROOT. Returns the result and the executed probe targets. */
function diffAt(change) {
  const s = hub(change);
  try {
    const store = init(s.dir, { name: 'hub', idea: 'router fixture', track: 'fix' });
    const config = loadConfig(s.dir);
    s.apply();
    assert.ok(suitePasses(s.dir), 'the fixture suite still passes after the change');
    const routing = behavior.route(store, config, 'backend-engineer');
    const d = behavior.diff(store, config, 'backend-engineer', {});
    const artifact = JSON.parse(fs.readFileSync(path.join(s.dir, d.artifact), 'utf8'));
    const executed = Object.keys(artifact.outputs.candidate).map((id) => id.replace(/^http:/, '').replace(/#\d+@.*$/, ''));
    assert.strictEqual(store.audit().ok, true, 'audit');
    assert.strictEqual(spawnSync('git', ['worktree', 'list'], { cwd: s.dir, encoding: 'utf8' }).stdout.trim().split('\n').length, 1, 'no worktree left behind');
    return { routing, d, targets: [...new Set(executed)].sort() };
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
}

test('a service change reaches the nested-prefix routes that import it, and only those', { skip }, () => {
  const { routing, d, targets } = diffAt(CHANGES.pricing);
  assert.strictEqual(routing.decision, 'run');
  assert.strictEqual(d.coverage, 'ok', d.coverageNote);
  assert.ok(d.unexplained >= 1, `the changed total is an unexplained difference; notes: ${d.notes.join('; ')}`);
  // Full paths, in the OpenAPI spelling, and nothing from the route file that does not depend on pricing.
  assert.deepStrictEqual(targets, ['GET /api/orders', 'GET /api/orders/{order_id}']);
  assert.ok(d.differences.every((x) => x.target.startsWith('GET /api/orders')));
});

test('a change inside a route file behind /api and /orders is probed on the full path', { skip }, () => {
  const { d, targets } = diffAt(CHANGES.orders);
  assert.strictEqual(d.coverage, 'ok', d.coverageNote);
  assert.ok(targets.includes('GET /api/orders'), targets.join(','));
  assert.ok(d.unexplained >= 1, 'the added field is an unexplained difference');
  assert.ok(d.differences.some((x) => x.target === 'GET /api/orders'));
});

test('a bound-method endpoint (add_api_route) and a wrapped endpoint (decorator from another module) are found by their source files', { skip }, () => {
  const ping = diffAt(CHANGES.ping);
  assert.strictEqual(ping.d.coverage, 'ok', ping.d.coverageNote);
  assert.ok(ping.targets.includes('GET /api/health/ping'), ping.targets.join(','));
  assert.ok(ping.d.differences.some((x) => x.target === 'GET /api/health/ping'));
  const deco = diffAt(CHANGES.deco);
  assert.strictEqual(deco.d.coverage, 'ok', deco.d.coverageNote);
  assert.ok(deco.targets.includes('GET /api/health/version'), deco.targets.join(','));
  assert.ok(deco.d.differences.some((x) => x.target === 'GET /api/health/version'));
});

test('a request body that refers to itself does not abort corpus generation: the operation is probed with a bounded example', { skip }, () => {
  const { d, targets } = diffAt(CHANGES.tree);
  assert.strictEqual(d.coverage, 'ok', d.coverageNote);
  assert.ok(targets.includes('POST /api/trees'), targets.join(','));
  assert.ok(d.differences.some((x) => x.target === 'POST /api/trees'), 'the added field is seen');
});

test('control: the frozen v1 detector flags none of the same five changes', { skip }, (t) => {
  const tree = frozenTreeFromGit();
  if (!tree.dir) return t.skip(tree.reason);
  try {
    for (const [name, change] of Object.entries(CHANGES)) {
      const s = hub(change);
      try {
        const record = runner.runSeed({ tree: tree.dir, checkout: s.dir, commit: null, seedId: name, apply: () => { s.apply(); return { id: name, intended: false, kind: name, contract: null, verification: { scope: 'full' } }; }, configure: () => {}, runs: 2 });
        assert.strictEqual(record.error, undefined, record.error);
        assert.strictEqual(record.flagged, false, `${name}: v1 must not detect what it cannot probe: ${JSON.stringify(record)}`);
        assert.ok(record.miss, `${name}: a miss carries its reason: ${JSON.stringify(record)}`);
      } finally {
        fs.rmSync(s.dir, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(tree.dir, { recursive: true, force: true });
  }
});
