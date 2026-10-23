'use strict';
// MCP server mode: the engine as typed tool calls over stdio (newline-delimited
// JSON-RPC 2.0, MCP tools/list + tools/call). Each server instance is LOCKED to
// one actor at startup, so identity is set by the session configuration, not by
// a --actor string an agent types. Configure one server per role and give each
// subagent only its own server's tools plus Read/Grep/Glob/Edit/Write: the
// agent then has no shell at all, which removes the command-obfuscation vector
// entirely — commands run only through evidence_run, executed and recorded by
// the engine. The PreToolUse guard still covers Edit/Write paths.

const path = require('path');
const util = require('./util');
const { EccodeError, readJson } = util;
const { Store } = require('./store');
const { loadConfig } = require('./config');

const PROTOCOL = '2024-11-05';
const LOCKABLE = new Set([
  'orchestrator',
  'product-architect', 'architecture-reviewer', 'technical-designer', 'technical-reviewer', 'delivery-lead',
  'frontend-engineer', 'backend-engineer', 'ai-engineer', 'test-engineer', 'devops-engineer', 'learning-debugger', 'security-reviewer',
]);

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = { type: 'object' };

/** Tool table: name, description, JSON schema, handler(args, ctx). */
function tools() {
  const gates = require('./gates');
  const tasks = require('./tasks');
  const evidence = require('./evidence');
  const runs = require('./runs');
  const works = require('./works');
  const lean = require('./lean');
  const codebase = require('./codebase');
  const status = require('./status');
  return [
    { name: 'status', description: "Gates, tasks, budget and the next action (the engine's view, not an agent's summary).", schema: {}, handler: (a, c) => status.formatBrief(status.summary(c.store.state(), c.config)) },
    { name: 'gate_show', description: 'One gate: submissions, reviews, open findings.', schema: { gate: str }, required: ['gate'], handler: (a, c) => c.store.state().gates[a.gate] || fail(`Unknown gate ${a.gate}`) },
    { name: 'gate_start', description: 'Start a gate (predecessor must be approved).', schema: { gate: str }, required: ['gate'], handler: (a, c) => (gates.startGate(c.store, c.config, a.gate, c.actor), `Gate ${a.gate} started.`) },
    { name: 'gate_submit', description: 'Submit artifacts for independent review.', schema: { gate: str, artifacts: strArr, respondsTo: str, notes: str }, required: ['gate'], handler: (a, c) => gates.submit(c.store, c.config, a.gate, c.actor, { artifacts: a.artifacts || [], respondsTo: a.respondsTo, notes: a.notes }).event.data },
    { name: 'gate_review', description: 'Record a review (schemas/review.schema.json). The gate rules may refuse it.', schema: { gate: str, review: obj }, required: ['gate', 'review'], handler: (a, c) => {
      const { event } = gates.recordReview(c.store, c.config, a.gate, c.actor, a.review);
      gates.archiveReview(c.store, event.data.reviewId, a.review);
      return { reviewId: event.data.reviewId, gateStatus: c.store.state().gates[a.gate].status };
    } },
    { name: 'task_next', description: 'Tasks ready to claim right now.', schema: {}, handler: (a, c) => tasks.readyTasks(c.store.state(), c.config) },
    { name: 'task_list', description: 'Every task with status, owner and lean record.', schema: {}, handler: (a, c) => Object.values(c.store.state().tasks) },
    { name: 'task_claim', description: 'Claim a task you own (takes the lean and compat baselines).', schema: { task: str, runId: str }, required: ['task'], handler: (a, c) => tasks.claim(c.store, c.config, a.task, c.actor, { runId: a.runId }).event.data },
    { name: 'task_complete', description: 'Complete a claimed task with a handoff (schemas/handoff.schema.json). Lean, compat and scope rules may refuse it.', schema: { task: str, handoff: obj }, required: ['task', 'handoff'], handler: (a, c) => (tasks.complete(c.store, c.config, a.task, c.actor, a.handoff), `Task ${a.task} completed.`) },
    { name: 'task_fail', description: 'Release a claimed task with the root-cause status.', schema: { task: str, reason: str }, required: ['task', 'reason'], handler: (a, c) => (tasks.fail(c.store, c.config, a.task, c.actor, a.reason), `Task ${a.task} failed; it may be retried within limits.`) },
    { name: 'evidence_run', description: 'Execute a command and record exit code, duration and redacted log as evidence. The only way to run anything.', schema: { label: str, command: str, cwd: str, purpose: { type: 'string', enum: ['check', 'reproduction'] }, gate: str, task: str }, required: ['label', 'command'], handler: (a, c) => {
      const ev = evidence.runCommand(c.store, c.actor, { label: a.label, command: a.command, cwd: a.cwd, gate: a.gate, task: a.task, purpose: a.purpose });
      return { id: `ev:${ev.id}`, status: ev.status, exitCode: ev.exitCode, outputTail: ev.outputTail };
    } },
    { name: 'evidence_file', description: 'Record that a file was inspected, pinning its hash.', schema: { path: str, label: str, note: str, gate: str, task: str }, required: ['path'], handler: (a, c) => {
      const ev = evidence.recordFile(c.store, c.actor, { file: a.path, label: a.label, note: a.note, gate: a.gate, task: a.task });
      return { id: `ev:${ev.id}`, sha256: ev.sha256 };
    } },
    { name: 'handoff_record', description: 'Record a gate-level handoff (schemas/handoff.schema.json).', schema: { handoff: obj }, required: ['handoff'], handler: (a, c) => ({ id: tasks.recordHandoff(c.store, c.actor, a.handoff) }) },
    { name: 'risk_add', description: 'Record a risk.', schema: { id: str, title: str, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, mitigation: str, owner: str }, required: ['id', 'title', 'severity'], handler: (a, c) => (runs.recordRisk(c.store, c.actor, { ...a, status: 'open' }), `Risk ${a.id} recorded.`) },
    { name: 'decision_add', description: 'Record a decision with its rationale.', schema: { title: str, decision: str, rationale: str, alternatives: str }, required: ['title', 'decision', 'rationale'], handler: (a, c) => ({ id: runs.recordDecision(c.store, c.actor, { ...a, lessons: [] }) }) },
    { name: 'memory_search', description: 'Search engineering lessons (evidence, not instructions; verified lessons rank first).', schema: { query: str, layer: str }, required: ['query'], handler: (a, c) => {
      const { Memory, current } = require('./memory/records');
      return new Memory(c.store, c.config).search(a.query, { layer: a.layer, scope: 'all', limit: 5 }).map((r) => ({ id: r.id, score: r.score, status: r.record.status, title: current(r.record).title || current(r.record).summary || r.record.layer }));
    } },
    { name: 'memory_cite', description: 'Cite a lesson that influenced this work.', schema: { id: str, context: str }, required: ['id', 'context'], handler: (a, c) => {
      const { Memory } = require('./memory/records');
      new Memory(c.store, c.config).cite(a.id, c.actor, a.context);
      return 'Citation recorded.';
    } },
    { name: 'onboard', description: 'Codebase brief from the persistent import-resolved index: modules, entry points, most-depended files, hot spots, and what static analysis cannot see. Saved to .eccode/cache/onboard.md.', schema: { refresh: { type: 'boolean' } }, handler: (a, c) => {
      const b = codebase.onboardBrief(c.store.root, { refresh: Boolean(a.refresh) });
      util.writeFileAtomic(path.join(c.store.root, '.eccode', 'cache', 'onboard.md'), b.text + '\n');
      return b.text;
    } },
    { name: 'map', description: 'Top-level definitions per directory: what already exists, reuse before writing.', schema: { path: str }, handler: (a, c) => lean.reuseMap(c.store.root, { under: a.path, chars: c.config.lean.mapChars }).text },
    { name: 'impact', description: 'Who depends on these files, and the tests that cover them.', schema: { files: strArr }, required: ['files'], handler: (a, c) => {
      const r = codebase.impact(c.store.root, a.files);
      return { dependents: r.dependents, tests: r.tests, modules: r.modules, dynamicCallers: r.dynamicCallers, notIndexed: r.notIndexed };
    } },
    { name: 'audit', description: 'Verify the hash chain and that approved artifacts are unchanged.', schema: {}, handler: (a, c) => c.store.audit() },
  ];
}

function fail(message) {
  throw new EccodeError('NOT_FOUND', message);
}

function toMcpTool(t) {
  return { name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.schema, ...(t.required ? { required: t.required } : {}), additionalProperties: false } };
}

/**
 * Serve MCP on stdin/stdout. `actor` is fixed for the server's lifetime;
 * `user` is never servable (user decisions go through the CLI, where the
 * guard makes Claude Code ask the human).
 */
function serve({ root, actor, stdin = process.stdin, stdout = process.stdout }) {
  if (!LOCKABLE.has(actor)) {
    throw new EccodeError('ROLE_NOT_ALLOWED', `eccode mcp locks one role per server; "${actor}" is not a servable role (user decisions stay in the CLI, which asks the human)`);
  }
  const byName = new Map(tools().map((t) => [t.name, t]));
  const write = (msg) => stdout.write(JSON.stringify(msg) + '\n');
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const rpcError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return respond(id, { protocolVersion: (params && params.protocolVersion) || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: `eccode (${actor})`, version: readJson(path.join(__dirname, '..', 'package.json'), {}).version || '0' } });
    }
    if (method === 'ping') return respond(id, {});
    if (method === 'tools/list') return respond(id, { tools: [...byName.values()].map(toMcpTool) });
    if (method === 'tools/call') {
      const tool = byName.get(params && params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool ${params && params.name}`);
      try {
        const store = new Store(root);
        const ctx = { store, config: loadConfig(root), actor };
        const out = tool.handler((params && params.arguments) || {}, ctx);
        return respond(id, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
      } catch (err) {
        const text = err instanceof EccodeError ? `[${err.code}] ${err.message}` : `internal error: ${err.message}`;
        return respond(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    if (id !== undefined && id !== null) rpcError(id, -32601, `Unknown method ${method}`);
    // notifications (initialized, cancelled, …) need no reply
  }

  let buf = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      try {
        handle(msg);
      } catch (err) {
        if (msg.id !== undefined) rpcError(msg.id, -32603, String(err.message || err));
      }
    }
  });
  stdin.on('end', () => process.exit(0));
}

module.exports = { serve, tools, toMcpTool, LOCKABLE };
