'use strict';
// Large-change planning (Phase 3, Part D): finish what you start. Interfaces
// are agreed before implementation (plan.contracts); every task is sized by a
// budget (at most maxFilesPerTask files or maxLinesPerTask changed lines, or
// an orchestrator's waiver); after every checkpointEvery completed tasks a
// checkpoint must pass before the next claim; a rescope cites the contract it
// changes, and a contract changed twice opens a blocking ambiguity.
const { EccodeError, newId } = require('./util');

function planConfig(config) {
  return { maxFilesPerTask: 3, maxLinesPerTask: 150, checkpointEvery: 3, ...(config.plan || {}) };
}

function assertActive(state) {
  if (!state.work) throw new EccodeError('NOT_INITIALIZED', 'No work item');
  if (state.work.status !== 'active') throw new EccodeError('INVALID_TRANSITION', `Work item ${state.work.id} is ${state.work.status}`);
}

function designers(config) {
  return [...new Set([...config.roles.design.authors, ...config.roles.plan.authors, ...config.roles.architecture.authors, 'orchestrator'])];
}

// --------------------------------------------------------- plan contracts

function validContracts(list) {
  const arr = Array.isArray(list) ? list : list && Array.isArray(list.contracts) ? list.contracts : null;
  if (!arr || !arr.length) throw new EccodeError('INVALID_INPUT', 'plan contracts are a non-empty list of {id, kind: interface|schema|api, text}');
  const ids = new Set();
  return arr.map((c, i) => {
    if (!c || typeof c !== 'object') throw new EccodeError('INVALID_INPUT', `contract ${i}: not an object`);
    const id = String(c.id || '').trim();
    if (!id) throw new EccodeError('INVALID_INPUT', `contract ${i}: id is required`);
    if (ids.has(id)) throw new EccodeError('INVALID_INPUT', `contract ${id} appears twice`);
    ids.add(id);
    if (!['interface', 'schema', 'api'].includes(c.kind)) throw new EccodeError('INVALID_INPUT', `contract ${id}: kind must be interface, schema or api`);
    if (typeof c.text !== 'string' || c.text.trim().length < 10) throw new EccodeError('INVALID_INPUT', `contract ${id}: text is required (>= 10 chars)`);
    return { id, kind: c.kind, text: c.text.trim() };
  });
}

/** The interfaces, schemas and API shapes agreed before implementation. Refused once a task is claimed. */
function contracts(store, config, actor, list) {
  if (!designers(config).includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', `${actor} may not declare plan contracts; authors: ${designers(config).join(', ')}`);
  const entries = validContracts(list);
  return store.commit('plan.contracts', actor, { id: newId('pc'), contracts: entries }, (state) => {
    assertActive(state);
    if (Object.values(state.tasks).some((t) => t.claim || t.status !== 'pending')) throw new EccodeError('CONTRACT_AFTER_WORK', 'Implementation has started; a contract change now is a reviewed rescope (eccode task rescope --contract <id>), not a new plan.contracts');
  }).event.data;
}

// ------------------------------------------------------------- task budget

/** The size of the delivered change for a task, from the lean stats and the changed files. */
function taskSize(task, handoff, changed) {
  // The task's OWN change: the files it declares (completion has checked these are inside its
  // ownership and that git shows them changed), not the whole working-tree diff, which may carry
  // other tasks' uncommitted work. Lines come from the lean stats, which are per task.
  const files = ((handoff && handoff.filesChanged) || changed || []).filter((f) => !String(f).startsWith('.eccode/'));
  const lean = task.lean || (handoff && handoff.lean) || null;
  const lines = lean ? (lean.linesAdded || 0) + (lean.linesRemoved || 0) : null;
  return { files: files.length, lines };
}

/** Over-budget problem at completion, unless the orchestrator waived this task. */
function budgetProblem(state, config, task, handoff, changed) {
  if (!state.work || ['quick'].includes(state.work.track)) return null;
  const cfg = planConfig(config);
  const waived = (state.planning && state.planning.budgetWaivers || []).some((w) => w.task === task.id);
  if (waived) return null;
  const size = taskSize(task, handoff, changed);
  if (size.files > cfg.maxFilesPerTask) return `task ${task.id} changes ${size.files} files, over the budget of ${cfg.maxFilesPerTask}. Split it into smaller tasks (eccode task rescope / a plan with more tasks), or the orchestrator waives it with a reason (eccode task waive-budget ${task.id} --reason "<why this task is one unit>")`;
  if (size.lines !== null && size.lines > cfg.maxLinesPerTask) return `task ${task.id} changes ${size.lines} lines, over the budget of ${cfg.maxLinesPerTask}. Split it, or the orchestrator waives it (eccode task waive-budget ${task.id} --reason ...)`;
  return null;
}

function waiveBudget(store, config, actor, { task, reason } = {}) {
  if (actor !== 'orchestrator' && actor !== 'user') throw new EccodeError('ROLE_NOT_ALLOWED', 'Only the orchestrator or the user waives a task budget');
  if (typeof reason !== 'string' || reason.trim().length < 15) throw new EccodeError('INVALID_INPUT', 'a budget waiver needs --reason (>= 15 chars): why this task is one indivisible unit');
  return store.commit('task.budget.waived', actor, { task: String(task || '').trim(), reason: reason.trim() }, (state) => {
    assertActive(state);
    if (!state.tasks[task]) throw new EccodeError('UNKNOWN_TASK', `Unknown task ${task}`);
  }).event.data;
}

// ------------------------------------------------------------- checkpoints

function doneCount(state) {
  return Object.values(state.tasks).filter((t) => t.status === 'done').length;
}

/** After every checkpointEvery completed tasks, a passing checkpoint is required before the next claim. */
function checkpointProblem(state, config) {
  if (!state.work || ['quick', 'debug'].includes(state.work.track) || !state.planning) return null;
  const cfg = planConfig(config);
  const done = doneCount(state);
  const total = Object.keys(state.tasks).length;
  if (done < cfg.checkpointEvery || done >= total) return null; // no checkpoint due before the first batch, or when every task is done
  const due = Math.floor(done / cfg.checkpointEvery) * cfg.checkpointEvery;
  const passed = (state.planning.checkpoints || []).filter((c) => c.passed);
  const last = passed.length ? passed[passed.length - 1].afterTasks : 0;
  if (last >= due) return null;
  return `an integration checkpoint is due: ${done} tasks are done and the last passing checkpoint was after ${last} (every ${cfg.checkpointEvery}). Record it before the next claim (eccode plan checkpoint --evidence ev:<id>,... --actor orchestrator): run the narrowed check set and cite the passing evidence`;
}

/** Record a checkpoint: the cited command evidence must have passed after the last checkpoint. */
function checkpoint(store, config, actor, { evidence } = {}) {
  if (actor !== 'orchestrator' && !config.roles.plan.authors.includes(actor)) throw new EccodeError('ROLE_NOT_ALLOWED', 'A checkpoint is recorded by the orchestrator or a plan author');
  const refs = (Array.isArray(evidence) ? evidence : String(evidence || '').split(',')).map((e) => String(e).trim().replace(/^ev:/, '')).filter(Boolean);
  if (!refs.length) throw new EccodeError('INVALID_INPUT', 'a checkpoint cites the passing checks it ran: --evidence ev:<id>,ev:<id>');
  return store.commit('plan.checkpoint', actor, { id: newId('cp'), evidence: refs }, (state) => {
    assertActive(state);
    const bad = refs.filter((id) => { const e = state.evidence[id]; return !e || e.kind !== 'command' || e.status !== 'passed'; });
    if (bad.length) throw new EccodeError('EVIDENCE_REQUIRED', `the checkpoint cites evidence that is not a passing command: ${bad.map((x) => `ev:${x}`).join(', ')}`);
    return { afterTasks: doneCount(state), passed: true };
  }).event.data;
}

// --------------------------------------------------------------- rescope

/** A rescope cites the contract it changes (when contracts exist); a contract changed twice opens a blocking ambiguity. */
function rescopeContractProblem(state, contract) {
  if (!state.planning || !state.planning.contracts.length) return null;
  const all = state.planning.contracts.flatMap((c) => c.contracts.map((x) => x.id));
  if (!contract) return `this plan declared contracts (${all.join(', ')}); a rescope cites the one it changes: eccode task rescope ... --contract <id>, or --contract none if it changes no contract`;
  if (contract === 'none') return null;
  if (!all.includes(contract)) return `unknown contract ${contract}; the plan's contracts are ${all.join(', ')}`;
  return null;
}

/** After a rescope that cited a contract, open a blocking ambiguity if that contract has now changed more than once. */
function noteContractRescope(store, config, actor, contract) {
  if (!contract || contract === 'none') return null;
  const state = store.state();
  const changes = Object.values(state.tasks).flatMap((t) => (t.history || []).filter((h) => h.event === 'rescoped' && h.contract === contract));
  if (changes.length < 2) return null;
  const qid = `contract-${contract}`;
  const already = (state.design && state.design.ambiguities || []).some((a) => a.questions.some((q) => q.id === qid));
  if (already) return null;
  return require('./design').ambiguity(store, config, actor === 'user' ? 'orchestrator' : actor, [{ id: qid, text: `Contract "${contract}" has been rescoped ${changes.length} times: the interface is not settled. Confirm the intended contract before more work.`, blocking: true }]);
}

// ----------------------------------------------------------------- output

function reportLines(state) {
  const p = state.planning;
  if (!p || (!p.contracts.length && !p.checkpoints.length)) return [];
  const lines = ['## Plan contracts and checkpoints', ''];
  for (const c of p.contracts) for (const x of c.contracts) lines.push(`- Contract ${x.id} (${x.kind}): ${x.text}`);
  for (const c of p.checkpoints) lines.push(`- Checkpoint ${c.id} after ${c.afterTasks} task(s): ${c.passed ? 'passed' : 'failed'} (ev:${c.evidence.join(', ev:')})`);
  for (const w of p.budgetWaivers) lines.push(`- Budget waiver on ${w.task} by ${w.by}: ${w.reason}`);
  lines.push('');
  return lines;
}

/** Planned vs delivered, for the handoff and the report. */
function progressLines(state) {
  const tasks = Object.values(state.tasks);
  if (!tasks.length) return [];
  const done = tasks.filter((t) => t.status === 'done');
  const rescopes = tasks.flatMap((t) => (t.history || []).filter((h) => h.event === 'rescoped').map((h) => `${t.id} (${h.reason})`));
  return [`Planned ${tasks.length} task(s), delivered ${done.length}.`, ...(rescopes.length ? [`Rescoped: ${rescopes.join('; ')}.`] : [])];
}

function show(state) {
  const p = state.planning || { contracts: [], checkpoints: [], budgetWaivers: [] };
  const out = [];
  for (const c of p.contracts) out.push(`Contracts ${c.id}: ${c.contracts.map((x) => `${x.id} (${x.kind})`).join(', ')}`);
  for (const c of p.checkpoints) out.push(`Checkpoint ${c.id} after ${c.afterTasks}: ${c.passed ? 'passed' : 'failed'}`);
  for (const w of p.budgetWaivers) out.push(`Budget waiver ${w.task}: ${w.reason}`);
  return out.join('\n') || 'No plan contract or checkpoint recorded.';
}

module.exports = { planConfig, contracts, validContracts, taskSize, budgetProblem, waiveBudget, checkpoint, checkpointProblem, rescopeContractProblem, noteContractRescope, reportLines, progressLines, show };
