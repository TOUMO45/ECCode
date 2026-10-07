'use strict';
// Phased tasks with explicit ownership. Conflicting edits are prevented by
// file-ownership globs: two tasks whose globs may overlap can never be
// claimed at the same time, and completion is refused if the handoff reports
// changes outside the task's globs.

const { EccodeError, newId, globsOverlap, matchesAny, writeJson } = require('./util');
const { validateNamed } = require('./schema');
const { assertBudget, gitHead, gitChangedFiles, projectRelative } = require('./project');
const { resolveRef } = require('./evidence');

// Scratch area every task may use. Records, artifacts of other gates and
// reviews under .eccode/ are never part of a task's ownership.
const ALWAYS_ALLOWED = ['.eccode/drafts/**'];

/** Structural + semantic plan validation. Returns error strings. */
function validatePlan(plan, config) {
  const errors = validateNamed('plan', plan);
  if (errors.length) return errors;
  const phaseIds = plan.phases.map((p) => p.id);
  const phaseIndex = new Map(phaseIds.map((id, i) => [id, i]));
  if (new Set(phaseIds).size !== phaseIds.length) errors.push('phase ids must be unique');
  const ids = new Set();
  const byId = new Map();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`);
    ids.add(t.id);
    byId.set(t.id, t);
  }
  const knownRoles = new Set(Object.values(config.roles).flatMap((r) => [...r.authors, ...r.reviewers]));
  for (const t of plan.tasks) {
    if (!phaseIndex.has(t.phase)) errors.push(`task ${t.id}: unknown phase ${t.phase}`);
    if (!knownRoles.has(t.owner)) errors.push(`task ${t.id}: owner ${t.owner} is not a configured role`);
    for (const dep of t.dependencies) {
      const d = byId.get(dep);
      if (!d) errors.push(`task ${t.id}: unknown dependency ${dep}`);
      else if (phaseIndex.get(d.phase) > phaseIndex.get(t.phase)) {
        errors.push(`task ${t.id}: depends on ${dep} from a later phase`);
      }
    }
  }
  for (const p of plan.phases) {
    if (!plan.tasks.some((t) => t.phase === p.id)) errors.push(`phase ${p.id} has no tasks`);
  }
  // Cycle detection (DFS).
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'active') {
      errors.push(`dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'active');
    for (const dep of (byId.get(id) || { dependencies: [] }).dependencies) if (byId.has(dep)) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const t of plan.tasks) visit(t.id, []);
  return errors;
}

/** Pairs of tasks in the same phase that could run in parallel but share files. */
function ownershipConflicts(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, new Set(t.dependencies)]));
  const reaches = (a, b, seen = new Set()) => {
    if (seen.has(a)) return false;
    seen.add(a);
    for (const d of deps.get(a) || []) if (d === b || reaches(d, b, seen)) return true;
    return false;
  };
  const out = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (a.phase !== b.phase || reaches(a.id, b.id) || reaches(b.id, a.id)) continue;
      if (globsOverlap(a.files, b.files)) out.push([a.id, b.id]);
    }
  }
  return out;
}

function phaseGateOf(task) {
  return `phase:${task.phase}`;
}

function readyTasks(state, config) {
  const claimed = Object.values(state.tasks).filter((t) => t.status === 'claimed');
  return Object.values(state.tasks).filter((t) => {
    if (t.status !== 'pending') return false;
    const gate = state.gates[phaseGateOf(t)];
    if (!gate || !['in_progress', 'changes_requested'].includes(gate.status)) return false;
    if (!t.dependencies.every((d) => state.tasks[d] && state.tasks[d].status === 'done')) return false;
    if (claimed.some((c) => globsOverlap(c.files, t.files))) return false;
    return claimed.length < config.limits.maxConcurrency;
  });
}

function maxAttempts(config) {
  return 1 + config.limits.maxTaskRetries;
}

function claim(store, config, taskId, actor, { runId } = {}) {
  return store.commit('task.claimed', actor, { task: taskId, runId: runId || null }, (state) => {
    const t = state.tasks[taskId];
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (state.gates.plan.status !== 'approved') throw new EccodeError('GATE_BLOCKED', 'The plan gate must be approved before tasks are claimed');
    const gate = state.gates[phaseGateOf(t)];
    if (!['in_progress', 'changes_requested'].includes(gate.status)) {
      throw new EccodeError('GATE_BLOCKED', `Phase gate ${gate.id} is ${gate.status}; start it first (eccode gate start ${gate.id})`);
    }
    if (t.owner !== actor) throw new EccodeError('OWNERSHIP', `Task ${taskId} is owned by ${t.owner}, not ${actor}`);
    if (t.status !== 'pending') throw new EccodeError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}`);
    const blocked = t.dependencies.filter((d) => state.tasks[d].status !== 'done');
    if (blocked.length) throw new EccodeError('DEPENDENCY_PENDING', `Task ${taskId} waits on: ${blocked.join(', ')}`);
    if (t.attempts >= maxAttempts(config)) throw new EccodeError('RETRY_LIMIT', `Task ${taskId} has used all ${maxAttempts(config)} attempts`);
    const active = Object.values(state.tasks).filter((x) => x.status === 'claimed');
    if (active.length >= config.limits.maxConcurrency) {
      throw new EccodeError('CONCURRENCY_LIMIT', `maxConcurrency=${config.limits.maxConcurrency} reached (active: ${active.map((x) => x.id).join(', ')})`);
    }
    const conflict = active.find((x) => globsOverlap(x.files, t.files));
    if (conflict) {
      throw new EccodeError('OWNERSHIP_CONFLICT', `Task ${taskId} files overlap with active task ${conflict.id} (claimed by ${conflict.claim.agent}); wait or re-plan ownership`);
    }
    assertBudget(state, config);
    return { baseCommit: gitHead(store.root) };
  });
}

function validateHandoff(state, root, handoff) {
  const errors = validateNamed('handoff', handoff);
  if (errors.length) return errors;
  for (const ref of handoff.evidence) {
    const res = resolveRef(state, root, ref);
    if (!res.ok) errors.push(`evidence ${res.reason}`);
  }
  return errors;
}

function recordHandoff(store, actor, handoff) {
  const id = newId('ho');
  store.commit('handoff.recorded', actor, { id, handoff }, (state) => {
    const errors = validateHandoff(state, store.root, handoff);
    if (handoff.from !== actor) errors.push(`handoff.from (${handoff.from}) must match the acting agent (${actor})`);
    if (errors.length) throw new EccodeError('INVALID_HANDOFF', `Handoff rejected:\n- ${errors.join('\n- ')}`, { errors });
  });
  writeJson(store.path('handoffs', `${id}.json`), handoff);
  return id;
}

/**
 * Complete a claimed task with a validated handoff. Requires a passing check
 * recorded after the claim, and changed files inside the task's ownership.
 */
function complete(store, config, taskId, actor, handoff) {
  const handoffId = newId('ho');
  const res = store.commit('task.completed', actor, { task: taskId, handoffId }, (state) => {
    const t = state.tasks[taskId];
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (t.status !== 'claimed' || t.claim.agent !== actor) {
      throw new EccodeError('OWNERSHIP', `Task ${taskId} is not claimed by ${actor} (status ${t.status})`);
    }
    const errors = validateHandoff(state, store.root, handoff);
    if (handoff.task !== taskId) errors.push(`handoff.task must be ${taskId}`);
    if (handoff.from !== actor) errors.push(`handoff.from must be ${actor}`);
    const checks = handoff.evidence
      .map((r) => state.evidence[r.slice(3)])
      .filter((e) => e && e.kind === 'command' && e.status === 'passed' && e.at >= t.claim.at);
    if (!checks.length) errors.push('handoff must cite at least one passing check (ev:<id>) executed after the task was claimed');
    const changed = (handoff.filesChanged || []).map((f) => projectRelative(store.root, f));
    const outside = changed.filter((f) => !matchesAny(f, [...t.files, ...ALWAYS_ALLOWED]));
    if (outside.length) errors.push(`files outside task ownership (${t.files.join(', ')}): ${outside.join(', ')}`);
    const actual = gitChangedFiles(store.root, t.claim.baseCommit);
    if (actual) {
      const missing = changed.filter((f) => !actual.includes(f));
      if (missing.length) errors.push(`handoff lists files that git shows as unchanged since claim: ${missing.join(', ')}`);
    }
    if (errors.length) throw new EccodeError('INVALID_HANDOFF', `Task completion rejected:\n- ${errors.join('\n- ')}`, { errors });
    return { filesChanged: changed };
  });
  store.commit('handoff.recorded', actor, { id: handoffId, handoff });
  writeJson(store.path('handoffs', `${handoffId}.json`), handoff);
  return res;
}

function fail(store, config, taskId, actor, reason, { interrupted = false } = {}) {
  return store.commit('task.failed', actor, { task: taskId, reason, interrupted }, (state) => {
    const t = state.tasks[taskId];
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (t.status !== 'claimed') throw new EccodeError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}, not claimed`);
    if (!interrupted && actor !== t.claim.agent && actor !== 'orchestrator') {
      throw new EccodeError('OWNERSHIP', `Only ${t.claim.agent} or the orchestrator can fail task ${taskId}`);
    }
    if (!reason) throw new EccodeError('INVALID_INPUT', 'A failure reason is required');
    if (t.attempts >= maxAttempts(config)) {
      return {
        escalated: true,
        recovery: `Task ${taskId} failed ${t.attempts} time(s). Ask the user to choose: re-scope the task, assign a different owner, or open a learning-debugger investigation; then eccode task reset ${taskId} --actor user --reason "<decision>".`,
      };
    }
    return { escalated: false };
  });
}

/**
 * Return a task to pending: rework after a review finding (orchestrator or
 * delivery-lead, from done) or after escalation (user only).
 */
function reset(store, taskId, actor, reason) {
  return store.commit('task.reset', actor, { task: taskId, reason }, (state) => {
    const t = state.tasks[taskId];
    if (!t) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${taskId}`);
    if (!reason) throw new EccodeError('INVALID_INPUT', 'A reason is required');
    if (t.status === 'escalated' && actor !== 'user') throw new EccodeError('USER_AUTH_REQUIRED', 'Only the user may reset an escalated task');
    if (t.status === 'done' && !['orchestrator', 'delivery-lead', 'user'].includes(actor)) {
      throw new EccodeError('ROLE_NOT_ALLOWED', 'Rework of a completed task is scheduled by the orchestrator or delivery-lead');
    }
    if (!['done', 'escalated'].includes(t.status)) throw new EccodeError('INVALID_TRANSITION', `Task ${taskId} is ${t.status}`);
  });
}

module.exports = { validatePlan, ownershipConflicts, readyTasks, claim, complete, fail, reset, recordHandoff, validateHandoff, maxAttempts };
