'use strict';
// Final verified handoff. Delivery is refused unless every gate is approved,
// every task is done, the event chain is intact, and every reviewed file is
// still byte-identical to the version its last approval covered.

const path = require('path');
const { EccodeError, sha256File, exists, writeFileAtomic, writeJson } = require('./util');
const { pendingRedelivery, nextDeliveryIndex } = require('./rework');

/**
 * Files whose current content differs from their most recent approved version. A file that is gone is
 * only a problem if no later approved phase (a rework, say) recorded the deletion among the files its
 * task changed: that deletion was part of reviewed work. A modified file whose current hash a later,
 * not-yet-approved gate has already submitted for review is flagged `pending` with that gate: it is in
 * the normal flow (e.g. the verification submission carries the final versions), not an unreviewed
 * edit. Delivery treats every entry as a blocker; `eccode audit` reports pending ones as warnings.
 */
function unreviewedChanges(state, root) {
  const latest = new Map(); // path -> {sha256, gate, index}
  const pendingSubs = []; // latest submission of every gate still under review
  state.gateOrder.forEach((gateId, index) => {
    const g = state.gates[gateId];
    if (g.status !== 'approved') {
      if (g.submissions.length) pendingSubs.push({ gate: gateId, artifacts: g.submissions[g.submissions.length - 1].artifacts });
      return;
    }
    const sub = g.submissions.find((s) => s.id === g.approvedSubmission);
    for (const a of sub.artifacts) latest.set(a.path, { sha256: a.sha256, gate: gateId, at: g.approvedAt, index });
  });
  const deletedInReviewedWork = (p, fromIndex) =>
    state.gateOrder.slice(fromIndex + 1).some((gateId) => {
      if (!gateId.startsWith('phase:') || state.gates[gateId].status !== 'approved') return false;
      const phase = gateId.slice('phase:'.length);
      return Object.values(state.tasks || {}).some((t) => t.phase === phase && (t.filesChanged || []).includes(p));
    });
  const changed = [];
  for (const [p, info] of latest) {
    const abs = path.join(root, p);
    if (!exists(abs)) {
      if (!deletedInReviewedWork(p, info.index)) changed.push({ path: p, gate: info.gate, problem: 'deleted after approval' });
      continue;
    }
    const current = sha256File(abs);
    if (current === info.sha256) continue;
    const entry = { path: p, gate: info.gate, problem: 'modified after approval' };
    const pending = pendingSubs.find((s) => s.artifacts.some((a) => a.path === p && a.sha256 === current));
    if (pending) {
      entry.pending = pending.gate;
      entry.problem = `modified after approval; the new version is submitted for review in ${pending.gate}`;
    }
    changed.push(entry);
  }
  return changed;
}

function userEventSummary(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'gate.reopened':
      return `${d.gate} reopened: ${d.resolution}`;
    case 'risk.recorded':
      return `${d.id} ${d.status}${d.title ? `: ${d.title}` : ''}`;
    case 'decision.recorded':
      return `${d.title}: ${d.decision}`;
    case 'task.reset':
      return `${d.task} reset: ${d.reason}`;
    case 'improvement.adopted':
      return `${d.id} adopted (${d.target} v${d.version})`;
    case 'improvement.rolled_back':
      return `${d.id} rolled back: ${d.reason}`;
    case 'rework.opened':
      return `rework ${d.id || ''} opened: ${d.reason}`;
    case 'record.rollback_accepted':
      return 'a rolled-back event log was accepted as the record';
    default:
      return JSON.stringify(d).slice(0, 160);
  }
}

function preconditions(store) {
  const state = store.state();
  const problems = [];
  for (const id of state.gateOrder) {
    if (state.gates[id].status !== 'approved') problems.push(`gate ${id} is ${state.gates[id].status}`);
  }
  // An approved plan always has phases and tasks; none means nothing was implemented
  // (e.g. a plan submission interrupted before its import was approved by an older engine).
  if (!state.plan || !state.plan.phases.length) problems.push('the approved plan has no phases');
  if (!Object.keys(state.tasks).length) problems.push('the approved plan has no tasks');
  for (const t of Object.values(state.tasks)) if (t.status !== 'done') problems.push(`task ${t.id} is ${t.status}`);
  const audit = store.audit();
  if (!audit.ok) problems.push(...audit.errors.map((e) => `audit: ${e}`));
  for (const c of unreviewedChanges(state, store.root)) problems.push(`${c.path} ${c.problem} (${c.gate})`);
  for (const r of Object.values(state.runs)) if (r.status === 'running') problems.push(`run ${r.id} (${r.agent}) is still open`);
  return { state, problems, audit };
}

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function buildReport(state, audit, { metrics, events } = {}) {
  const lines = [];
  const p = state.project;
  lines.push(`# Final Handoff — ${p.name}`, '');
  lines.push(`**Idea:** ${p.idea}`, '');
  lines.push(`Generated by \`eccode deliver\` from the event-sourced project record (${audit.events} events, hash chain verified). Everything in the "Verified" sections below is backed by recorded evidence; anything else is listed under limitations.`, '');

  lines.push('## Gate approvals', '', '| Gate | Authors | Approved by | Review iterations | Approved at |', '|---|---|---|---|---|');
  for (const id of state.gateOrder) {
    const g = state.gates[id];
    lines.push(`| ${id} | ${g.authors.join(', ')} | ${g.approvedBy} | ${g.iterations} rejected before approval | ${g.approvedAt} |`);
  }

  const rejected = state.rejectedReviews;
  const allReviews = Object.values(state.reviews);
  const changeReqs = allReviews.filter((r) => r.decision === 'changes_requested');
  lines.push('', '## Review history', '');
  lines.push(`- Reviews recorded: ${allReviews.length} (${changeReqs.length} requested changes)`);
  lines.push(`- Reviews refused by gate rules (e.g. self-approval, missing evidence): ${rejected.length}`);
  const findings = changeReqs.flatMap((r) => r.findings.filter((f) => ['blocking', 'major'].includes(f.severity)).map((f) => ({ ...f, gate: r.gate })));
  if (findings.length) {
    lines.push('', '| Gate | Finding | Severity | Title |', '|---|---|---|---|');
    for (const f of findings) lines.push(`| ${f.gate} | ${f.id} | ${f.severity} | ${mdEscape(f.title)} |`);
  }

  if (Object.keys(state.tasks).length) {
    lines.push('', '## Tasks', '', '| Task | Phase | Owner | Attempts | Completed by |', '|---|---|---|---|---|');
    for (const t of Object.values(state.tasks)) lines.push(`| ${t.id} | ${t.phase} | ${t.owner} | ${t.attempts} | ${t.completedBy} |`);
  }

  const cmds = Object.values(state.evidence).filter((e) => e.kind === 'command');
  lines.push('', '## Verified by executed checks', '', '| Evidence | Label | Command | Exit | By | Purpose |', '|---|---|---|---|---|---|');
  for (const e of cmds) lines.push(`| ${e.id} | ${mdEscape(e.label)} | \`${mdEscape(e.command)}\` | ${e.exitCode} | ${e.recordedBy} | ${e.purpose} |`);

  const decisions = Object.values(state.decisions);
  if (decisions.length) {
    lines.push('', '## Decisions', '');
    for (const d of decisions) lines.push(`- **${d.title}** — ${d.decision}. _Rationale:_ ${d.rationale}${d.lessons && d.lessons.length ? ` _Lessons:_ ${d.lessons.join(', ')}` : ''}`);
  }
  if (state.citations.length) {
    lines.push('', '## Memory lessons that influenced work', '');
    for (const c of state.citations) lines.push(`- ${c.lesson} → ${c.context} (${c.by})`);
  }

  // Every action the engine reserves for the user, listed so a reader can check each one against
  // the conversation (or an operator note): the record shows what was entered, not who typed it.
  const userEvents = (events || []).filter((e) => e.actor === 'user');
  if (userEvents.length) {
    lines.push('', '## User decisions (recorded with `--actor user`)', '');
    lines.push("These events were entered on the user's behalf by whoever ran the CLI (the orchestrator, or an operator); the record shows what was entered and when, not that a person typed it.", '');
    for (const e of userEvents) lines.push(`- #${e.seq} ${e.ts} \`${e.type}\` ${mdEscape(userEventSummary(e))}`);
  }

  const risks = Object.values(state.risks);
  lines.push('', '## Risks', '');
  if (!risks.length) lines.push('- None recorded.');
  for (const r of risks) lines.push(`- **${r.id}** [${r.severity}, ${r.status}] ${r.title}${r.mitigation ? ` — mitigation: ${r.mitigation}` : ''}`);

  lines.push('', '## Cost and runtime (as reported to the record)', '');
  lines.push(`- Agent runs: ${Object.keys(state.runs).length}; runtime ${state.totals.runtimeMinutes} min; tokens ${state.totals.tokens}; cost $${state.totals.costUsd}`);
  const interrupted = Object.values(state.runs).filter((r) => r.status === 'interrupted');
  if (interrupted.length) lines.push(`- Interrupted runs recovered: ${interrupted.length}`);
  if (metrics) {
    lines.push('', '## Workflow metrics', '');
    for (const [k, v] of Object.entries(metrics)) lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }

  const failed = cmds.filter((e) => e.status === 'failed' && e.purpose !== 'reproduction');
  lines.push('', '## Limitations and unverified items', '');
  lines.push('- Agent identities in the record are asserted by the caller; the Claude Code guard hook binds them to the running subagent type where the harness reports it.');
  lines.push('- Cost figures are only as accurate as the usage reported when runs were closed.');
  if (failed.length) lines.push(`- Failed checks remain in the record (superseded by later passing runs): ${failed.map((e) => e.id).join(', ')}`);
  const openRisks = risks.filter((r) => r.status === 'open');
  if (openRisks.length) lines.push(`- Open risks carried forward: ${openRisks.map((r) => r.id).join(', ')}`);
  return lines.join('\n') + '\n';
}

function deliver(store, actor, { metrics } = {}) {
  if (actor !== 'delivery-lead' && actor !== 'orchestrator') {
    throw new EccodeError('ROLE_NOT_ALLOWED', 'Delivery is performed by delivery-lead or the orchestrator');
  }
  const { state, problems, audit } = preconditions(store);
  if (state.delivery && !pendingRedelivery(state)) throw new EccodeError('ALREADY_DELIVERED', `Already delivered at ${state.delivery.at}`);
  if (problems.length) {
    throw new EccodeError('DELIVERY_BLOCKED', `Delivery refused:\n- ${problems.join('\n- ')}`, { problems });
  }
  const report = buildReport(state, audit, { metrics, events: store.readEvents() });
  const n = nextDeliveryIndex(state);
  const suffix = n === 1 ? '' : `-${n}`;
  const rel = `.eccode/delivery/final-handoff${suffix}.md`;
  writeFileAtomic(path.join(store.root, rel), report);
  writeJson(path.join(store.root, `.eccode/delivery/final-handoff${suffix}.json`), {
    project: state.project,
    gates: state.gateOrder.map((id) => ({ id, approvedBy: state.gates[id].approvedBy, iterations: state.gates[id].iterations })),
    evidence: Object.values(state.evidence).map((e) => ({ id: e.id, label: e.label, status: e.status, exitCode: e.exitCode, recordedBy: e.recordedBy })),
    totals: state.totals,
    auditEvents: audit.events,
  });
  store.commit('delivery.completed', actor, { report: rel, summary: `${state.gateOrder.length} gates approved` });
  return { report: rel };
}

module.exports = { deliver, preconditions, unreviewedChanges, buildReport };
