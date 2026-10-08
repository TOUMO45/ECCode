'use strict';
// Status and "what happens next". Used by the CLI, the SessionStart hook
// (resume after interruption) and the orchestrator skill.

const { gateKind } = require('./reducer');
const { readyTasks, ownershipConflicts } = require('./tasks');
const { staleRuns } = require('./runs');
const { rolesFor } = require('./project');

function nextAction(state, config) {
  if (!state.project) return { action: 'init', detail: 'eccode init --name <name> --idea "<idea>"' };
  for (const gateId of state.gateOrder) {
    const g = state.gates[gateId];
    const roles = rolesFor(config, gateId);
    switch (g.status) {
      case 'approved':
        continue;
      case 'pending':
        return { action: 'start-gate', gate: gateId, detail: `eccode gate start ${gateId} --actor orchestrator, then dispatch ${gateKind(gateId) === 'phase' ? 'the task owners' : roles.authors.join('/')}` };
      case 'in_progress':
      case 'changes_requested': {
        if (gateKind(gateId) === 'phase') {
          const phase = gateId.slice(6);
          const tasks = Object.values(state.tasks).filter((t) => t.phase === phase);
          const escalated = tasks.filter((t) => t.status === 'escalated');
          if (escalated.length) {
            return { action: 'user-decision', gate: gateId, detail: `Tasks escalated: ${escalated.map((t) => `${t.id}: ${t.escalation && t.escalation.recovery}`).join(' | ')}` };
          }
          const claimed = tasks.filter((t) => t.status === 'claimed');
          const ready = readyTasks(state, config).filter((t) => t.phase === phase);
          if (tasks.every((t) => t.status === 'done')) {
            const respond = g.status === 'changes_requested' ? ` --responds-to ${g.reviews[g.reviews.length - 1]}` : '';
            return { action: 'submit-gate', gate: gateId, detail: `All tasks done: eccode gate submit ${gateId} --actor delivery-lead${respond}` };
          }
          if (ready.length || claimed.length) {
            return {
              action: 'dispatch-tasks',
              gate: gateId,
              ready: ready.map((t) => ({ id: t.id, owner: t.owner, title: t.title })),
              inProgress: claimed.map((t) => ({ id: t.id, agent: t.claim.agent })),
              detail: `Ready: ${ready.map((t) => `${t.id}→${t.owner}`).join(', ') || 'none'}; in progress: ${claimed.map((t) => t.id).join(', ') || 'none'}`,
            };
          }
          if (g.status === 'changes_requested') {
            return { action: 'rework', gate: gateId, detail: `Review requested changes: ${g.openFindings.map((f) => `${f.id} ${f.title}`).join('; ')}. Reset affected tasks (eccode task reset <id> --actor orchestrator --reason ...) and redispatch.` };
          }
          return { action: 'blocked', gate: gateId, detail: 'No task is ready; check dependencies with eccode task list' };
        }
        if (g.status === 'changes_requested') {
          return {
            action: 'revise',
            gate: gateId,
            detail: `Dispatch ${roles.authors.join('/')} to address ${g.openFindings.map((f) => f.id).join(', ')} and resubmit with --responds-to ${g.reviews[g.reviews.length - 1]}`,
          };
        }
        return { action: 'author', gate: gateId, detail: `Dispatch ${roles.authors.join('/')} to produce and submit the ${gateId} artifacts` };
      }
      case 'submitted':
        return { action: 'review', gate: gateId, detail: `Dispatch an independent reviewer (${roles.reviewers.join('/')}) for submission ${g.submissions[g.submissions.length - 1].id}` };
      case 'escalated':
        return { action: 'user-decision', gate: gateId, detail: g.escalation.recovery };
      default:
        return { action: 'unknown', gate: gateId, detail: g.status };
    }
  }
  if (!state.delivery) return { action: 'deliver', detail: 'All gates approved: eccode deliver --actor delivery-lead' };
  return { action: 'done', detail: `Delivered at ${state.delivery.at}: ${state.delivery.report}` };
}

function summary(state, config) {
  const gates = state.gateOrder.map((id) => {
    const g = state.gates[id];
    return { id, status: g.status, iterations: g.iterations, authors: g.authors, approvedBy: g.approvedBy, openFindings: g.openFindings.length };
  });
  const tasks = Object.values(state.tasks).map((t) => ({ id: t.id, phase: t.phase, owner: t.owner, status: t.status, attempts: t.attempts }));
  const openRisks = Object.values(state.risks).filter((r) => r.status === 'open');
  return {
    project: state.project,
    next: nextAction(state, config),
    gates,
    tasks,
    stale: staleRuns(state, config).map((r) => r.id),
    openRuns: Object.values(state.runs).filter((r) => r.status === 'running').map((r) => ({ id: r.id, agent: r.agent, task: r.task, startedAt: r.startedAt })),
    budget: {
      costUsd: state.totals.costUsd,
      maxCostUsd: config.limits.maxCostUsd,
      runtimeMinutes: state.totals.runtimeMinutes,
      maxRuntimeMinutes: config.limits.maxRuntimeMinutes,
      tokens: state.totals.tokens,
    },
    ownershipWarnings: ownershipConflicts(Object.values(state.tasks)),
    openRisks: openRisks.map((r) => ({ id: r.id, title: r.title, severity: r.severity })),
    rejectedReviews: state.rejectedReviews.length,
    delivered: Boolean(state.delivery),
    seq: state.seq,
  };
}

function formatBrief(sum) {
  if (!sum.project) return 'ECCode: no project initialized.';
  const lines = [];
  lines.push(`ECCode project "${sum.project.name}" (event #${sum.seq})`);
  lines.push('Gates: ' + sum.gates.map((g) => `${g.id}=${g.status}${g.iterations ? `(rev ${g.iterations})` : ''}`).join(' → '));
  if (sum.tasks.length) {
    const by = {};
    for (const t of sum.tasks) by[t.status] = (by[t.status] || 0) + 1;
    lines.push('Tasks: ' + Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', '));
  }
  if (sum.openRuns.length) {
    lines.push(`Open runs (possibly interrupted): ${sum.openRuns.map((r) => `${r.id}/${r.agent}${r.task ? `/${r.task}` : ''}`).join(', ')} — if this is a new session run: eccode recover --all --actor orchestrator`);
  }
  lines.push(`Budget: $${sum.budget.costUsd}/${sum.budget.maxCostUsd}, ${sum.budget.runtimeMinutes}/${sum.budget.maxRuntimeMinutes} min`);
  if (sum.openRisks.length) lines.push(`Open risks: ${sum.openRisks.map((r) => `${r.id}(${r.severity})`).join(', ')}`);
  lines.push(`NEXT: ${sum.next.action}${sum.next.gate ? ` [${sum.next.gate}]` : ''} — ${sum.next.detail}`);
  return lines.join('\n');
}

module.exports = { nextAction, summary, formatBrief };
