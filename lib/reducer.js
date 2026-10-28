'use strict';
// Pure state reducer: (state, event) -> state. All validation happens before
// an event is committed (see lib/engine.js), so reduce() never rejects; it
// only records. Keeping it pure is what makes replay/resume deterministic.

const FIXED_HEAD = ['architecture', 'design', 'plan'];
const FIXED_TAIL = ['verification'];

// Work items: one record carries many deliveries over a project's life. Each
// work item picks a track, and the track decides how much process the change
// gets. Every track has implementation phases; what varies is the document
// gates in front, the gates behind (verification, except on the debug track)
// and the extra evidence rules (fix: reproduce-then-pass; refactor: same
// behavior check green before and after; quick and debug: an auto-imported
// one-task plan; debug: a proven fix verification and a mutation run, checked
// when its one phase is submitted).
const TRACKS = {
  greenfield: { head: FIXED_HEAD, tail: FIXED_TAIL },
  feature: { head: ['design', 'plan'], tail: FIXED_TAIL },
  refactor: { head: ['plan'], tail: FIXED_TAIL },
  fix: { head: ['plan'], tail: FIXED_TAIL },
  quick: { head: [], tail: FIXED_TAIL },
  debug: { head: [], tail: [] },
};

/** The gates of a track, in order, around its phase gates. */
function gateOrderFor(track, phaseGates = []) {
  const t = TRACKS[track] || TRACKS.greenfield;
  return [...t.head, ...phaseGates, ...t.tail];
}

// Bumped when reducing an EXISTING event type changes shape, so an older
// snapshot is treated as a stale cache (rebuilt from the log), never as
// tampering.
const STATE_VERSION = 5;

/** The Debugging Lab of one work item (Phase 2): repro, hypotheses, evidence, localization, root cause. */
function emptyLab() {
  return { repro: null, repros: [], hypotheses: {}, evidence: {}, localizations: [], rootCause: null, escalations: [] };
}

/** The behavior diff of one work item (Phase 2): contract, routing, results, amendments, waivers. */
function emptyBehavior() {
  return { contracts: [], amendments: [], routing: null, routings: [], results: [], waivers: [] };
}

function newWork(id, d, ts) {
  return {
    id,
    track: TRACKS[d.track] ? d.track : 'greenfield',
    title: d.title || d.name,
    startedAt: ts,
    status: 'active',
    baseCommit: d.baseCommit || null,
    dirtyAtInit: d.dirtyAtInit || {},
    behaviorCommand: d.behavior || null,
    delivery: null,
  };
}

function initialState() {
  return {
    stateVersion: STATE_VERSION,
    seq: 0,
    lastHash: null,
    project: null,
    work: null,
    pastWorks: {},
    gateOrder: [...FIXED_HEAD, ...FIXED_TAIL],
    gates: {},
    plan: null,
    tasks: {},
    evidence: {},
    reviews: {},
    rejectedReviews: [],
    handoffs: {},
    runs: {},
    risks: {},
    decisions: {},
    citations: [],
    lessons: [],
    totals: { costUsd: 0, runtimeMinutes: 0, tokens: 0 },
    delivery: null,
    lab: emptyLab(),
    behavior: emptyBehavior(),
  };
}

function gateKind(gateId) {
  return gateId.startsWith('phase:') ? 'phase' : gateId;
}

function newGate(id) {
  return {
    id,
    kind: gateKind(id),
    status: 'pending',
    iterations: 0,
    authors: [],
    submissions: [],
    reviews: [],
    openFindings: [],
    approvedBy: null,
    approvedSubmission: null,
    escalation: null,
    startedAt: null,
    approvedAt: null,
  };
}

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

function ensureGate(s, id) {
  if (!s.gates[id]) s.gates[id] = newGate(id);
  return s.gates[id];
}

function reduce(prev, ev) {
  const s = clone(prev);
  s.seq = ev.seq;
  s.lastHash = ev.hash;
  const d = ev.data || {};

  switch (ev.type) {
    case 'project.initialized': {
      s.project = { name: d.name, idea: d.idea, createdAt: ev.ts, ...(d.baseCommit ? { baseCommit: d.baseCommit, dirtyAtInit: d.dirtyAtInit || {} } : {}) };
      s.work = newWork('w1', d, ev.ts);
      s.gateOrder = gateOrderFor(s.work.track);
      s.gates = {};
      for (const id of s.gateOrder) ensureGate(s, id);
      break;
    }

    case 'work.started': {
      // Archive the finished work item and open a fresh cycle on its track.
      if (s.work) s.pastWorks[s.work.id] = { work: s.work, gateOrder: s.gateOrder, gates: s.gates, plan: s.plan, tasks: s.tasks, lab: s.lab, behavior: s.behavior };
      s.work = newWork(d.id, d, ev.ts);
      s.gateOrder = gateOrderFor(s.work.track);
      s.gates = {};
      for (const id of s.gateOrder) ensureGate(s, id);
      s.plan = null;
      s.tasks = {};
      s.delivery = null;
      s.lab = emptyLab();
      s.behavior = emptyBehavior();
      break;
    }

    case 'work.abandoned': {
      s.work.status = 'abandoned';
      s.work.abandoned = { at: ev.ts, by: ev.actor, reason: d.reason };
      break;
    }

    case 'gate.started': {
      const g = ensureGate(s, d.gate);
      g.status = 'in_progress';
      g.startedAt = g.startedAt || ev.ts;
      if (d.reviewers) g.reviewers = d.reviewers;
      break;
    }

    case 'gate.submitted': {
      const g = ensureGate(s, d.gate);
      g.status = 'submitted';
      if (!g.authors.includes(ev.actor)) g.authors.push(ev.actor);
      g.submissions.push({
        id: d.submissionId,
        actor: ev.actor,
        at: ev.ts,
        artifacts: d.artifacts,
        respondsTo: d.respondsTo || null,
        notes: d.notes || null,
      });
      break;
    }

    case 'review.recorded': {
      const g = ensureGate(s, d.gate);
      const review = { ...d.review, id: d.reviewId, gate: d.gate, reviewer: ev.actor, at: ev.ts, submissionId: d.submissionId };
      s.reviews[d.reviewId] = review;
      g.reviews.push(d.reviewId);
      // Findings resolved by this review leave the open list; new blocking or
      // major ones join it.
      const resolved = new Set((review.resolvedFindings || []).map((r) => r.id));
      g.openFindings = g.openFindings.filter((f) => !resolved.has(f.id));
      for (const f of review.findings || []) {
        if (['blocking', 'major'].includes(f.severity) && f.status !== 'resolved') {
          g.openFindings.push({ ...f, reviewId: d.reviewId });
        }
      }
      // A gate whose reviewers were named waits for each to approve this submission.
      const awaiting = (g.reviewers || []).filter((r) => !g.reviews.some((id) => s.reviews[id].reviewer === r && s.reviews[id].submissionId === d.submissionId && s.reviews[id].decision === 'approve'));
      if (review.decision === 'approve' && awaiting.length) {
        g.status = 'submitted';
      } else if (review.decision === 'approve') {
        g.status = 'approved';
        g.approvedBy = ev.actor;
        g.approvedSubmission = d.submissionId;
        g.approvedAt = ev.ts;
      } else {
        g.status = 'changes_requested';
        g.iterations += 1;
      }
      break;
    }

    case 'review.rejected':
      s.rejectedReviews.push({ gate: d.gate, reviewer: ev.actor, at: ev.ts, reasons: d.reasons, decision: d.decision });
      break;

    case 'gate.escalated': {
      const g = ensureGate(s, d.gate);
      g.status = 'escalated';
      g.escalation = { at: ev.ts, reason: d.reason, unresolved: d.unresolved, recovery: d.recovery };
      break;
    }

    case 'gate.reopened': {
      const g = ensureGate(s, d.gate);
      g.status = 'in_progress';
      g.iterations = 0;
      // The user's decision settles the escalated findings: they are waived
      // (kept for the record) rather than silently dropped.
      g.waivedFindings = [...(g.waivedFindings || []), ...g.openFindings.map((f) => ({ ...f, waivedBy: ev.actor, resolution: d.resolution }))];
      g.openFindings = [];
      g.escalation = { ...(g.escalation || {}), resolvedAt: ev.ts, resolution: d.resolution, resolvedBy: ev.actor };
      break;
    }

    case 'plan.imported': {
      s.plan = { phases: d.phases, importedAt: ev.ts, importedBy: ev.actor, source: d.source };
      const phaseGates = d.phases.map((p) => `phase:${p.id}`);
      s.gateOrder = gateOrderFor((s.work && s.work.track) || 'greenfield', phaseGates);
      for (const id of phaseGates) ensureGate(s, id);
      s.tasks = {};
      for (const t of d.tasks) {
        s.tasks[t.id] = { ...t, status: 'pending', attempts: 0, claim: null, history: [], completedBy: null, handoffId: null };
      }
      break;
    }

    case 'task.claimed': {
      const t = s.tasks[d.task];
      t.status = 'claimed';
      t.attempts += 1;
      t.claim = { agent: ev.actor, at: ev.ts, baseCommit: d.baseCommit || null, runId: d.runId || null };
      // The lean baseline is the task's first claim, kept across retries and rework,
      // so a failed attempt cannot launder a dependency or marker into the baseline.
      if (d.leanBase && !t.leanBase) t.leanBase = d.leanBase;
      if (d.compatBase && !t.compatBase) t.compatBase = d.compatBase;
      t.history.push({ event: 'claimed', by: ev.actor, at: ev.ts, attempt: t.attempts });
      break;
    }

    case 'task.completed': {
      const t = s.tasks[d.task];
      t.status = 'done';
      t.completedBy = ev.actor;
      t.handoffId = d.handoffId;
      t.filesChanged = d.filesChanged || [];
      if (d.lean) t.lean = d.lean; // only on events written with lean checks, so older records replay unchanged
      t.history.push({ event: 'completed', by: ev.actor, at: ev.ts });
      // The base of the claim that completed: fix verify and mutate measure
      // the fix against it after the claim is gone.
      t.baseCommit = (t.claim && t.claim.baseCommit) || t.baseCommit || null;
      t.claim = null;
      break;
    }

    case 'task.failed': {
      const t = s.tasks[d.task];
      t.status = d.escalated ? 'escalated' : 'pending';
      t.history.push({ event: d.interrupted ? 'interrupted' : 'failed', by: ev.actor, at: ev.ts, reason: d.reason });
      t.claim = null;
      if (d.escalated) t.escalation = { at: ev.ts, reason: d.reason, recovery: d.recovery };
      break;
    }

    case 'task.rescoped': {
      const t = s.tasks[d.task];
      if (d.files) t.files = d.files;
      // A corrected pinned check (one-task tracks, or the user): the next
      // claim's completion needs this command passing.
      if (d.command) t.verification = { ...(t.verification || {}), command: d.command };
      t.history.push({ event: 'rescoped', by: ev.actor, at: ev.ts, from: d.from, reason: d.reason, ...(d.command ? { fromCommand: d.fromCommand || null } : {}) });
      break;
    }

    case 'task.reset': {
      const t = s.tasks[d.task];
      t.status = 'pending';
      t.attempts = 0;
      t.escalation = null;
      delete t.lean; // the next completion measures again
      t.history.push({ event: 'reset', by: ev.actor, at: ev.ts, reason: d.reason });
      for (const id of d.reopens || []) if (s.gates[id]) s.gates[id].status = 'in_progress';
      break;
    }

    case 'evidence.recorded':
      s.evidence[d.id] = { ...d, recordedBy: ev.actor, at: ev.ts };
      break;

    case 'handoff.recorded':
      s.handoffs[d.id] = { ...d.handoff, id: d.id, recordedBy: ev.actor, at: ev.ts };
      break;

    case 'run.started':
      s.runs[d.id] = { id: d.id, agent: d.agent || ev.actor, task: d.task || null, gate: d.gate || null, startedAt: ev.ts, status: 'running', attempt: d.attempt || 1 };
      break;

    case 'run.ended': {
      const r = s.runs[d.id];
      r.status = d.status;
      r.endedAt = ev.ts;
      r.durationMinutes = d.durationMinutes;
      r.costUsd = d.costUsd || 0;
      r.tokens = d.tokens || 0;
      r.note = d.note || null;
      s.totals.costUsd = round(s.totals.costUsd + r.costUsd);
      s.totals.runtimeMinutes = round(s.totals.runtimeMinutes + (d.durationMinutes || 0));
      s.totals.tokens += r.tokens;
      break;
    }

    case 'run.corrected': {
      // Append-only correction of reported usage (the original values stay in
      // the log); totals move by the delta.
      const r = s.runs[d.id];
      const dTokens = d.tokens - (r.tokens || 0);
      const dCost = d.costUsd - (r.costUsd || 0);
      r.corrections = [...(r.corrections || []), { at: ev.ts, by: ev.actor, from: { tokens: r.tokens, costUsd: r.costUsd }, to: { tokens: d.tokens, costUsd: d.costUsd }, reason: d.reason }];
      r.tokens = d.tokens;
      r.costUsd = d.costUsd;
      s.totals.tokens += dTokens;
      s.totals.costUsd = round(s.totals.costUsd + dCost);
      break;
    }

    case 'risk.recorded':
      s.risks[d.id] = { ...(s.risks[d.id] || {}), ...d, updatedAt: ev.ts, updatedBy: ev.actor };
      break;

    case 'decision.recorded':
      s.decisions[d.id] = { ...d, at: ev.ts, by: ev.actor };
      break;

    case 'memory.cited':
      s.citations.push({ ...d, at: ev.ts, by: ev.actor });
      break;

    case 'memory.recorded':
      s.lessons.push({ id: d.id, layer: d.layer, title: d.title, at: ev.ts, by: ev.actor, work: s.work ? s.work.id : null });
      break;

    // Debugging Lab (Phase 2). Refuted hypotheses and challenged evidence are
    // kept: they are evidence too, and the handoff shows them.
    case 'repro.recorded': {
      const r = { ...d, at: ev.ts, by: ev.actor };
      s.lab.repros.push(r);
      s.lab.repro = r;
      break;
    }

    case 'hypothesis.opened':
      s.lab.hypotheses[d.id] = { id: d.id, statement: d.statement, ifTrue: d.ifTrue, ifFalse: d.ifFalse, status: 'open', openedAt: ev.ts, by: ev.actor, evidence: [], closedAt: null, closedWith: [] };
      break;

    case 'hypothesis.evidence': {
      s.lab.evidence[d.id] = { ...d, at: ev.ts, by: ev.actor, challenged: null };
      const h = s.lab.hypotheses[d.hypothesis];
      if (h) h.evidence.push(d.id);
      break;
    }

    case 'hypothesis.marked': {
      const e = s.lab.evidence[d.evidence];
      if (e) {
        e.verdict = d.verdict;
        e.markedAt = ev.ts;
        if (d.note) e.note = d.note;
      }
      break;
    }

    case 'hypothesis.challenged': {
      const e = s.lab.evidence[d.evidence];
      if (e) e.challenged = { by: ev.actor, at: ev.ts, reason: d.reason };
      break;
    }

    case 'hypothesis.closed': {
      const h = s.lab.hypotheses[d.hypothesis];
      if (h) {
        h.status = d.status;
        h.closedAt = ev.ts;
        h.closedBy = ev.actor;
        h.closedWith = d.evidence || [];
      }
      break;
    }

    case 'localization.result':
      s.lab.localizations.push({ ...d, at: ev.ts, by: ev.actor });
      break;

    case 'rootcause.declared':
      s.lab.rootCause = { ...d, at: ev.ts, by: ev.actor };
      break;

    case 'lab.escalated':
      s.lab.escalations.push({ ...d, at: ev.ts, by: ev.actor });
      break;

    // Behavior diff (Phase 2).
    case 'behavior.contract':
      s.behavior.contracts.push({ ...d, at: ev.ts, by: ev.actor });
      break;

    case 'behavior.contract.amended':
      s.behavior.amendments.push({ ...d, at: ev.ts, by: ev.actor });
      break;

    case 'behavior.routing': {
      const r = { ...d, at: ev.ts, by: ev.actor };
      s.behavior.routings.push(r);
      s.behavior.routing = r;
      break;
    }

    case 'behavior.diff.result':
      s.behavior.results.push({ ...d, at: ev.ts, by: ev.actor });
      break;

    case 'behavior.waiver':
      s.behavior.waivers.push({ ...d, at: ev.ts, by: ev.actor });
      break;

    case 'delivery.completed':
      s.delivery = { at: ev.ts, by: ev.actor, report: d.report, summary: d.summary };
      if (s.work) {
        s.work.delivery = s.delivery;
        s.work.status = 'delivered';
      }
      break;

    default:
      // Unknown events are kept in the log but do not change state, so newer
      // logs remain readable by older engines.
      break;
  }
  return s;
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = { reduce, initialState, gateKind, gateOrderFor, emptyLab, emptyBehavior, FIXED_HEAD, FIXED_TAIL, TRACKS, STATE_VERSION };
