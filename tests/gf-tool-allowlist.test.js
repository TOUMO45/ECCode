'use strict';
// S2.3 (the owner's decision of 2026-11-08, after the S2.2 review's I2-1): default deny for a group role's tool access.
// In a Greenfield-Senior project a group role may call only a fixed allowlist of its role-locked server's tools, the
// ones that run no project code (record, read, submit and status tools, and the runner gf_run); every other tool of the
// server is refused before it does anything (GF-RUN-2, design 18.4), tools added later included.
//
// The enumeration test: every tool registered on a group role's server (lib/mcp.js tools(), the same table for every
// role; the role is locked when the server starts) is classified here as allowed or refused, and the test fails when a
// tool is in neither list, when a refused tool is not refused to every group role, or when an allowed tool is. Before
// S2.3 this file failed for guard_migration, security_matrix, security_idor, security_authflow, security_input,
// guard_api, guard_perf and guard_race (the I2-1 tools) among others.
const test = require('node:test');
const assert = require('node:assert');
const X = require('./fixtures/gf/close');
const { tmpProject } = require('./helpers');
const mcp = require('../lib/mcp');
const C = require('../lib/greenfield/constants');
const gf = require('../lib/greenfield');
const { closeProject, F } = X;

/** The fixed set a group role may call: tools that run no project code. */
const ALLOWED = [
  // status and reads
  'status', 'gate_show', 'task_next', 'task_list', 'handoff_draft', 'metrics', 'audit',
  'memory_search', 'memory_check', 'request_show', 'design_show', 'behavior_show', 'guard_show', 'security_show',
  'plan_show', 'lab_show', 'standards_show', 'map', 'impact', 'onboard',
  'gf_status', 'gf_validate', 'gf_ownership_show', 'gf_attribute', 'gf_preflight', 'gf_audit', 'gf_message_list',
  // records and submissions
  'gate_submit', 'task_claim', 'task_complete', 'task_fail', 'evidence_file', 'handoff_record', 'risk_add', 'decision_add',
  'memory_draft', 'memory_add', 'memory_cite', 'behavior_route', 'behavior_contract', 'guard_route', 'guard_release',
  'gf_message_send', 'gf_amend_request', 'gf_estimate_revise',
  // the runner: the only route for a command
  'gf_run',
];
/** Everything else on the server today, named so that a tool added later is caught as unclassified. */
const REFUSED = [
  'gate_start', 'gate_reopen', 'gate_review', 'task_rescope', 'evidence_run', 'bugs', 'mutate', 'fix_verify', 'quick', 'debug',
  'run_start', 'run_end', 'deliver',
  'lab_repro', 'lab_hypothesis_add', 'lab_hypothesis_test', 'lab_hypothesis_mark', 'lab_hypothesis_close', 'lab_hypothesis_challenge',
  'lab_localize', 'lab_bisect', 'lab_trace', 'lab_rootcause', 'lab_escalate',
  'behavior_diff', 'behavior_amend', 'behavior_waive',
  'design_alternatives', 'design_decide', 'design_adr', 'design_amend', 'design_spike_start', 'design_spike_close',
  'request_ambiguity', 'request_assume',
  'guard_migration', 'guard_api', 'guard_perf', 'guard_race', 'guard_release_ack', 'guard_waive',
  'plan_contracts', 'plan_checkpoint', 'task_waive_budget', 'standards_extract',
  'security_policy', 'security_matrix', 'security_idor', 'security_authflow', 'security_input',
  'gf_amend_apply', 'gf_seal', 'gf_ownership_amend', 'gf_config_pin', 'gf_dispatch_record', 'gf_review_record', 'gf_finding_resolve',
  'gf_battery_run', 'gf_close',
];
const GROUP_ROLES = Object.values(C.GROUPS).flat();
const I2_1_TOOLS = ['guard_migration', 'security_matrix', 'security_idor', 'security_authflow', 'security_input', 'guard_api', 'guard_perf', 'guard_race'];

const tool = (name) => mcp.tools().find((t) => t.name === name);
const rulesOf = (err) => ((err && err.details && err.details.problems) || []).map((p) => p.rule);
/** Call a tool with empty arguments; return the error (null when it succeeded). */
function attempt(name, ctx, actor, args = {}) {
  try { tool(name).handler(args, { store: ctx.store, config: ctx.config, actor }); return null; } catch (e) { return e; }
}
/** The default-deny refusal, as distinct from the runner's own GF-RUN-2 validation of a gf_run call. */
const isDenied = (err) => rulesOf(err).includes('GF-RUN-2') && /default deny/.test(err.message) && /gf_run/.test(err.message);

/** A sealed Greenfield-Senior project at the first phase, with a claimed task per group where the sample has one. */
function project() {
  const ctx = closeProject();
  require('../lib/greenfield/wrap').gateStart(ctx.store, ctx.config, 'phase:skeleton', 'orchestrator');
  F(ctx, 'task.claimed', 'backend-engineer', { task: 's0-app' });
  return ctx;
}

test('enumeration: every tool of a group role\'s server is classified, as allowed or as refused, and no name is in both lists', () => {
  const names = mcp.tools().map((t) => t.name);
  assert.deepStrictEqual(names.length, new Set(names).size, 'tool names are unique');
  const classified = new Set([...ALLOWED, ...REFUSED]);
  const unclassified = names.filter((n) => !classified.has(n));
  assert.deepStrictEqual(unclassified, [], `tools registered on the server and classified neither allowed nor refused: ${unclassified.join(', ')} (classify each one here)`);
  const stale = [...classified].filter((n) => !names.includes(n));
  assert.deepStrictEqual(stale, [], `classified names that are no longer tools: ${stale.join(', ')}`);
  const both = ALLOWED.filter((n) => REFUSED.includes(n));
  assert.deepStrictEqual(both, [], `in both lists: ${both.join(', ')}`);
});

test('enumeration: the engine\'s allowlist is this test\'s allowed list, exactly (default deny: the engine refuses every other name)', () => {
  assert.ok(Array.isArray(gf.GROUP_ROLE_TOOLS), 'lib/greenfield exports GROUP_ROLE_TOOLS, the allowlist');
  assert.deepStrictEqual([...gf.GROUP_ROLE_TOOLS].sort(), [...ALLOWED].sort());
});

test('default deny: in a Greenfield-Senior project every refused tool is refused to every group role with GF-RUN-2, names gf_run, and records nothing', () => {
  const ctx = project();
  const unrefused = [];
  for (const role of GROUP_ROLES) {
    for (const name of REFUSED) {
      const n = ctx.store.readEvents().length;
      const err = attempt(name, ctx, role);
      if (!isDenied(err)) unrefused.push(`${role}:${name} (${err ? err.message.split('\n')[0].slice(0, 80) : 'succeeded'})`);
      if (ctx.store.readEvents().length !== n) unrefused.push(`${role}:${name} recorded an event`);
    }
  }
  assert.deepStrictEqual(unrefused, [], `tools a group role could call outside the allowlist: ${unrefused.join('; ')}`);
});

test('default deny: the eight I2-1 tools are among the refused (the S2.2 review\'s reproduction, named)', () => {
  for (const name of I2_1_TOOLS) assert.ok(REFUSED.includes(name), `${name} is refused`);
  const ctx = project();
  for (const name of I2_1_TOOLS) assert.ok(isDenied(attempt(name, ctx, 'database-engineer', { proof: true, task: 's0-db' })), `${name} refused to database-engineer`);
});

test('allowlist: no allowed tool is refused to a group role in a Greenfield-Senior project (whatever else it answers)', () => {
  const ctx = project();
  for (const role of ['backend-engineer', 'delivery-lead']) {
    for (const name of ALLOWED) {
      const err = attempt(name, ctx, role);
      assert.ok(!isDenied(err), `${role} ${name} was refused: ${err && err.message}`);
    }
  }
});

test('negative: the orchestrator and a role in no group keep every tool (the default deny binds group roles only)', () => {
  const ctx = project();
  for (const role of ['orchestrator', 'technical-reviewer', 'learning-debugger']) {
    for (const name of ['gate_start', 'evidence_run', 'guard_migration', 'security_matrix', 'gf_dispatch_record', 'bugs']) {
      const err = attempt(name, ctx, role);
      assert.ok(!err || !rulesOf(err).includes('GF-RUN-2'), `${role} ${name} was refused: ${err && err.message}`);
    }
  }
});

test('negative: outside a Greenfield-Senior project a group role keeps every tool', () => {
  const ctx = tmpProject();
  for (const name of ['evidence_run', 'guard_migration', 'security_matrix', 'gate_start', 'lab_repro']) {
    const err = attempt(name, ctx, 'backend-engineer');
    assert.ok(!err || !rulesOf(err).includes('GF-RUN-2'), `backend-engineer ${name} was refused: ${err && err.message}`);
  }
});

test('bypass: a tool added to the server later is refused to a group role without being named anywhere (default deny, not a deny-list)', () => {
  const later = { name: 'zz_added_later', description: 'a tool nobody classified', schema: {}, handler: () => 'ran' };
  const list = gf.extendTools([later]);
  const added = list.find((t) => t.name === 'zz_added_later');
  const ctx = project();
  let err = null;
  try { added.handler({}, { store: ctx.store, config: ctx.config, actor: 'backend-engineer' }); } catch (e) { err = e; }
  assert.ok(isDenied(err), err ? err.message : 'the later tool ran for a group role');
  assert.strictEqual(added.handler({}, { store: ctx.store, config: ctx.config, actor: 'orchestrator' }), 'ran');
});

test('bypass: the refusal is decided at each call, so a project that becomes Greenfield-Senior after the server started refuses too', () => {
  const plain = tmpProject();
  assert.strictEqual(rulesOf(attempt('evidence_run', plain, 'backend-engineer')).includes('GF-RUN-2'), false, 'plain project: not refused');
  const ctx = project(); // the same tool table, a Greenfield-Senior record
  assert.ok(isDenied(attempt('evidence_run', ctx, 'backend-engineer')));
});
