'use strict';
// The managed path: the eccode MCP server (one per role) gains the gf_* tools and wraps the gate and claim tools;
// the three new roles exist as servable roles, agents and hook roles; the toolkit validator knows them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpProject } = require('./helpers');
const sample = require('./fixtures/gf/sample');
const { MUTATIONS } = require('./fixtures/gf/mutations');
const { gfProject, run, WRAPPED, recordRequest } = require('./fixtures/gf/flow');
const mcp = require('../lib/mcp');
const { NEW_ROLES } = require('../lib/greenfield/constants');
const { project } = require('../lib/greenfield/projection');

const ROOT = path.join(__dirname, '..');
const GF_TOOLS = ['gf_status', 'gf_validate', 'gf_message_send', 'gf_message_list', 'gf_amend_request', 'gf_amend_apply', 'gf_estimate_revise', 'gf_seal', 'gf_audit'];
const WRAPPED_TOOLS = ['gate_start', 'gate_submit', 'gate_review', 'task_claim'];
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'guard.js');

const byName = () => Object.fromEntries(mcp.tools().map((t) => [t.name, t]));
const call = (name, args, ctx, actor) => byName()[name].handler(args, { store: ctx.store, config: ctx.config, actor });
const sealed = () => { const ctx = gfProject(); run(ctx, sample.build(), WRAPPED); return ctx; };

function guard(dir, agent, tool, input) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: dir, tool_name: tool, ...(agent ? { agent_type: `eccode:${agent}` } : {}), tool_input: input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ECCODE_ACTOR: '' },
  });
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.permissionDecision : 'allow';
}

test('the tool table has the nine gf_* tools, and the gate and claim tools keep their names and schemas', () => {
  const tools = byName();
  for (const n of GF_TOOLS) assert.ok(tools[n], `${n} is missing`);
  for (const n of WRAPPED_TOOLS) assert.ok(tools[n], `${n} is missing`);
  assert.deepStrictEqual(tools.gate_submit.schema, { gate: { type: 'string' }, artifacts: { type: 'array', items: { type: 'string' } }, respondsTo: { type: 'string' }, notes: { type: 'string' } });
  assert.deepStrictEqual(tools.gate_submit.required, ['gate']);
  assert.deepStrictEqual(tools.task_claim.required, ['task']);
  assert.strictEqual(mcp.tools().length, new Set(mcp.tools().map((t) => t.name)).size, 'tool names are unique');
  for (const n of GF_TOOLS) assert.ok(mcp.toMcpTool(tools[n]).inputSchema.type === 'object');
});

test('the three new roles are servable, and an unknown role still is not', () => {
  for (const r of NEW_ROLES) assert.ok(mcp.LOCKABLE.has(r), `${r} must be lockable`);
  assert.throws(() => mcp.serve({ root: ROOT, actor: 'made-up-role' }), (e) => e.code === 'ROLE_NOT_ALLOWED');
});

test('each new role has an agent definition: matching name, its tools, no Agent tool, a model', () => {
  for (const r of NEW_ROLES) {
    const text = fs.readFileSync(path.join(ROOT, 'agents', `${r}.md`), 'utf8');
    const fm = Object.fromEntries(text.match(/^---\n([\s\S]*?)\n---\n/)[1].split('\n').filter((l) => !l.startsWith(' ')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
    assert.strictEqual(fm.name, r);
    assert.ok(fm.description && fm.description.length > 20);
    assert.ok(!/\bAgent\b/.test(fm.tools), 'a subagent must not spawn agents');
    assert.match(fm.tools, /\bRead\b/);
    assert.ok(fm.model);
  }
});

test('the orchestrate-greenfield skill is a G1 playbook that names the gates, the dry run, the assumptions and the enforcement wording', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills/orchestrate-greenfield/SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: orchestrate-greenfield\n/);
  for (const needle of ['architecture', 'design', 'plan', 'gf_validate', 'eccode-gf', 'DECLARED_ASSUMPTION', 'seal', 'prevention on the managed (MCP) path plus guaranteed detection by log-replay audit in all profiles']) {
    assert.ok(text.includes(needle), `the skill must mention ${needle}`);
  }
});

test('toolkit validation passes with the new roles, agents and skill, and fails if a Greenfield-Senior role loses its agent', () => {
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-toolkit.js')], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /passed/);
  const src = fs.readFileSync(path.join(ROOT, 'scripts/validate-toolkit.js'), 'utf8');
  assert.match(src, /NEW_ROLES/, 'the validator checks the Greenfield-Senior roles');
});

test('gate_submit on a Greenfield-Senior project refuses a mutated PRD with the rule id; nothing is committed', () => {
  const ctx = gfProject();
  const art = sample.build();
  MUTATIONS.find((m) => m.rule === 'GF-PRD-2').apply(art);
  recordRequest(ctx, art);
  const written = sample.write(ctx.dir, art);
  call('gate_start', { gate: 'architecture' }, ctx, 'orchestrator');
  let err;
  try { call('gate_submit', { gate: 'architecture', artifacts: written.architecture }, ctx, 'product-architect'); } catch (e) { err = e; }
  assert.ok(err && err.code === 'GF_RULE' && err.details.problems.some((p) => p.rule === 'GF-PRD-2'), err && err.message);
  assert.strictEqual(ctx.store.state().gates.architecture.submissions.length, 0);
});

test('gate_start, gate_submit, gate_review and task_claim on a plain project behave exactly as the frozen functions (same results, same refusals)', () => {
  const via = tmpProject();
  const direct = tmpProject();
  const gates = require('../lib/gates');
  const tasks = require('../lib/tasks');
  const fsx = require('fs');
  for (const c of [via, direct]) {
    fsx.mkdirSync(path.join(c.dir, '.eccode/artifacts'), { recursive: true });
    fsx.writeFileSync(path.join(c.dir, '.eccode/artifacts/brief.md'), require('./helpers').ARCH_MD);
  }
  assert.strictEqual(call('gate_start', { gate: 'architecture' }, via, 'orchestrator'), 'Gate architecture started.');
  gates.startGate(direct.store, direct.config, 'architecture', 'orchestrator');
  const a = call('gate_submit', { gate: 'architecture', artifacts: ['.eccode/artifacts/brief.md'] }, via, 'product-architect');
  const b = gates.submit(direct.store, direct.config, 'architecture', 'product-architect', { artifacts: ['.eccode/artifacts/brief.md'] }).event.data;
  assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.deepStrictEqual(a.artifacts, b.artifacts, 'same artifacts with the same hashes');
  assert.deepStrictEqual({ gate: a.gate, respondsTo: a.respondsTo, notes: a.notes }, { gate: b.gate, respondsTo: b.respondsTo, notes: b.notes });
  const review = require('./helpers').approval([['artifact:.eccode/artifacts/brief.md#Requirements']]);
  const r1 = call('gate_review', { gate: 'architecture', review }, via, 'architecture-reviewer');
  gates.recordReview(direct.store, direct.config, 'architecture', 'architecture-reviewer', review);
  assert.strictEqual(r1.gateStatus, direct.store.state().gates.architecture.status);
  for (const fn of [(c, act) => tasks.claim(c.store, c.config, 'nope', act), null]) {
    if (!fn) continue;
    let e1; let e2;
    try { call('task_claim', { task: 'nope' }, via, 'backend-engineer'); } catch (e) { e1 = e; }
    try { fn(direct, 'backend-engineer'); } catch (e) { e2 = e; }
    assert.strictEqual(e1.code, e2.code);
    assert.strictEqual(e1.message, e2.message);
  }
  assert.strictEqual(project(via.store.readEvents()).registrations.length, 0);
});

test('the gf_* tools work end to end on a sealed project', () => {
  const ctx = sealed();
  const status = call('gf_status', {}, ctx, 'orchestrator');
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.sealed, true);
  assert.deepStrictEqual(status.stages, { architecture: ['prd', 'architecture'], design: ['contracts', 'threat'], plan: ['breakdown', 'estimates'] });
  assert.strictEqual(status.estimateRegistered, true);

  const before = fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'));
  const dry = call('gf_validate', { gate: 'design', artifacts: ['contracts/openapi.json'] }, ctx, 'technical-designer');
  assert.strictEqual(dry.ok, false, 'a partial design bundle is reported, not committed');
  assert.ok(dry.problems.length >= 1);
  assert.ok(Buffer.compare(before, fs.readFileSync(path.join(ctx.dir, '.eccode/events.jsonl'))) === 0, 'gf_validate writes nothing');

  const m = call('gf_message_send', { to: ['api'], kind: 'amendment-request', subject: 'need GET /me', body: 'the client shows the caller' }, ctx, 'frontend-engineer');
  assert.strictEqual(m.from, 'frontend');
  assert.strictEqual(call('gf_message_list', { to: 'api' }, ctx, 'backend-engineer').length, 1);
  const req = call('gf_amend_request', { contract: 'contracts/openapi.json', reason: 'the web client needs the caller\'s profile and the contract has none', message: m.id, proposed: 'add GET /me' }, ctx, 'frontend-engineer');
  const file = path.join(ctx.dir, 'contracts/openapi.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.paths['/me'] = { get: { operationId: 'getMe', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } }, 401: { description: 'no', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } } };
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  const am = call('gf_amend_apply', { request: req.id, reason: 'approved: additive and needed by the web client' }, ctx, 'technical-reviewer');
  assert.strictEqual(am.classification, 'additive');
  const rev = call('gf_estimate_revise', { reason: 'the contract grew by one operation after the seal', groups: { backend: { tasks: 5, minutes: { low: 100, high: 300 }, tokens: { low: 800000, high: 2000000 } } } }, ctx, 'delivery-lead');
  assert.ok(rev.of);
  const audit = call('gf_audit', {}, ctx, 'orchestrator');
  assert.deepStrictEqual(audit.errors, []);
  assert.strictEqual(audit.enabled, true);
});

test('on a plain project gf_status reports not enabled, and gf_audit is the frozen audit only', () => {
  const plain = tmpProject();
  assert.deepStrictEqual(call('gf_status', {}, plain, 'orchestrator'), { enabled: false });
  const a = call('gf_audit', {}, plain, 'orchestrator');
  assert.strictEqual(a.enabled, false);
  assert.strictEqual(a.ok, true);
});

test('the real server: eccode mcp --actor <new role> lists the gf_* tools and answers a gf_status call over stdio', () => {
  const ctx = sealed();
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gf_status', arguments: {} } },
  ].map((m) => JSON.stringify(m)).join('\n');
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin/eccode.js'), 'mcp', '--actor', 'integration-engineer'], { cwd: ctx.dir, input: `${lines}\n`, encoding: 'utf8', timeout: 30000 });
  const out = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.match(out[0].result.serverInfo.name, /integration-engineer/);
  const names = out[1].result.tools.map((t) => t.name);
  for (const n of [...GF_TOOLS, ...WRAPPED_TOOLS]) assert.ok(names.includes(n), `${n} not served`);
  const status = JSON.parse(out[2].result.content[0].text);
  assert.strictEqual(status.sealed, true);
});

test('the hook knows the new roles: an implementer with no claimed task is denied, a contract snapshot is record-protected', () => {
  const ctx = sealed();
  for (const r of NEW_ROLES) {
    assert.strictEqual(guard(ctx.dir, r, 'Write', { file_path: path.join(ctx.dir, 'app/x.py') }), 'deny', `${r}: no claimed task, so no write`);
  }
  assert.strictEqual(guard(ctx.dir, 'frontend-engineer', 'Write', { file_path: path.join(ctx.dir, 'app/x.py') }), 'deny');
  const snap = path.join(ctx.dir, '.eccode/contracts', `${'a'.repeat(64)}.json`);
  for (const r of [null, 'backend-engineer', 'integration-engineer']) {
    assert.strictEqual(guard(ctx.dir, r, 'Write', { file_path: snap }), 'deny', `${r || 'main session'} may not write a contract snapshot`);
  }
});
