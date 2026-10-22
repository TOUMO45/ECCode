'use strict';
// MCP server mode: the engine as typed tool calls, identity locked per server.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const gates = require('../lib/gates');
const { tmpProject, write, approveThroughPlan, expectCode } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'eccode.js');

/** Speak newline-delimited JSON-RPC to a spawned `eccode mcp` server. */
function client(dir, actor) {
  const proc = spawn(process.execPath, [CLI, 'mcp', '--actor', actor, '--root', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    }
  });
  let seq = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, 15000);
  });
  const call = async (name, args = {}) => {
    const res = await request('tools/call', { name, arguments: args });
    const text = res.result.content[0].text;
    return { isError: Boolean(res.result.isError), text, json: () => JSON.parse(text) };
  };
  return { proc, request, call, close: () => proc.stdin.end() };
}

test('mcp: initialize, tools/list, and a full claim→evidence→complete cycle under a locked actor', async () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  const c = client(ctx.dir, 'backend-engineer');
  try {
    const init = await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.match(init.result.serverInfo.name, /eccode \(backend-engineer\)/);
    const list = await c.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['status', 'task_claim', 'task_complete', 'evidence_run', 'gate_review', 'impact', 'map']) assert.ok(names.includes(n), n);

    // Identity is the server's, not an argument: there is no actor parameter anywhere.
    assert.ok(!JSON.stringify(list.result.tools).includes('"actor"'));

    const claim = await c.call('task_claim', { task: 'api' });
    assert.strictEqual(claim.isError, false, claim.text);
    write(ctx.dir, 'src/server/app.js', 'module.exports = 1;\n');
    const ev = await c.call('evidence_run', { label: 'checks', command: 'node -e "process.exit(0)"', task: 'api' });
    assert.strictEqual(ev.json().status, 'passed');
    const done = await c.call('task_complete', {
      task: 'api',
      handoff: {
        from: 'backend-engineer', to: 'delivery-lead', task: 'api',
        objective: 'Complete task api', context: 'Implemented per the approved spec.',
        inputs: [], expectedOutput: 'Working code', acceptanceCriteria: ['api works'],
        completedWork: 'Implemented the endpoint.', filesChanged: ['src/server/app.js'],
        evidence: [ev.json().id], remainingIssues: [], nextAction: 'Phase review',
        testsNotNeeded: 'covered by the phase contract tests (tests task)',
      },
    });
    assert.strictEqual(done.isError, false, done.text);
    assert.strictEqual(ctx.store.state().tasks.api.status, 'done');
    assert.strictEqual(ctx.store.state().tasks.api.completedBy, 'backend-engineer');
  } finally {
    c.close();
  }
});

test('mcp: the locked actor cannot act as anyone else, and engine rules still refuse', async () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  const c = client(ctx.dir, 'frontend-engineer');
  try {
    await c.request('initialize', {});
    const claim = await c.call('task_claim', { task: 'api' }); // owned by backend-engineer
    assert.strictEqual(claim.isError, true);
    assert.match(claim.text, /\[OWNERSHIP\]/);
    // Reviews from the locked role go through the same gate rules.
    const rev = await c.call('gate_review', { gate: 'architecture', review: { decision: 'approve', summary: 'already approved anyway', criteria: [], findings: [] } });
    assert.strictEqual(rev.isError, true);
    const unknown = await c.request('tools/call', { name: 'no_such_tool', arguments: {} });
    assert.strictEqual(unknown.error.code, -32602);
  } finally {
    c.close();
  }
});

test('mcp: refuses to serve as user, and the record survives a malformed line', async () => {
  const ctx = tmpProject();
  const res = spawnSync(process.execPath, [CLI, 'mcp', '--actor', 'user', '--root', ctx.dir], { input: '', encoding: 'utf8' });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /ROLE_NOT_ALLOWED/);

  const c = client(ctx.dir, 'orchestrator');
  try {
    await c.request('initialize', {});
    c.proc.stdin.write('this is not json\n');
    const st = await c.call('status');
    assert.match(st.text, /ECCode project/);
    assert.strictEqual((await c.call('audit')).json().ok, true);
  } finally {
    c.close();
  }
});
