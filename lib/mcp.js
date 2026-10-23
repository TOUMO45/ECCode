'use strict';
// MCP server mode: the engine as typed tool calls over stdio (newline-delimited
// JSON-RPC 2.0, MCP tools/list + tools/call). Each server instance is LOCKED to
// one actor at startup, so identity is set by the session configuration, not by
// a --actor string an agent types. Configure one server per role and give each
// subagent only its own server's tools plus Read/Grep/Glob/Edit/Write: the
// agent then has no shell at all, which removes the command-obfuscation vector
// entirely — commands run only through evidence_run, which accepts only
// commands approved upstream (planned task checks, the behavior command, stack
// checks), executed and recorded by the engine. The PreToolUse guard still covers Edit/Write paths.

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
    { name: 'task_rescope', description: 'Correct a pending task\'s file ownership: the orchestrator on the quick track, the user otherwise. Release a claimed task with task_fail first.', schema: { task: str, files: str, reason: str }, required: ['task', 'files', 'reason'], handler: (a, c) => (tasks.rescope(c.store, c.config, a.task, c.actor, { files: a.files, reason: a.reason }), `Task ${a.task} now owns ${a.files}.`) },
    { name: 'task_fail', description: 'Release a claimed task with the root-cause status.', schema: { task: str, reason: str }, required: ['task', 'reason'], handler: (a, c) => (tasks.fail(c.store, c.config, a.task, c.actor, a.reason), `Task ${a.task} failed; it may be retried within limits.`) },
    { name: 'evidence_run', description: 'Run one of the project\'s approved commands (a planned task verification command, the work item\'s behavior command, or a detected stack check) and record exit code, duration and redacted log as evidence. Other commands are refused: this server exposes no general shell.', schema: { label: str, command: str, cwd: str, purpose: { type: 'string', enum: ['check', 'reproduction'] }, gate: str, task: str }, required: ['label', 'command'], handler: (a, c) => {
      const allowed = approvedCommands(c.store, c.config);
      if (!allowed.includes(String(a.command).trim())) {
        throw new EccodeError('COMMAND_NOT_APPROVED', `MCP mode runs only approved commands; "${a.command}" is not one. Approved: ${allowed.map((x) => JSON.stringify(x)).join(', ') || '(none yet: approve a plan with verification commands)'}`);
      }
      const ev = evidence.runCommand(c.store, c.actor, { label: a.label, command: a.command, cwd: a.cwd, gate: a.gate, task: a.task, purpose: a.purpose });
      return { id: `ev:${ev.id}`, status: ev.status, exitCode: ev.exitCode, outputTail: ev.outputTail };
    } },
    { name: 'bugs', description: 'Bug patterns on the lines a change added (or a claimed task added) plus installed analyzers\' findings on those lines. Read-only.', schema: { task: str, base: str, all: { type: 'boolean' }, files: strArr }, handler: (a, c) => {
      const t = a.task ? c.store.state().tasks[a.task] : null;
      if (a.task && !t) fail(`Unknown task ${a.task}`);
      const base = a.base || (t && t.claim && t.claim.baseCommit) || 'HEAD';
      return require('./bugs').format(require('./bugs').scan(c.store.root, { base, all: Boolean(a.all), files: a.files || null }));
    } },
    { name: 'mutate', description: 'Mutation testing on the changed code lines with an approved test command; survivors are behavior no test checks. Recorded as evidence of kind mutation.', schema: { test: str, task: str, base: str, max: { type: 'number' } }, required: ['test'], handler: (a, c) => {
      requireApproved(c, a.test);
      const mutate = require('./mutate');
      const t = a.task ? c.store.state().tasks[a.task] : null;
      const res = mutate.run(c.store.root, { test: a.test, base: a.base || (t && t.claim && t.claim.baseCommit) || 'HEAD', max: a.max || 25 });
      if (res.total) res.evidence = `ev:${mutate.record(c.store, c.actor, res, { task: a.task }).id}`;
      return `${mutate.format(res)}${res.evidence ? `\nRecorded as ${res.evidence}` : ''}`;
    } },
    { name: 'fix_verify', description: 'Prove a regression test catches the bug: it must fail on the pre-fix code (worktree at the task\'s claim base) and pass on the fix. Approved test commands only.', schema: { test: str, task: str, base: str }, required: ['test'], handler: (a, c) => {
      requireApproved(c, a.test);
      const fixverify = require('./fixverify');
      return fixverify.format(fixverify.verify(c.store, c.actor, { test: a.test, task: a.task, base: a.base }));
    } },
    { name: 'evidence_file', description: 'Record that a file was inspected, pinning its hash.', schema: { path: str, label: str, note: str, gate: str, task: str }, required: ['path'], handler: (a, c) => {
      const ev = evidence.recordFile(c.store, c.actor, { file: a.path, label: a.label, note: a.note, gate: a.gate, task: a.task });
      return { id: `ev:${ev.id}`, sha256: ev.sha256 };
    } },
    { name: 'handoff_draft', description: 'A handoff for the task you claimed, with what the record knows filled in: changed files inside your ownership, the latest passing run of the planned check, the criteria. Fill the TODO fields, then task_complete (completion refuses a TODO left in).', schema: { task: str }, required: ['task'], handler: (a, c) => require('./quick').draftHandoff(c.store, a.task, c.actor) },
    { name: 'quick', description: 'Start a quick change: a one-task work item whose verification command is the detected test check (no free-form command over MCP), ownership the tracked top-level layout unless files is given, and its phase gate started. Returns the steps that remain.', schema: { request: str, owner: str, files: str }, required: ['request'], handler: (a, c) => {
      const q = require('./quick');
      const r = q.start(c.store.root, c.actor, { request: a.request, owner: a.owner, files: a.files });
      return { workId: r.workId, task: r.task, defaults: r.defaults, steps: q.steps('eccode', r.task) };
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
      return { dependents: r.dependents, tests: r.tests, testSupport: r.testSupport, modules: r.moduleCounts, dynamicCallers: r.dynamicCallers, notIndexed: r.notIndexed };
    } },
    { name: 'audit', description: 'Verify the hash chain and that approved artifacts are unchanged.', schema: {}, handler: (a, c) => c.store.audit() },
  ];
}

// The commands an MCP caller may execute: those already approved upstream —
// planned task verification commands (reviewed at plan approval), the work
// item's behavior command, and the detected stack checks. Anything else would
// make evidence_run a general shell, which this surface exists to remove.
function approvedCommands(store, config) {
  const s = store.state();
  const out = new Set();
  for (const t of Object.values(s.tasks || {})) {
    if (t.verification && typeof t.verification.command === 'string') out.add(t.verification.command.trim());
  }
  if (s.work && typeof s.work.behaviorCommand === 'string') out.add(s.work.behaviorCommand.trim());
  try {
    for (const ch of require('./stack').checks(store.root, config)) if (ch.available && ch.command) out.add(String(ch.command).trim());
  } catch { /* no detectable stack: planned commands only */ }
  return [...out].filter(Boolean).sort();
}

/** Commands that execute project code run only from the approved list. */
function requireApproved(c, command) {
  const allowed = approvedCommands(c.store, c.config);
  if (!allowed.includes(String(command).trim())) {
    throw new EccodeError('COMMAND_NOT_APPROVED', `MCP mode runs only approved commands; "${command}" is not one. Approved: ${allowed.map((x) => JSON.stringify(x)).join(', ') || '(none yet: approve a plan with verification commands)'}`);
  }
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
