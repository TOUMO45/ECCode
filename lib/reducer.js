'use strict';
// Pure state reducer: (state, event) -> state. All validation happens before
// an event is committed (see lib/engine.js), so reduce() never rejects; it
// only records. Keeping it pure is what makes replay/resume deterministic.

const FIXED_HEAD = ['architecture', 'design', 'plan'];
const FIXED_TAIL = ['verification'];
// Fixed gates per profile, around the phase gates the approved plan adds.
const PROFILE_GATES = {
  delivery: { head: FIXED_HEAD, tail: FIXED_TAIL },
  change: { head: ['plan'], tail: [] },
};

function profileGates(s) {
  return PROFILE_GATES[(s.project && s.project.profile) || 'delivery'];
}

function initialState() {
  return {
    seq: 0,
    lastHash: null,
    project: null,
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
    totals: { costUsd: 0, runtimeMinutes: 0, tokens: 0 },
    delivery: null,
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
    case 'project.initialized':
      s.project = { name: d.name, idea: d.idea, createdAt: ev.ts };
      if (d.profile && d.profile !== 'delivery') {
        s.project.profile = d.profile;
        const { head, tail } = profileGates(s);
        s.gateOrder = [...head, ...tail];
      }
      for (const id of s.gateOrder) ensureGate(s, id);
      break;

    case 'gate.started': {
      const g = ensureGate(s, d.gate);
      g.status = 'in_progress';
      g.startedAt = g.startedAt || ev.ts;
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
      if (review.decision === 'approve') {
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
      // Set only when the event carries it, so older logs replay to the same snapshot.
      if (d.submissionId) s.plan.submissionId = d.submissionId;
      const phaseGates = d.phases.map((p) => `phase:${p.id}`);
      const { head, tail } = profileGates(s);
      s.gateOrder = [...head, ...phaseGates, ...tail];
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
      if (d.dirtyAtClaim) t.claim.dirtyAtClaim = d.dirtyAtClaim; // absent in older logs
      t.history.push({ event: 'claimed', by: ev.actor, at: ev.ts, attempt: t.attempts });
      break;
    }

    case 'task.completed': {
      const t = s.tasks[d.task];
      t.status = 'done';
      t.completedBy = ev.actor;
      t.handoffId = d.handoffId;
      t.filesChanged = d.filesChanged || [];
      t.history.push({ event: 'completed', by: ev.actor, at: ev.ts });
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

    case 'task.reset': {
      const t = s.tasks[d.task];
      t.status = 'pending';
      t.attempts = 0;
      t.escalation = null;
      t.history.push({ event: 'reset', by: ev.actor, at: ev.ts, reason: d.reason });
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
      // Set only when the event carries it, so logs written before the field
      // existed replay to the same snapshot (absent = usage was reported).
      if (d.usageReported !== undefined) r.usageReported = d.usageReported;
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
      if (r.usageReported === false) r.usageReported = true;
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

    case 'delivery.completed':
      s.delivery = { at: ev.ts, by: ev.actor, report: d.report, summary: d.summary };
      // Reworks opened after an earlier delivery are covered by this one. Only
      // touched when such reworks exist, so older logs replay unchanged.
      if ((s.reworks || []).some((r) => r.afterDelivery && !r.deliveredAt)) {
        s.reworks = s.reworks.map((r) => (r.afterDelivery && !r.deliveredAt ? { ...r, deliveredAt: ev.ts } : r));
      }
      break;

    case 'rework.opened': {
      // A scoped phase gate with one task, inserted before the closing gates.
      const id = ev.data.id;
      const gate = `phase:${id}`;
      s.reworks = [...(s.reworks || []), { id, gate, reason: d.reason, owner: d.owner, files: d.files, evidence: d.evidence || [], openedBy: ev.actor, at: ev.ts, afterDelivery: Boolean(s.delivery) }];
      const g = ensureGate(s, gate);
      g.status = 'in_progress';
      g.startedAt = g.startedAt || ev.ts;
      const { tail } = profileGates(s);
      const at = s.gateOrder.findIndex((x) => tail.includes(x));
      s.gateOrder = at === -1 ? [...s.gateOrder, gate] : [...s.gateOrder.slice(0, at), gate, ...s.gateOrder.slice(at)];
      s.tasks[id] = {
        id,
        phase: id,
        title: d.title || `Rework: ${String(d.reason).slice(0, 70)}`,
        owner: d.owner,
        dependencies: [],
        inputs: d.evidence || [],
        outputs: ['the fix', 'a regression test that fails without it'],
        files: d.files,
        acceptanceCriteria: [d.reason, 'a regression test fails before the fix and passes after it', 'the existing checks still pass'],
        verification: { method: 'run the project checks' },
        status: 'pending',
        attempts: 0,
        claim: null,
        history: [],
        completedBy: null,
        handoffId: null,
        rework: true,
      };
      break;
    }

    case 'project.reconciled':
      // Created lazily so logs without reconciliations replay unchanged.
      s.reconciliations = [...(s.reconciliations || []), { at: ev.ts, by: ev.actor, ok: d.ok, blocking: d.blocking, warnings: d.warnings, verified: d.verified, checks: d.checks }];
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

module.exports = { reduce, initialState, gateKind, FIXED_HEAD, FIXED_TAIL };
