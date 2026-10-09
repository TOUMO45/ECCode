'use strict';
// Phased tasks with explicit ownership. Conflicting edits are prevented by
// file-ownership globs: two tasks whose globs may overlap can never be
// claimed at the same time, and completion is refused if the handoff reports
// changes outside the task's globs.

const { EccodeError, newId, globsOverlap, matchesAny, writeJson, globToRegExp } = require('./util');
const { validateNamed } = require('./schema');
const { assertBudget, gitHead, gitChangedFiles, projectRelative } = require('./project');
const { resolveRef } = require('./evidence');

// Scratch area every task may use. Records, artifacts of other gates and
// reviews under .eccode/ are never part of a task's ownership.
const ALWAYS_ALLOWED = ['.eccode/drafts/**'];
const HOTFIX_ACTORS = ['orchestrator', 'delivery-lead', 'user'];

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
    for (const g of t.files) if (touchesRecord(g)) errors.push(`task ${t.id}: ownership glob ${g} would cover the ECCode record (events, state, config, evidence, reviews, memory); tasks own project files and artifacts only`);
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

// Representative record paths: a glob that could match any of them would let
// a task rewrite the record itself. Artifacts are not listed: a task may own
// the artifact it produces (e.g. the verification report), and approved
// artifacts are protected by their recorded hashes, not by ownership.
const RECORD_SENTINELS = ['.eccode/events.jsonl', '.eccode/state.json', '.eccode/config.json', '.eccode/reviews/r.json', '.eccode/evidence/e.log', '.eccode/handoffs/h.json', '.eccode/memory/records/m.json', '.eccode/improvements/i/proposal.json', '.eccode/delivery/final-handoff.md'];

/** True when an ownership glob could match the ECCode record (events, state, config, evidence, reviews, memory). */
function touchesRecord(glob) {
  const g = String(glob).replace(/^\.\//, '');
  if (g.startsWith('.eccode/drafts/') || g.startsWith('.eccode/artifacts/')) return false;
  const re = globToRegExp(g);
  return RECORD_SENTINELS.some((p) => re.test(p));
}

/**
 * Add a hotfix task for files that an already-approved gate covers. The task
 * is placed in a hotfix phase gate inserted right after the last approved
 * gate, so the fix goes through claim → handoff → independent phase review,
 * and the re-approved hashes supersede the earlier approval at delivery.
 * Refused once verification is approved: a verified build is not patched.
 */
function addHotfix(store, config, actor, { task, of, reason, phase: phaseId } = {}) {
  if (!HOTFIX_ACTORS.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `Hotfix tasks are scheduled by ${HOTFIX_ACTORS.join(', ')}, not ${actor}`);
  if (!reason || reason.trim().length < 10) throw new EccodeError('INVALID_INPUT', 'A hotfix needs --reason (>= 10 chars): the finding, risk or defect it fixes');
  if (!task || typeof task !== 'object') throw new EccodeError('INVALID_INPUT', 'A hotfix needs a task definition (--file <task.json>, see templates/hotfix.json)');
  return store.commit('task.hotfix_added', actor, { reason }, (state) => {
    if (!state.plan || state.gates.plan.status !== 'approved') throw new EccodeError('GATE_BLOCKED', 'Hotfixes need an approved plan; before that, revise the plan instead');
    if (state.delivery) throw new EccodeError('ALREADY_DELIVERED', `Already delivered at ${state.delivery.at}; start a new delivery for post-release fixes`);
    if (state.gates.verification.status === 'approved') {
      throw new EccodeError('INVALID_TRANSITION', 'Verification is already approved; a hotfix now would invalidate it. Deliver as verified, or ask the user how to proceed');
    }
    const target = state.gates[of];
    if (!of || !target || !state.gateOrder.includes(of)) throw new EccodeError('UNKNOWN_GATE', `--for must name a gate (${state.gateOrder.join(', ')})`);
    if (target.status !== 'approved') throw new EccodeError('INVALID_TRANSITION', `Gate ${of} is ${target.status}; hotfixes are for approved gates. Use the normal rework path (task reset / resubmit) instead`);

    // Reuse an open hotfix phase when asked, otherwise open a new one.
    const hotfixPhases = state.plan.phases.filter((p) => /^hotfix-\d+$/.test(p.id));
    let phase;
    if (phaseId) {
      phase = hotfixPhases.find((p) => p.id === phaseId);
      if (!phase) throw new EccodeError('UNKNOWN_GATE', `No hotfix phase ${phaseId} (existing: ${hotfixPhases.map((p) => p.id).join(', ') || 'none'})`);
      const g = state.gates[`phase:${phaseId}`];
      if (!['pending', 'in_progress', 'changes_requested'].includes(g.status)) throw new EccodeError('INVALID_TRANSITION', `Hotfix phase ${phaseId} is ${g.status}; open a new one`);
    } else {
      const n = hotfixPhases.length + 1;
      phase = { id: `hotfix-${n}`, name: `Hotfix ${n}`, goal: `Hotfix of ${of}: ${reason}`, acceptanceCriteria: task.acceptanceCriteria || [] };
    }
    const planTask = { dependencies: [], inputs: [], outputs: [`hotfix of ${of}`], ...task, phase: phase.id };
    delete planTask.hotfix;
    const full = { ...planTask, hotfix: { of, reason } };
    const errors = validateNamed('plan', { phases: [phase], tasks: [planTask] }).map((e) => e.replace(/^\$\.tasks\[0\]/, 'task').replace(/^\$\.phases\[0\]/, 'phase'));
    if (state.tasks[full.id]) errors.push(`task id ${full.id} already exists`);
    const owners = config.roles.phase.authors;
    if (!owners.includes(full.owner)) errors.push(`owner ${full.owner} is not a phase author (${owners.join(', ')})`);
    for (const dep of full.dependencies) if (!state.tasks[dep] || state.tasks[dep].status !== 'done') errors.push(`dependency ${dep} must be an existing, completed task`);
    for (const g of full.files || []) if (touchesRecord(g)) errors.push(`ownership glob ${g} would cover the ECCode record; hotfixes change project files only`);
    const active = Object.values(state.tasks).filter((t) => t.status === 'claimed');
    const conflict = active.find((t) => globsOverlap(t.files, full.files || []));
    if (conflict) errors.push(`files overlap with active task ${conflict.id} (claimed by ${conflict.claim.agent}); wait for it to finish`);
    if (errors.length) throw new EccodeError('INVALID_INPUT', `Hotfix rejected:\n- ${errors.join('\n- ')}`, { errors });

    // Insert after the last approved gate (always before verification, which is not approved here).
    let after = 'plan';
    for (const id of state.gateOrder) if (state.gates[id].status === 'approved') after = id;
    assertBudget(state, config);
    return { task: full, phase, of, after, gate: `phase:${phase.id}` };
  });
}

module.exports = { validatePlan, ownershipConflicts, readyTasks, claim, complete, fail, reset, recordHandoff, validateHandoff, maxAttempts, addHotfix, touchesRecord };
