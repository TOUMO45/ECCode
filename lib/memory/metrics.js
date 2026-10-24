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

/**
 * Lean totals across completed tasks, as measured at completion (never a
 * "saved" figure: the larger version that was not written has no baseline).
 */
function leanSummary(state) {
  const measured = Object.values(state.tasks).filter((t) => t.lean);
  if (!measured.length) return 'n/a (no task completed with lean checks)';
  const sum = (k) => measured.reduce((n, t) => n + (t.lean[k] || 0), 0);
  const withCode = measured.filter((t) => t.lean.codeFiles);
  return {
    tasks: measured.length,
    linesAdded: sum('linesAdded'),
    linesRemoved: sum('linesRemoved'),
    newDependencies: measured.flatMap((t) => t.lean.newDependencies.map((d) => d.name)),
    shortcutsDeclared: measured.reduce((n, t) => n + t.lean.shortcuts.length, 0),
    codeTasksWithTests: `${withCode.filter((t) => t.lean.testFiles).length}/${withCode.length}`,
    warnings: measured.reduce((n, t) => n + (t.lean.warnings || []).length, 0),
  };
}

/**
 * What each work item cost, read from the event log: the runs opened while it
 * was active (one per dispatch), the tokens, cost and run minutes reported
 * when they ended (corrections applied), its review rounds, and the wall time
 * from its start to its delivery or abandonment. Usage is what the
 * orchestrator reported at run end; a run that reported none is counted as
 * such, never estimated.
 */
function costByWork(events) {
  const { TRACKS } = require('../reducer');
  const works = [];
  const runWork = new Map();
  const reported = new Map();
  let cur = null;
  const open = (id, track, title, at) => {
    cur = { id, track: TRACKS[track] ? track : 'greenfield', title, status: 'active', startedAt: at, endedAt: null, runs: 0, runsWithoutUsage: 0, tokens: 0, costUsd: 0, runMinutes: 0, reviews: 0, changesRequested: 0, tasks: {} };
    works.push(cur);
  };
  for (const e of events) {
    const d = e.data || {};
    if (e.type === 'project.initialized') open('w1', d.track, d.title || d.name, e.ts);
    else if (e.type === 'work.started') open(d.id, d.track, d.title, e.ts);
    else if (!cur) continue;
    else if (e.type === 'work.abandoned' || e.type === 'delivery.completed') {
      cur.status = e.type === 'work.abandoned' ? 'abandoned' : 'delivered';
      cur.endedAt = e.ts;
    } else if (e.type === 'run.started') {
      runWork.set(d.id, { work: cur, task: d.task || null });
      cur.runs += 1;
    } else if (e.type === 'run.ended' || e.type === 'run.corrected') {
      const r = runWork.get(d.id);
      if (!r) continue;
      const before = reported.get(d.id) || { tokens: 0, costUsd: 0 };
      const now = { tokens: Number(d.tokens || 0), costUsd: Number(d.costUsd || 0) };
      reported.set(d.id, now);
      r.work.tokens += now.tokens - before.tokens;
      r.work.costUsd += now.costUsd - before.costUsd;
      if (e.type === 'run.ended') {
        r.work.runMinutes += Number(d.durationMinutes || 0);
        if (!now.tokens && !now.costUsd) r.work.runsWithoutUsage += 1;
      } else if (!before.tokens && !before.costUsd && (now.tokens || now.costUsd)) r.work.runsWithoutUsage -= 1;
      if (r.task) {
        const t = (r.work.tasks[r.task] = r.work.tasks[r.task] || { runs: 0, tokens: 0 });
        if (e.type === 'run.ended') t.runs += 1;
        t.tokens += now.tokens - before.tokens;
      }
    } else if (e.type === 'review.recorded') {
      cur.reviews += 1;
      if (d.review && d.review.decision === 'changes_requested') cur.changesRequested += 1;
    }
  }
  const round = (x, k = 100) => Math.round(x * k) / k;
  return works.map((w) => ({
    ...w,
    costUsd: round(w.costUsd, 10000),
    runMinutes: round(w.runMinutes),
    wallMinutes: w.endedAt ? round((new Date(w.endedAt) - new Date(w.startedAt)) / 60000) : null,
  }));
}

/** costByWork rolled up per track; medians over delivered work items only. */
function costPerTrack(works) {
  const out = {};
  for (const w of works) {
    const t = (out[w.track] = out[w.track] || { workItems: 0, delivered: 0, runs: 0, runsWithoutUsage: 0, tokens: 0, costUsd: 0, runMinutes: 0, reviews: 0, changesRequested: 0, d: [] });
    t.workItems += 1;
    for (const k of ['runs', 'runsWithoutUsage', 'tokens', 'costUsd', 'runMinutes', 'reviews', 'changesRequested']) t[k] += w[k];
    if (w.status === 'delivered') {
      t.delivered += 1;
      t.d.push(w);
    }
  }
  for (const t of Object.values(out)) {
    const m = (k) => (t.d.length ? median(t.d.map((w) => w[k])) : null);
    Object.assign(t, {
      costUsd: Math.round(t.costUsd * 10000) / 10000,
      runMinutes: Math.round(t.runMinutes * 100) / 100,
      medianTokensPerDelivery: m('tokens'),
      medianRunsPerDelivery: m('runs'),
      medianWallMinutesPerDelivery: m('wallMinutes'),
      medianReviewsPerDelivery: m('reviews'),
    });
    delete t.d;
  }
  return out;
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
    lessonCitations: events.filter((e) => e.type === 'memory.cited').length,
    workflowChangesAdopted: adopted.length,
    workflowChangeRegressions: regressions,
    lean: store.isInitialized() ? leanSummary(store.state()) : 'n/a',
    costPerTrack: costPerTrack(costByWork(events)),
  };
  return { summary, detail: { workItems: costByWork(events), byGateKind: byKind, verifiedFixes: fixMinutes.length, debuggingRecords: debugging.length, proposals: props.map((p) => ({ id: p.id, status: p.status, target: p.target })) } };
}

function formatTrack(track, t) {
  const n = (x, one) => `${x} ${one}${x === 1 ? '' : 's'}`;
  const per = t.delivered
    ? `; per delivery (median): ${t.medianTokensPerDelivery} tokens, ${t.medianRunsPerDelivery} runs, ${t.medianWallMinutesPerDelivery} wall min, ${t.medianReviewsPerDelivery} reviews`
    : '';
  return `    ${track}: ${n(t.workItems, 'work item')} (${t.delivered} delivered); ${n(t.runs, 'run')} (${t.runsWithoutUsage} without usage); ${t.tokens} tokens; $${t.costUsd}; ${t.runMinutes} run min; ${n(t.changesRequested, 'change request')}${per}`;
}

function format(m) {
  const lines = ['ECCode metrics (computed from the event log and memory records)'];
  for (const [k, v] of Object.entries(m.summary)) {
    if (k === 'costPerTrack') {
      lines.push(`- costPerTrack (usage as reported at run end):${Object.keys(v).length ? '' : ' n/a (no work items)'}`);
      for (const [track, t] of Object.entries(v)) lines.push(formatTrack(track, t));
    } else lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return lines.join('\n');
}

module.exports = { compute, format, leanSummary, costByWork, costPerTrack };
