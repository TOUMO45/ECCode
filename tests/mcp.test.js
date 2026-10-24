'use strict';
// MCP server mode: the engine as typed tool calls, identity locked per server.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
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

    // The persistent codebase brief is served over MCP and saved like the CLI saves it.
    const brief = await c.call('onboard', {});
    assert.strictEqual(brief.isError, false, brief.text);
    assert.match(brief.text, /Codebase brief/);
    assert.ok(fs.existsSync(path.join(ctx.dir, '.eccode', 'cache', 'onboard.md')), 'onboard brief not saved');

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

test('mcp: evidence_run is not a shell — unapproved commands are refused, approved ones run', async () => {
  // Found by an independent audit: evidence_run executed any command, so a
  // locked server could write outside its ownership or run the CLI as another
  // role. It now runs only commands approved upstream.
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  const c = client(ctx.dir, 'backend-engineer');
  try {
    await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const write = await c.call('evidence_run', { label: 'x', command: `node -e "require('fs').writeFileSync('README.md','x')"` });
    assert.strictEqual(write.isError, true, write.text);
    assert.match(write.text, /COMMAND_NOT_APPROVED/);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'README.md')), 'the refused command must not run');
    const before = fs.readFileSync(path.join(ctx.dir, '.eccode', 'events.jsonl'), 'utf8');
    const cli = path.join(__dirname, '..', 'bin', 'eccode.js');
    const asUser = await c.call('evidence_run', { label: 'x', command: `node ${JSON.stringify(cli)} risk add --id R9 --title t --severity low --actor user` });
    assert.strictEqual(asUser.isError, true, asUser.text);
    assert.strictEqual(fs.readFileSync(path.join(ctx.dir, '.eccode', 'events.jsonl'), 'utf8'), before, 'no event may be recorded');
    const ok = await c.call('evidence_run', { label: 'checks', command: 'node -e "process.exit(0)"' }); // the plan's verification command
    assert.strictEqual(ok.isError, false, ok.text);
    assert.strictEqual(ok.json().status, 'passed');
  } finally {
    c.close();
  }
});

test('mcp: bugs is read-only; mutate and fix_verify run only approved test commands', async () => {
  const ctx = tmpProject();
  approveThroughPlan(ctx);
  gates.startGate(ctx.store, ctx.config, 'phase:core', 'orchestrator');
  write(ctx.dir, 'src/server/a.js', 'if (x === NaN) go();\n');
  const c = client(ctx.dir, 'backend-engineer');
  try {
    await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const names = (await c.request('tools/list', {})).result.tools.map((t) => t.name);
    for (const n of ['bugs', 'mutate', 'fix_verify']) assert.ok(names.includes(n), n);
    const scan = await c.call('bugs', {});
    assert.strictEqual(scan.isError, false, scan.text);
    assert.match(scan.text, /ERROR src\/server\/a\.js:1 js\/nan-compare/);
    for (const [tool, args] of [['mutate', { test: 'node -e "require(\'fs\').writeFileSync(\'pwned\',\'x\')"' }], ['fix_verify', { test: 'npm test', base: 'HEAD' }]]) {
      const r = await c.call(tool, args);
      assert.strictEqual(r.isError, true, r.text);
      assert.match(r.text, /COMMAND_NOT_APPROVED/);
    }
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'pwned')), 'the refused command must not run');
  } finally {
    c.close();
  }
});

test('mcp: quick takes no free-form command (detected test check only); handoff_draft drafts for the caller\'s claim', async () => {
  const ctx = tmpProject();
  write(ctx.dir, 'package.json', JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  write(ctx.dir, 'src/a.js', 'module.exports = 1;\n');
  require('../lib/works').abandonWork(ctx.store, 'user', 'superseded by a quick change');
  const orch = client(ctx.dir, 'orchestrator');
  const eng = client(ctx.dir, 'backend-engineer');
  try {
    await orch.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const quickTool = (await orch.request('tools/list', {})).result.tools.find((t) => t.name === 'quick');
    assert.ok(quickTool, 'quick is served');
    assert.ok(!('command' in quickTool.inputSchema.properties), 'no free-form command: it would make the allowlist a shell');
    const q = await orch.call('quick', { request: 'Add a bulk discount', command: 'node -e "require(\'fs\').writeFileSync(\'pwned\',\'x\')"' });
    assert.strictEqual(q.isError, false, q.text);
    assert.strictEqual(q.json().task.verification.command, 'npm test');
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'pwned')));
    await eng.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.strictEqual((await eng.call('task_claim', { task: 'change' })).isError, false);
    write(ctx.dir, 'src/a.js', 'module.exports = 2;\n');
    const d = await eng.call('handoff_draft', { task: 'change' });
    assert.strictEqual(d.isError, false, d.text);
    assert.strictEqual(d.json().task, 'change');
    assert.ok(d.json().filesChanged.includes('src/a.js'), d.text);
    assert.match(d.json().completedWork, /^TODO:/);
    const other = await orch.call('handoff_draft', { task: 'change' });
    assert.strictEqual(other.isError, true, 'only the claimer drafts its handoff');
    assert.strictEqual((await orch.call('task_fail', { task: 'change', reason: 'ownership needs tests/' })).isError, false);
    const rs = await orch.call('task_rescope', { task: 'change', files: 'src/**,tests/**', reason: 'the test goes under tests/' });
    assert.strictEqual(rs.isError, false, rs.text);
    assert.strictEqual((await eng.call('task_rescope', { task: 'change', files: '**', reason: 'let me own everything' })).isError, true, 'the owner cannot widen its own ownership');
  } finally {
    orch.close();
    eng.close();
  }
});

test('mcp: quick and task_rescope narrow the detected check to named test paths, never to a command', async () => {
  const ctx = tmpProject();
  write(ctx.dir, 'package.json', JSON.stringify({ name: 'shop', scripts: { test: 'node --test' } }));
  write(ctx.dir, 'src/a.js', 'module.exports = 1;\n');
  write(ctx.dir, 'tests/a.test.js', "require('node:test')('a', () => {});\n");
  require('../lib/works').abandonWork(ctx.store, 'user', 'superseded by a quick change');
  const orch = client(ctx.dir, 'orchestrator');
  try {
    await orch.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const bad = await orch.call('quick', { request: 'Add a bulk discount', tests: ['tests/a.test.js; touch pwned'] });
    assert.strictEqual(bad.isError, true, 'shell syntax is not a test path');
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'pwned')));
    const q = await orch.call('quick', { request: 'Add a bulk discount', files: 'src/**,tests/**', tests: ['tests/a.test.js'] });
    assert.strictEqual(q.isError, false, q.text);
    assert.strictEqual(q.json().task.verification.command, 'npm test -- tests/a.test.js');
    const rs = await orch.call('task_rescope', { task: 'change', tests: ['tests'], reason: 'the whole tests directory covers the change' });
    assert.strictEqual(rs.isError, false, rs.text);
    assert.strictEqual(ctx.store.state().tasks.change.verification.command, 'npm test -- tests');
    assert.strictEqual((await orch.call('task_rescope', { task: 'change', tests: ['$(id)'], reason: 'trying a command' })).isError, true);
  } finally {
    orch.close();
  }
});
