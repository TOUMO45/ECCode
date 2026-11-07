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
  'integration-engineer', 'database-engineer', 'security-engineer', // the Greenfield-Senior group roles (lib/greenfield)
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
  const list = [
    { name: 'status', description: "Gates, tasks, budget and the next action (the engine's view, not an agent's summary).", schema: {}, handler: (a, c) => status.formatBrief(status.summary(c.store.state(), c.config, { root: c.store.root })) },
    { name: 'gate_show', description: 'One gate: submissions, reviews, open findings.', schema: { gate: str }, required: ['gate'], handler: (a, c) => c.store.state().gates[a.gate] || fail(`Unknown gate ${a.gate}`) },
    { name: 'gate_start', description: 'Start a gate (predecessor must be approved). reviewers (orchestrator only): every reviewer you will dispatch to it, each of whom must then approve.', schema: { gate: str, reviewers: strArr }, required: ['gate'], handler: (a, c) => (gates.startGate(c.store, c.config, a.gate, c.actor, { reviewers: a.reviewers }), `Gate ${a.gate} started.`) },
    { name: 'gate_reopen', description: 'Reopen a gate: an escalated one by the user; headless, an approved one whose artifacts changed after the approval by the orchestrator (recorded as an assumption; it is resubmitted and reviewed again).', schema: { gate: str, resolution: str }, required: ['gate', 'resolution'], handler: (a, c) => gates.reopenGate(c.store, a.gate, c.actor, a.resolution, { config: c.config }).event.data },
    { name: 'gate_submit', description: 'Submit artifacts for independent review.', schema: { gate: str, artifacts: strArr, respondsTo: str, notes: str }, required: ['gate'], handler: (a, c) => gates.submit(c.store, c.config, a.gate, c.actor, { artifacts: a.artifacts || [], respondsTo: a.respondsTo, notes: a.notes }).event.data },
    { name: 'gate_review', description: 'Record a review (schemas/review.schema.json). The gate rules may refuse it.', schema: { gate: str, review: obj }, required: ['gate', 'review'], handler: (a, c) => {
      const { event } = gates.recordReview(c.store, c.config, a.gate, c.actor, a.review);
      gates.archiveReview(c.store, event.data.reviewId, a.review);
      return { reviewId: event.data.reviewId, gateStatus: c.store.state().gates[a.gate].status };
    } },
    { name: 'task_next', description: 'Tasks ready to claim right now.', schema: {}, handler: (a, c) => tasks.readyTasks(c.store.state(), c.config) },
    { name: 'task_list', description: 'Every task with status, owner and lean record.', schema: {}, handler: (a, c) => Object.values(c.store.state().tasks) },
    { name: 'task_claim', description: 'Claim a task you own (takes the lean and compat baselines).', schema: { task: str, runId: str }, required: ['task'], handler: (a, c) => ({ ...tasks.claim(c.store, c.config, a.task, c.actor, { runId: a.runId }).event.data, lessons: require('./memory/draft').lessonsForTask(c.store, c.config, a.task) }) },
    { name: 'task_complete', description: 'Complete a claimed task with a handoff (schemas/handoff.schema.json). Lean, compat and scope rules may refuse it.', schema: { task: str, handoff: obj }, required: ['task', 'handoff'], handler: (a, c) => (tasks.complete(c.store, c.config, a.task, c.actor, a.handoff), `Task ${a.task} completed.`) },
    { name: 'task_rescope', description: 'Correct a pending task\'s file ownership (files), or re-pin its check to the detected test check narrowed to named test paths (tests): the orchestrator on a one-task track, the user otherwise. Release a claimed task with task_fail first.', schema: { task: str, files: str, tests: strArr, reason: str }, required: ['task', 'reason'], handler: (a, c) => {
      let command;
      if (a.tests && [].concat(a.tests).length) {
        const q = require('./quick');
        const t = c.store.state().tasks[a.task];
        const owned = a.files ? String(a.files).split(',').map((f) => f.trim()).filter(Boolean) : (t && t.files) || [];
        command = q.narrowCheck(c.store.root, q.pickTestCheck(require('./stack').checks(c.store.root, c.config), owned), a.tests);
      }
      tasks.rescope(c.store, c.config, a.task, c.actor, { files: a.files, command, reason: a.reason });
      return `Task ${a.task} rescoped${a.files ? `: owns ${a.files}` : ''}${command ? `; pinned check ${command}` : ''}.`;
    } },
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
      const base = a.base || tasks.taskBase(t) || 'HEAD';
      return require('./bugs').format(require('./bugs').scan(c.store.root, { base, all: Boolean(a.all), files: a.files || null }));
    } },
    { name: 'mutate', description: 'Mutation testing on the changed code lines with an approved test command; survivors are behavior no test checks. Recorded as evidence of kind mutation.', schema: { test: str, task: str, base: str, max: { type: 'number' } }, required: ['test'], handler: (a, c) => {
      requireApproved(c, a.test);
      const mutate = require('./mutate');
      const t = a.task ? c.store.state().tasks[a.task] : null;
      const res = mutate.run(c.store.root, { test: a.test, base: a.base || tasks.taskBase(t) || 'HEAD', max: a.max || 25 });
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
    { name: 'quick', description: 'Start a quick change: a one-task work item whose verification command is the detected test check, narrowed to the test paths in tests when given (no free-form command over MCP), ownership the tracked top-level layout unless files is given, and its phase gate started. On a big project name the tests that cover the change: a whole suite can outrun the check time limit. Returns the steps that remain.', schema: { request: str, owner: str, files: str, tests: strArr }, required: ['request'], handler: (a, c) => {
      const q = require('./quick');
      const r = q.start(c.store.root, c.actor, { request: a.request, owner: a.owner, files: a.files, tests: a.tests });
      return { workId: r.workId, task: r.task, defaults: r.defaults, steps: q.steps('eccode', r.task), lessons: r.lessons };
    } },
    { name: 'debug', description: 'Start a bug fix on the debug track: a one-task work item (task fix) whose verification command is the detected test check, narrowed to the test paths in tests when given (no free-form command over MCP), ownership the tracked top-level layout unless files is given, and its phase gate started. The phase is submitted only after fix_verify proves the regression test and a mutation run is recorded. Returns the steps that remain.', schema: { bug: str, owner: str, files: str, tests: strArr }, required: ['bug'], handler: (a, c) => {
      const q = require('./quick');
      const r = q.start(c.store.root, c.actor, { request: a.bug, owner: a.owner, files: a.files, tests: a.tests, track: 'debug' });
      return { workId: r.workId, task: r.task, defaults: r.defaults, steps: q.steps('eccode', r.task, 'debug'), lessons: r.lessons };
    } },
    { name: 'handoff_record', description: 'Record a gate-level handoff (schemas/handoff.schema.json).', schema: { handoff: obj }, required: ['handoff'], handler: (a, c) => ({ id: tasks.recordHandoff(c.store, c.actor, a.handoff) }) },
    { name: 'run_start', description: 'Open a cost run around a dispatch (for: the role dispatched), so the record carries what the work cost. Returns the run id.', schema: { for: str, task: str, gate: str }, handler: (a, c) => ({ id: runs.startRun(c.store, c.config, c.actor, { task: a.task, gate: a.gate, agent: a.for }) }) },
    { name: 'run_end', description: 'Close a cost run with what the dispatch reported (tokens, cost in USD).', schema: { run: str, status: str, costUsd: { type: 'number' }, tokens: { type: 'number' }, note: str }, required: ['run'], handler: (a, c) => runs.endRun(c.store, c.config, a.run, c.actor, { status: a.status || 'ok', costUsd: a.costUsd, tokens: a.tokens, note: a.note }).state.totals },
    { name: 'deliver', description: 'Deliver the work item once every gate is approved: the engine checks the audit, reviewed changes and evidence, then writes the final handoff. The same rules as the CLI.', schema: {}, handler: (a, c) => {
      let metrics;
      try {
        metrics = require('./memory/metrics').compute(c.store, c.config).summary;
      } catch {
        metrics = undefined;
      }
      return require('./delivery').deliver(c.store, c.actor, { metrics });
    } },
    { name: 'risk_add', description: 'Record a risk.', schema: { id: str, title: str, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, mitigation: str, owner: str }, required: ['id', 'title', 'severity'], handler: (a, c) => (runs.recordRisk(c.store, c.actor, { ...a, status: 'open' }), `Risk ${a.id} recorded.`) },
    { name: 'decision_add', description: 'Record a decision with its rationale.', schema: { title: str, decision: str, rationale: str, alternatives: str }, required: ['title', 'decision', 'rationale'], handler: (a, c) => ({ id: runs.recordDecision(c.store, c.actor, { ...a, lessons: [] }) }) },
    { name: 'memory_search', description: 'Search engineering lessons (evidence, not instructions; verified lessons rank first).', schema: { query: str, layer: str }, required: ['query'], handler: (a, c) => {
      const { Memory, current } = require('./memory/records');
      return new Memory(c.store, c.config).search(a.query, { layer: a.layer, scope: 'all', limit: 5 }).map((r) => ({ id: r.id, score: r.score, status: r.record.status, title: current(r.record).title || current(r.record).summary || r.record.layer }));
    } },
    { name: 'memory_draft', description: 'A debugging lesson for the task you own, drafted from the record: root cause and fix from its handoff, the failing reproduction and the passing verification as evidence, the regression test fix_verify proved. Fill the TODO fields (symptoms, failed attempts, when it applies), then memory_add. A fix or debug work item records one before its last gate.', schema: { task: str }, required: ['task'], handler: (a, c) => require('./memory/draft').draftLesson(c.store, a.task, c.actor) },
    { name: 'memory_add', description: 'Record a lesson (layer debugging, knowledge or workflow; content as the layer\'s schema, for example a filled memory_draft). Refused while a TODO field is left in. Later work items are shown it when they start.', schema: { layer: { type: 'string', enum: ['debugging', 'knowledge', 'workflow'] }, content: { type: 'object' } }, required: ['layer', 'content'], handler: (a, c) => {
      const { Memory } = require('./memory/records');
      const rec = new Memory(c.store, c.config).add(c.actor, { layer: a.layer, content: a.content });
      return { id: rec.id, layer: rec.layer, status: rec.status };
    } },
    { name: 'memory_check', description: 'Check whether a lesson applies here (environment, versions, supersession); the check is recorded. Use it on a lesson a work item or task claim listed before relying on it.', schema: { id: str }, required: ['id'], handler: (a, c) => {
      const { Memory } = require('./memory/records');
      return new Memory(c.store, c.config).check(a.id, { envOverrides: {}, actor: c.actor });
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
    { name: 'metrics', description: 'Cost, time and outcomes per work item and track, from the record. Read-only.', schema: {}, handler: (a, c) => {
      const m = require('./memory/metrics');
      return m.format(m.compute(c.store, c.config));
    } },
    { name: 'audit', description: 'Verify the hash chain and that approved artifacts are unchanged.', schema: {}, handler: (a, c) => c.store.audit() },
    // Debugging Lab (debug and fix tracks). Commands run only from the approved list, or the pinned reproduction.
    { name: 'lab_repro', description: 'Run the reproduction (an approved command) and pin it: it must fail; the proof must run it. Debug and fix tracks.', schema: { command: str, task: str }, required: ['command'], handler: (a, c) => {
      requireApproved(c, a.command);
      const r = require('./lab').recordRepro(c.store, c.config, c.actor, { command: a.command, task: a.task });
      return { repro: r.repro.id, exitCode: r.repro.exitCode, evidence: `ev:${r.evidence.id}`, outputTail: r.evidence.outputTail };
    } },
    { name: 'lab_hypothesis_add', description: 'Open a falsifiable hypothesis with the observation predicted if it holds and if it does not.', schema: { statement: str, ifTrue: str, ifFalse: str }, required: ['statement', 'ifTrue', 'ifFalse'], handler: (a, c) => require('./lab').openHypothesis(c.store, c.config, c.actor, a) },
    { name: 'lab_hypothesis_test', description: 'Run an approved command (or the pinned reproduction) for a hypothesis; its artifact is the evidence. Give the verdict now or mark it after reading the output.', schema: { hypothesis: str, command: str, verdict: { type: 'string', enum: ['supports', 'refutes', 'inconclusive'] }, note: str, task: str }, required: ['hypothesis', 'command'], handler: (a, c) => {
      const repro = c.store.state().lab.repro;
      if (!repro || String(a.command).trim() !== repro.command) requireApproved(c, a.command);
      const e = require('./lab').testHypothesis(c.store, c.config, c.actor, a);
      return { ...e, outputTail: c.store.state().evidence[e.evidence].outputTail };
    } },
    { name: 'lab_hypothesis_mark', description: 'Mark pending hypothesis evidence supports, refutes or inconclusive after reading its artifact.', schema: { evidence: str, verdict: { type: 'string', enum: ['supports', 'refutes', 'inconclusive'] }, note: str }, required: ['evidence', 'verdict'], handler: (a, c) => require('./lab').markEvidence(c.store, c.config, c.actor, a) },
    { name: 'lab_hypothesis_close', description: 'Close a hypothesis confirmed (needs executed supports evidence), refuted (needs refutes evidence) or withdrawn.', schema: { hypothesis: str, status: { type: 'string', enum: ['confirmed', 'refuted', 'withdrawn'] } }, required: ['hypothesis', 'status'], handler: (a, c) => require('./lab').closeHypothesis(c.store, c.config, c.actor, a) },
    { name: 'lab_hypothesis_challenge', description: 'Reviewer: dispute a piece of hypothesis evidence; it no longer supports a confirmation.', schema: { evidence: str, reason: str }, required: ['evidence', 'reason'], handler: (a, c) => require('./lab').challengeEvidence(c.store, c.config, c.actor, a) },
    { name: 'lab_localize', description: 'Spectrum-based fault localization (Ochiai) from the pinned pytest reproduction and the passing tests; ranks suspect lines.', schema: { tests: strArr, top: { type: 'number' } }, handler: (a, c) => require('./lab').localizeSbfl(c.store, c.config, c.actor, a) },
    { name: 'lab_bisect', description: 'git bisect run with the pinned reproduction in a detached worktree; records the first bad commit and its diff.', schema: { good: str, bad: str }, required: ['good'], handler: (a, c) => require('./lab').bisect(c.store, c.config, c.actor, a) },
    { name: 'lab_trace', description: 'A temporary probe logs an expression during the pinned reproduction (then is reverted); the values are hypothesis evidence to mark.', schema: { hypothesis: str, at: str, expr: str }, required: ['hypothesis', 'at', 'expr'], handler: (a, c) => require('./lab').trace(c.store, c.config, c.actor, a) },
    { name: 'lab_rootcause', description: 'Declare the root cause on a confirmed hypothesis: locations (file:line), the causal explanation, why the reproduction fails. Required before a fix completes.', schema: { hypothesis: str, locations: strArr, explanation: str, whyReproFails: str }, required: ['hypothesis', 'locations', 'explanation', 'whyReproFails'], handler: (a, c) => require('./lab').declareRootCause(c.store, c.config, c.actor, a) },
    { name: 'lab_escalate', description: 'Record an escalation (rescope or ask-user) once the hypothesis budget is spent; required before another hypothesis. Headless, ask-user carries the assumed answer (reading), recorded as an assumption, and the investigation continues.', schema: { kind: { type: 'string', enum: ['rescope', 'ask-user'] }, reason: str, reading: str, rationale: str }, required: ['kind', 'reason'], handler: (a, c) => require('./lab').escalate(c.store, c.config, c.actor, a) },
    { name: 'lab_show', description: 'The Debugging Lab of this work item: reproduction, hypotheses, evidence, localizations, root cause.', schema: {}, handler: (a, c) => require('./lab').show(c.store.state()) },
    // Behavior diff (fix, feature and refactor tracks).
    { name: 'behavior_route', description: 'Record whether the change reaches a public surface (routes, imported definitions, CLI, schema): then the behavior diff must run before delivery.', schema: {}, handler: (a, c) => require('./behavior').route(c.store, c.config, c.actor) },
    { name: 'behavior_contract', description: 'Declare the intended behaviour changes before the diff runs: entries {surface: http|function|cli, target, inputClass, expected}. Refused on refactor, and once a result exists.', schema: { entries: { type: 'array', items: obj } }, required: ['entries'], handler: (a, c) => require('./behavior').contract(c.store, c.config, c.actor, a.entries) },
    { name: 'behavior_diff', description: 'Run the behavior diff: baseline and candidate worktrees on the same probes; differences classified against the contract. The reviewer re-runs it before approving verification.', schema: { runs: { type: 'number' }, task: str }, handler: (a, c) => require('./behavior').diff(c.store, c.config, c.actor, a) },
    { name: 'behavior_amend', description: 'Reviewer: accept unexplained differences of a result by adding contract entries, with a reason.', schema: { result: str, entries: { type: 'array', items: obj }, reason: str }, required: ['result', 'entries', 'reason'], handler: (a, c) => require('./behavior').amend(c.store, c.config, c.actor, a) },
    { name: 'behavior_waive', description: 'Reviewer: accept a result labelled insufficient-coverage, with a reason.', schema: { result: str, reason: str }, required: ['result', 'reason'], handler: (a, c) => require('./behavior').waive(c.store, c.config, c.actor, a) },
    { name: 'behavior_show', description: 'Routing, contract, results, amendments and waivers of this work item.', schema: {}, handler: (a, c) => require('./behavior').show(c.store.state()) },
    // Design before code (Phase 3).
    { name: 'design_alternatives', description: 'Record the design alternatives compared: >= 2 options, each {id, title, tradeoffs: {complexity, risk, performance, security, reversibility}}. Required before any task is owned on feature, refactor and greenfield.', schema: { options: { type: 'array', items: obj } }, required: ['options'], handler: (a, c) => require('./design').alternatives(c.store, c.config, c.actor, a.options) },
    { name: 'design_decide', description: 'Record the design decision: {alternatives, chosen, rationale, rejected: [{option, why}], interfaces: [{surface, target}]}. Refused once implementation started (then a reviewer amends).', schema: { alternatives: str, chosen: str, rationale: str, rejected: { type: 'array', items: obj }, interfaces: { type: 'array', items: obj } }, required: ['alternatives', 'chosen', 'rationale', 'rejected'], handler: (a, c) => require('./design').decide(c.store, c.config, c.actor, a) },
    { name: 'design_adr', description: 'Render the decision as an ADR artifact (.eccode/design/<id>.md), content-hashed; the verification reviewer cites it.', schema: { decision: str }, handler: (a, c) => require('./design').adr(c.store, c.config, c.actor, a) },
    { name: 'design_amend', description: 'Reviewer: amend the decision\'s interfaces after implementation started, with a reason.', schema: { decision: str, interfaces: { type: 'array', items: obj }, reason: str }, required: ['decision', 'interfaces', 'reason'], handler: (a, c) => require('./design').amend(c.store, c.config, c.actor, a) },
    { name: 'design_spike_start', description: 'Start a spike (throwaway prototype) on the given paths; its code is never delivered.', schema: { question: str, paths: { type: 'array', items: str } }, required: ['question', 'paths'], handler: (a, c) => require('./design').spikeStart(c.store, c.config, c.actor, a) },
    { name: 'design_spike_close', description: 'Close a spike with what it proved; its files are hashed so they cannot ship under another name.', schema: { spike: str, proved: str }, required: ['spike', 'proved'], handler: (a, c) => require('./design').spikeClose(c.store, c.config, c.actor, a.spike, a) },
    { name: 'design_show', description: 'Alternatives, decision, ADRs, amendments, spikes and the request\'s questions of this work item.', schema: {}, handler: (a, c) => require('./design').show(c.store.state()) },
    { name: 'request_ambiguity', description: 'Record the unresolved questions of the request: [{id, text, blocking, options?, reading?}]. Planning is refused while a blocking one is open; headless, a non-blocking one is recorded with its reading as an assumption and work continues.', schema: { questions: { type: 'array', items: obj } }, required: ['questions'], handler: (a, c) => require('./design').ambiguity(c.store, c.config, c.actor, a.questions) },
    { name: 'request_assume', description: 'Headless: record the reasonable reading of an open question as an assumption (surfaced in every handoff and the report). Only the user clarifies.', schema: { question: str, reading: str, rationale: str }, required: ['question', 'reading', 'rationale'], handler: (a, c) => require('./design').assume(c.store, c.config, c.actor, a) },
    { name: 'request_show', description: 'The open questions of the request.', schema: {}, handler: (a, c) => ({ open: require('./design').openQuestions(c.store.state(), true) }) },
    // Production guards (Phase 3).
    { name: 'guard_route', description: 'Record which production guards this change needs (migration, api, perf, race, security, release), from what it reaches; each must run before the last gate.', schema: {}, handler: (a, c) => require('./guards').route(c.store, c.config, c.actor) },
    { name: 'guard_migration', description: 'Static analysis of the change\'s migration files (long locks, irreversible operations, missing downgrade, in-place renames); with proof: true, the rollback proof on a seeded database.', schema: { proof: { type: 'boolean' }, task: str }, handler: (a, c) => (a.proof ? require('./guards/migration').proof(c.store, c.config, c.actor, a) : require('./guards/migration').analyze(c.store, c.config, c.actor, a)) },
    { name: 'guard_api', description: 'OpenAPI schema and Python signatures, baseline vs candidate, classified breaking / additive / none.', schema: { task: str }, handler: (a, c) => require('./guards/api').diff(c.store, c.config, c.actor, a) },
    { name: 'guard_perf', description: 'Micro-benchmark of the change\'s routes in both worktrees with SQL query counts per request.', schema: { task: str }, handler: (a, c) => require('./guards/perf').run(c.store, c.config, c.actor, a) },
    { name: 'guard_race', description: 'The configured operations under concurrent requests against a seeded database; invariants checked on both sides.', schema: { task: str }, handler: (a, c) => require('./guards/race').run(c.store, c.config, c.actor, a) },
    { name: 'guard_release', description: 'Record the release plan: strategy flag|staged, flag or rollout, monitoring, rollback (feature and greenfield deliveries need one, acknowledged by a reviewer).', schema: { strategy: str, flag: str, rollout: str, monitoring: str, rollback: str }, required: ['strategy', 'monitoring', 'rollback'], handler: (a, c) => require('./guards/release').plan(c.store, c.config, c.actor, a) },
    { name: 'guard_release_ack', description: 'Reviewer: acknowledge a release plan.', schema: { plan: str }, required: ['plan'], handler: (a, c) => require('./guards/release').acknowledge(c.store, c.config, c.actor, a) },
    { name: 'guard_waive', description: 'Reviewer: waive one finding of one guard result, with a reason.', schema: { guard: str, result: str, finding: str, reason: str }, required: ['guard', 'result', 'finding', 'reason'], handler: (a, c) => require('./guards').waive(c.store, c.config, c.actor, a) },
    { name: 'plan_contracts', description: 'Declare the interfaces, schemas and API shapes agreed before implementation: [{id, kind: interface|schema|api, text}]. A rescope then cites the contract it changes.', schema: { contracts: { type: 'array', items: obj } }, required: ['contracts'], handler: (a, c) => require('./plan-budget').contracts(c.store, c.config, c.actor, a.contracts) },
    { name: 'plan_checkpoint', description: 'Record an integration checkpoint after a batch of tasks: cite the passing checks you ran (evidence ids). Required every N completed tasks before the next claim.', schema: { evidence: { type: 'array', items: str } }, required: ['evidence'], handler: (a, c) => require('./plan-budget').checkpoint(c.store, c.config, c.actor, a) },
    { name: 'task_waive_budget', description: 'Orchestrator: allow one task to exceed the file/line budget, with a reason (why it is one indivisible unit).', schema: { task: str, reason: str }, required: ['task', 'reason'], handler: (a, c) => require('./plan-budget').waiveBudget(c.store, c.config, c.actor, a) },
    { name: 'plan_show', description: 'The plan contracts, checkpoints and budget waivers of this work item.', schema: {}, handler: (a, c) => require('./plan-budget').show(c.store.state()) },
    { name: 'standards_show', description: 'The team\'s observed standards (commit messages, naming, test layout, error handling, stated lint rules) from the repository\'s history and configuration; observed, never enforced.', schema: { limit: { type: 'number' } }, handler: (a, c) => { const s = require('./standards'); return s.brief(s.extract(c.store.root, a.limit ? { limit: a.limit } : {})); } },
    { name: 'standards_extract', description: 'Record the observed standards as project memory (observed, never enforced).', schema: { limit: { type: 'number' } }, handler: (a, c) => { const s = require('./standards'); const r = s.extract(c.store.root, a.limit ? { limit: a.limit } : {}); return { record: s.record(c.store, c.config, c.actor, r), ...r }; } },
    { name: 'guard_show', description: 'Routing, analyses, proofs, diffs, benchmarks, race probes, release plans and waivers of this work item.', schema: {}, handler: (a, c) => require('./guards').show(c.store.state()) },
    // Security as a capability (Phase 3, Part C).
    { name: 'security_policy', description: 'Declare the authorization policy: cells of role x endpoint x ownership (own|other|none) -> allow|deny. Security-reviewer or technical-designer.', schema: { cells: { type: 'array', items: obj } }, required: ['cells'], handler: (a, c) => require('./security').policy(c.store, c.config, c.actor, a.cells) },
    { name: 'security_matrix', description: 'Build and run the access matrix: every role x endpoint x ownership is requested and compared to the declared policy; undeclared cells are unknown.', schema: { task: str }, handler: (a, c) => require('./security').matrix(c.store, c.config, c.actor, a) },
    { name: 'security_idor', description: 'IDOR/BOLA probes: create objects as one user, access them as another of the same role, a lower role and unauthenticated; a non-owner 2xx or a leaked field is a failure.', schema: { task: str }, handler: (a, c) => require('./security').idor(c.store, c.config, c.actor, a) },
    { name: 'security_authflow', description: 'Executed auth-flow checks: token works then logout invalidates it; a password-reset token is single-use (.eccode/security.json authFlows).', schema: { task: str }, handler: (a, c) => require('./security').authflow(c.store, c.config, c.actor, a) },
    { name: 'security_input', description: 'Targeted input-handling probes on the changed endpoints: SQL in string params, path traversal, SSRF, template injection; evidence is the request/response pair.', schema: { task: str }, handler: (a, c) => require('./security').inputProbes(c.store, c.config, c.actor, a) },
    { name: 'security_show', description: 'The access matrix, IDOR, auth-flow and input results of this work item.', schema: {}, handler: (a, c) => require('./security').reportLines(c.store.state()).join('\n') },
  ];
  // The Greenfield-Senior layer: wraps the gate and claim tools for its projects, adds the gf_* tools.
  return require('./greenfield').extendTools(list);
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
  if (s.lab && s.lab.repro && typeof s.lab.repro.command === 'string') out.add(s.lab.repro.command.trim());
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

module.exports = { serve, tools, toMcpTool, LOCKABLE, approvedCommands };
