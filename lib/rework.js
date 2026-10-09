'use strict';
// Rework: a defect found after a phase was approved (or after delivery).
//
// Approved gates are never reopened silently and approved files stay pinned.
// Instead the orchestrator (or the user) opens a REWORK: a new phase gate
// `phase:rework-N` with one scoped task, which goes through the normal
// claim -> handoff -> independent review path, and then a re-delivery. This
// closes the "no hotfix path" gap without weakening any rule: the fix is
// reviewed by someone other than its author, its file scope is bounded, the
// number of reworks is limited, and only the orchestrator or the user may open one.

const { EccodeError, matchesAny, globstarCount } = require('./util');
const { resolveRef } = require('./evidence');
const { assertBudget } = require('./project');

// Patterns that would make "scoped" meaningless.
const WHOLE_TREE = /^(\.\/)?(\*\*?(\/\*\*?)*|\*\*\/\*|\*)$/;

function validateScope(files) {
  if (!Array.isArray(files) || !files.length) throw new EccodeError('INVALID_INPUT', 'A rework needs at least one --files glob (the files it may change)');
  for (const g of files) {
    if (typeof g !== 'string' || !g.trim()) throw new EccodeError('INVALID_INPUT', 'Every --files glob must be a non-empty string');
    if (WHOLE_TREE.test(g.trim())) throw new EccodeError('INVALID_INPUT', `Glob ${g} would cover the whole tree; scope the rework to the files it needs`);
    if (globstarCount(g) > 3) throw new EccodeError('INVALID_INPUT', `Glob ${g} has more than three ** segments; matching it is exponential`);
  }
  if (matchesAny('.eccode/config.json', files) || matchesAny('.eccode/events.jsonl', files) || matchesAny('.eccode/state.json', files) || matchesAny('.eccode/artifacts/brief.md', files)) {
    throw new EccodeError('INVALID_INPUT', 'A rework may not reach into the project record or its artifacts (.eccode/); only .eccode/drafts/ is always writable');
  }
  if (matchesAny('.claude/settings.json', files) || matchesAny('.git/HEAD', files)) {
    throw new EccodeError('INVALID_INPUT', 'A rework may not reach into .claude/ (hooks, settings, the installed engine) or .git/');
  }
}

/** Reworks opened after a delivery that no later delivery has covered yet. */
function pendingRedelivery(state) {
  return Boolean(state.delivery) && (state.reworks || []).some((r) => r.afterDelivery && !r.deliveredAt);
}

/** Index of the next final-handoff report (1 for the first delivery). */
function nextDeliveryIndex(state) {
  const covered = new Set((state.reworks || []).filter((r) => r.afterDelivery && r.deliveredAt).map((r) => r.deliveredAt));
  return (state.delivery ? 1 : 0) + covered.size + 1;
}

function openRework(store, config, actor, { reason, files, owner, evidence = [], title } = {}) {
  if (actor !== 'orchestrator' && actor !== 'user') {
    throw new EccodeError('ROLE_NOT_ALLOWED', 'Only the orchestrator or the user may open a rework; agents report defects to the orchestrator');
  }
  if (!reason || String(reason).trim().length < 8) throw new EccodeError('INVALID_INPUT', 'A rework needs a --reason of at least 8 characters: what is wrong and how it was found');
  validateScope(files);
  const implementers = config.roles.phase.authors;
  if (!implementers.includes(owner)) throw new EccodeError('INVALID_INPUT', `--owner must be one of: ${implementers.join(', ')}`);
  const refs = [].concat(evidence || []);
  const { event } = store.commit('rework.opened', actor, { reason: String(reason).trim(), files, owner, evidence: refs, title: title || null }, (state) => {
    if (!state.gates.plan || state.gates.plan.status !== 'approved') throw new EccodeError('GATE_BLOCKED', 'A rework needs an approved plan: use the normal gates until then');
    for (const ref of refs) {
      const res = resolveRef(state, store.root, ref);
      if (!res.ok) throw new EccodeError('INVALID_EVIDENCE', `rework evidence ${res.reason}`);
    }
    const open = (state.reworks || []).find((r) => state.gates[r.gate] && state.gates[r.gate].status !== 'approved');
    if (open) throw new EccodeError('INVALID_TRANSITION', `Rework ${open.id} is still open (${state.gates[open.gate].status}); finish it first`);
    const tailApproved = state.gateOrder.filter((id) => id === 'verification' && state.gates[id].status === 'approved');
    if (tailApproved.length) {
      throw new EccodeError(actor === 'user' ? 'INVALID_TRANSITION' : 'USER_AUTH_REQUIRED', 'The verification gate is approved and would be invalidated by a rework: the user must reopen it first (eccode gate reopen verification --actor user --resolution "<why>")');
    }
    const limit = config.limits.maxReworks;
    const used = (state.reworks || []).length;
    if (actor !== 'user' && used >= limit) {
      throw new EccodeError('REWORK_LIMIT', `${used} rework(s) already opened (limits.maxReworks=${limit}). Repeated defects after review point at the plan or the tests; ask the user to authorize another rework or to change the approach.`);
    }
    assertBudget(state, config);
    const id = `rework-${used + 1}`;
    if (Object.prototype.hasOwnProperty.call(state.tasks, id) || Object.prototype.hasOwnProperty.call(state.gates, `phase:${id}`)) {
      throw new EccodeError('INVALID_INPUT', `${id} already exists as a plan task or phase; rework-N ids are reserved for the engine (plan validation refuses them)`);
    }
    return { id, gate: `phase:${id}`, task: id };
  });
  return { id: event.data.id, gate: event.data.gate, task: event.data.task, event };
}

/**
 * Widen an open rework's file scope after its review showed the defect reaches
 * further (the same bug in another file). Orchestrator or user only, while the
 * rework's gate is still open and its task is not claimed; the added globs are
 * validated like the original scope and may not overlap a task at work.
 */
function extendRework(store, config, actor, { id, files, reason } = {}) {
  if (actor !== 'orchestrator' && actor !== 'user') throw new EccodeError('ROLE_NOT_ALLOWED', 'Only the orchestrator or the user may extend a rework');
  if (!reason || String(reason).trim().length < 8) throw new EccodeError('INVALID_INPUT', 'Extending a rework needs a --reason (the finding that showed the scope was too narrow)');
  validateScope(files);
  return store.commit('rework.extended', actor, { id, files, reason: String(reason).trim() }, (state) => {
    const rw = (state.reworks || []).find((r) => r.id === id);
    if (!rw) throw new EccodeError('UNKNOWN_TASK', `No rework ${id}`);
    const g = state.gates[rw.gate];
    if (!g || !['in_progress', 'changes_requested'].includes(g.status)) throw new EccodeError('INVALID_TRANSITION', `Rework ${id} is ${g ? g.status : 'missing'}; only an open rework can be extended`);
    const t = state.tasks[id];
    if (!t || t.status !== 'pending') {
      throw new EccodeError('INVALID_TRANSITION', `Task ${id} is ${t ? t.status : 'missing'}; extend the scope while it is pending (after "eccode task reset ${id}" when it was completed)`);
    }
    const { globsOverlap } = require('./util');
    const active = Object.values(state.tasks).filter((x) => x.status === 'claimed');
    const conflict = active.find((x) => globsOverlap(x.files, files));
    if (conflict) throw new EccodeError('OWNERSHIP_CONFLICT', `The added files overlap active task ${conflict.id}`);
    assertBudget(state, config);
  });
}

module.exports = { openRework, extendRework, pendingRedelivery, nextDeliveryIndex };
