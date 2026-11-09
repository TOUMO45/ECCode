'use strict';
// S3.1 I5 (L-GF-86: `gate start phase:build` by the group role backend-engineer was ACCEPTED). The engine's managed
// actions are checked against a default-deny action->role matrix (lib/greenfield/authz.js) before any other check,
// rule GF-ROLE-1, and each refusal is logged once in the rejection log (I4). The denied cases are generated from the
// matrix: every (action, role) pair outside a row is refused; every role in a row is not refused by GF-ROLE-1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { gfProject, run, WRAPPED } = require('./fixtures/gf/flow');
const sample = require('./fixtures/gf/sample');
const wrap = require('../lib/greenfield/wrap');
const C = require('../lib/greenfield/constants');

const ROOT = path.join(__dirname, '..');
const authz = () => require('../lib/greenfield/authz');
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);
const entries = (dir) => { const f = path.join(dir, '.eccode', 'rejections.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const attempt = (fn) => { try { fn(); return null; } catch (e) { return e; } };

/** A sealed project whose phase is named `build`, as in the S3 run. */
function sealedBuild() {
  const art = sample.build();
  art.plan.phases[0].id = 'build';
  for (const t of art.plan.tasks) t.phase = 'build';
  const ctx = gfProject();
  run(ctx, art, WRAPPED);
  return ctx;
}

test('I5 L-GF-86 (literal): gate start phase:build by backend-engineer is refused with GF-ROLE-1 and logged once', () => {
  const ctx = sealedBuild();
  const err = attempt(() => wrap.gateStart(ctx.store, ctx.config, 'phase:build', 'backend-engineer'));
  assert.ok(err, 'gate start phase:build by backend-engineer must be refused');
  assert.deepStrictEqual(rulesOf(err), ['GF-ROLE-1'], err.message);
  assert.strictEqual(ctx.store.state().gates['phase:build'].status, 'pending', 'the gate did not start');
  const log = entries(ctx.dir);
  assert.strictEqual(log.length, 1, JSON.stringify(log));
  assert.deepStrictEqual([log[0].actor, log[0].action, log[0].rule], ['backend-engineer', 'gate.start', 'GF-ROLE-1']);
  // The same through the eccode-gf CLI.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/eccode-gf.js'), 'gate', 'start', 'phase:build', '--actor', 'backend-engineer'], { cwd: ctx.dir, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, r.stdout);
  assert.ok(/GF-ROLE-1/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  assert.strictEqual(entries(ctx.dir).length, 2);
  assert.strictEqual(ctx.store.state().gates['phase:build'].status, 'pending');
  // The orchestrator still starts it.
  wrap.gateStart(ctx.store, ctx.config, 'phase:build', 'orchestrator');
  assert.strictEqual(ctx.store.state().gates['phase:build'].status, 'in_progress');
  assert.strictEqual(entries(ctx.dir).length, 2, 'a success writes no entry');
});

/** Call the managed operation for a matrix row as `role`. */
function callRow(ctx, row, role) {
  const [action, kind] = row.split(':');
  const gate = kind === 'phase' ? 'phase:core' : kind;
  switch (action) {
    case 'gate.start': return wrap.gateStart(ctx.store, ctx.config, gate, role);
    case 'gate.submit': return wrap.gateSubmit(ctx.store, ctx.config, gate, role, { artifacts: [] });
    case 'gate.review': return wrap.gateReview(ctx.store, ctx.config, gate, role, { decision: 'approve' });
    case 'seal': return wrap.seal(ctx.store, ctx.config, role);
    case 'task.claim': return wrap.taskClaim(ctx.store, ctx.config, 'T-1', role, {});
    case 'task.complete': return wrap.taskComplete(ctx.store, ctx.config, 'T-1', role, {});
    default: throw new Error(`no caller for ${row}`);
  }
}

test('I5 matrix: every denied (action, role) combination is refused with GF-ROLE-1 and logged exactly once', () => {
  const ctx = gfProject();
  const matrix = authz().matrix(ctx.config);
  for (const a of ['gate.start:phase', 'gate.submit:phase', 'gate.review:phase', 'seal', 'task.claim', 'task.complete']) assert.ok(matrix[a], `matrix row ${a}`);
  assert.deepStrictEqual(matrix['gate.start:phase'], ['orchestrator'], 'phase gates are started by the orchestrator only');
  const roles = authz().knownRoles(ctx.config);
  assert.ok(roles.includes('backend-engineer') && roles.includes('user') && roles.includes('orchestrator'));
  let denied = 0;
  for (const [row, allowed] of Object.entries(matrix)) {
    for (const role of [...roles, 'some-other-agent']) {
      if (allowed.includes(role)) continue;
      const before = entries(ctx.dir).length;
      const err = attempt(() => callRow(ctx, row, role));
      assert.ok(err, `${row} by ${role} must be refused`);
      assert.deepStrictEqual(rulesOf(err), ['GF-ROLE-1'], `${row} by ${role}: ${err.message}`);
      const log = entries(ctx.dir);
      assert.strictEqual(log.length, before + 1, `${row} by ${role}: exactly one entry`);
      assert.deepStrictEqual([log[log.length - 1].actor, log[log.length - 1].action, log[log.length - 1].rule], [role, row.split(':')[0], 'GF-ROLE-1']);
      denied++;
    }
  }
  assert.ok(denied > 100, `generated ${denied} denied combinations`);
});

test('I5 matrix: every allowed (action, role) combination passes GF-ROLE-1 (later checks may still refuse it)', () => {
  const ctx = gfProject();
  for (const [row, allowed] of Object.entries(authz().matrix(ctx.config))) {
    for (const role of allowed) {
      if (role === authz().ENGINE) continue;
      const err = attempt(() => callRow(ctx, row, role));
      assert.ok(!rulesOf(err).includes('GF-ROLE-1'), `${row} by ${role} refused by GF-ROLE-1: ${err && err.message}`);
    }
  }
  assert.ok(entries(ctx.dir).every((e) => e.rule !== 'GF-ROLE-1'));
});

test('I5 default deny: an action with no row is refused for every role; the usual flow and a group role claiming its own task still pass', () => {
  const ctx = gfProject();
  for (const role of ['orchestrator', 'user', 'backend-engineer']) {
    const p = authz().problems(ctx.config, 'gate.frobnicate', role);
    assert.deepStrictEqual(p.map((x) => x.rule), ['GF-ROLE-1']);
  }
  assert.deepStrictEqual(authz().problems(ctx.config, 'gate.start', 'orchestrator', { gate: 'phase:x' }), []);
  // The whole document flow with its usual actors still passes, and a group role may claim its own task after the phase starts.
  const s = sealedBuild();
  wrap.gateStart(s.store, s.config, 'phase:build', 'orchestrator');
  const t = Object.values(s.store.state().tasks)[0];
  assert.ok(C.groupOf(t.owner), t.owner);
  wrap.taskClaim(s.store, s.config, t.id, t.owner, {});
  assert.strictEqual(s.store.state().tasks[t.id].status, 'claimed');
  assert.strictEqual(entries(s.dir).length, 0);
});
