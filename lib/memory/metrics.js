'use strict';
// Measurable outcomes, computed from the event log and memory records — not
// self-reported. Every metric states its sample size so small samples are
// not mistaken for trends.

const { Memory, current } = require('./records');
const improve = require('./improve');

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function compute(store, config) {
  const events = store.isInitialized() ? store.readEvents() : [];
  const reviews = events.filter((e) => e.type === 'review.recorded');
  const refused = events.filter((e) => e.type === 'review.rejected');
  const changeReq = reviews.filter((e) => e.data.review.decision === 'changes_requested');
  const byKind = {};
  for (const e of reviews) {
    const kind = e.data.gate.startsWith('phase:') ? 'phase' : e.data.gate;
    byKind[kind] = byKind[kind] || { reviews: 0, changesRequested: 0 };
    byKind[kind].reviews += 1;
    if (e.data.review.decision === 'changes_requested') byKind[kind].changesRequested += 1;
  }

  const memory = new Memory(store, config);
  const debugging = [...memory.local.all(), ...memory.shared.all()].filter((r) => r.layer === 'debugging' && r.scope === 'project');
  const byFp = new Map();
  for (const r of debugging) {
    const fp = current(r).fingerprint;
    if (!fp) continue;
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(r);
  }
  const fixMinutes = [];
  for (const r of debugging) {
    const verified = r.reviews.find((v) => v.decision === 'verify');
    if (!verified) continue;
    const start = new Date(current(r).occurredAt || r.createdAt);
    fixMinutes.push(Math.max(0, (new Date(verified.at) - start) / 60000));
  }
  let recurrences = 0;
  for (const recs of byFp.values()) {
    const fixedAt = recs.map((r) => r.reviews.find((v) => v.decision === 'verify')).filter(Boolean).map((v) => new Date(v.at));
    if (!fixedAt.length) continue;
    const firstFix = Math.min(...fixedAt);
    recurrences += recs.filter((r) => new Date(current(r).occurredAt || r.createdAt) > firstFix).length;
  }
  const repeated = [...byFp.values()].filter((v) => v.length > 1).length;

  const checks = events.filter((e) => e.type === 'memory.checked');
  const verdicts = {};
  for (const c of checks) verdicts[c.data.verdict] = (verdicts[c.data.verdict] || 0) + 1;

  const props = store.isInitialized() ? improve.list(store) : [];
  const adopted = props.filter((p) => ['adopted', 'rolled_back'].includes(p.status));
  const regressions = props.filter((p) => p.rollback && p.rollback.regression).length;

  const summary = {
    reviewRejectionRate: reviews.length ? `${changeReq.length}/${reviews.length} (${Math.round((100 * changeReq.length) / reviews.length)}%)` : 'n/a (0 reviews)',
    reviewsRefusedByGateRules: refused.length,
    repeatedBugFingerprints: `${repeated}/${byFp.size} fingerprints seen more than once`,
    medianTimeToVerifiedFixMinutes: fixMinutes.length ? Math.round(median(fixMinutes) * 10) / 10 : 'n/a (no verified fixes)',
    recurrenceAfterFix: recurrences,
    lessonApplicabilityChecks: verdicts,
    lessonRelevanceDecisions: events.filter((e) => e.type === 'memory.assessed').reduce((acc, e) => ({ ...acc, [e.data.verdict]: (acc[e.data.verdict] || 0) + 1 }), {}),
    lessonDecisions: events.filter((e) => e.type === 'task.completed' && e.data.lessonDecisions).flatMap((e) => e.data.lessonDecisions).reduce((acc, d) => {
      const k = d.decision === 'applied' ? 'applied' : d.basis === 'assessment' ? 'not-applicable (evidence)' : 'not-applicable (reason only)';
      return { ...acc, [k]: acc[k] + 1 };
    }, { applied: 0, 'not-applicable (evidence)': 0, 'not-applicable (reason only)': 0 }),
    lessonCitations: events.filter((e) => e.type === 'memory.cited').length,
    reworksOpened: events.filter((e) => e.type === 'rework.opened').length,
    workflowChangesAdopted: adopted.length,
    workflowChangeRegressions: regressions,
  };
  return { summary, detail: { byGateKind: byKind, verifiedFixes: fixMinutes.length, debuggingRecords: debugging.length, proposals: props.map((p) => ({ id: p.id, status: p.status, target: p.target })) } };
}

function format(m) {
  return ['ECCode metrics (computed from the event log and memory records)', ...Object.entries(m.summary).map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)].join('\n');
}

module.exports = { compute, format };
