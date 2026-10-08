'use strict';
// Reconciliation for resume. A fresh session must not trust the record
// blindly: this compares what the record says with the working tree and,
// with verify, re-runs the checks that earlier work and approvals relied on.
//
//   blocking - the record claims something that is no longer true (an approved
//              artifact changed, a recorded passing check now fails, the log is
//              damaged). Resolve before building on it.
//   warning  - work left in flight by the previous session (held claims and
//              the partial files they left on disk, open runs).

const { unreviewedChanges } = require('./delivery');
const { gitChangedFiles } = require('./project');
const { matchesAny, own } = require('./util');
const evidence = require('./evidence');

/** Every `ev:<id>` reference inside a value (handoffs and reviews nest them). */
function evRefs(value, out = new Set()) {
  if (typeof value === 'string') {
    const m = /^ev:([A-Za-z0-9_-]+)/.exec(value);
    if (m) out.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) evRefs(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) evRefs(v, out);
  }
  return out;
}

/** Read-only comparison of the record with the working tree. */
function inspect(store, state = store.state()) {
  const issues = [];
  const audit = store.audit();
  for (const e of audit.errors) issues.push({ severity: 'blocking', kind: 'record', detail: e });
  for (const c of unreviewedChanges(state, store.root)) {
    issues.push({ severity: 'blocking', kind: 'approved-artifact', path: c.path, detail: `${c.path} ${c.problem} (approved in ${c.gate})` });
  }
  for (const t of Object.values(state.tasks)) {
    if (t.status !== 'claimed') continue;
    const run = t.claim.runId ? state.runs[t.claim.runId] : null;
    const partialFiles = (gitChangedFiles(store.root, t.claim.baseCommit) || []).filter((f) => matchesAny(f, t.files)).sort();
    issues.push({
      severity: 'warning',
      kind: 'claimed-task',
      task: t.id,
      partialFiles,
      detail: `${t.id} claimed by ${t.claim.agent}${run && run.status === 'running' ? ` (run ${run.id} still open)` : ''}; ${partialFiles.length ? `partial work on disk: ${partialFiles.join(', ')} - inspect it before redoing the task` : 'no changes on disk since the claim'}`,
    });
  }
  for (const r of Object.values(state.runs)) {
    if (r.status === 'running') {
      issues.push({ severity: 'warning', kind: 'open-run', run: r.id, detail: `run ${r.id} (${r.agent}) opened ${r.startedAt} is still open; if its session is gone: eccode recover --all` });
    }
  }
  return issues;
}

/** Latest passing check per command that done tasks or approvals relied on. */
function checksToVerify(state, maxChecks) {
  const refs = new Set();
  for (const t of Object.values(state.tasks)) {
    if (t.status === 'done' && t.handoffId && state.handoffs[t.handoffId]) evRefs(state.handoffs[t.handoffId].evidence, refs);
  }
  for (const gateId of state.gateOrder) {
    const g = state.gates[gateId];
    if (!g || g.status !== 'approved') continue;
    for (const rid of g.reviews) if (state.reviews[rid]) evRefs(state.reviews[rid].criteria, refs);
  }
  const latest = new Map();
  for (const id of refs) {
    const ev = own(state.evidence, id);
    if (!ev || ev.kind !== 'command' || ev.status !== 'passed' || ev.purpose === 'reproduction') continue;
    if (/\[REDACTED/.test(ev.command)) continue; // the original command line is not recoverable
    const key = `${ev.cwd}\u0000${ev.command}`;
    if (!latest.has(key) || latest.get(key).at < ev.at) latest.set(key, ev);
  }
  return [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, maxChecks);
}

/**
 * Reconcile and record the outcome (event `project.reconciled`). With verify,
 * re-run recorded passing checks; each re-run is itself recorded as evidence.
 */
function reconcile(store, config, actor, { verify = false, maxChecks = 10 } = {}) {
  const issues = inspect(store);
  const checks = [];
  if (verify) {
    for (const ev of checksToVerify(store.state(), maxChecks)) {
      const rerun = evidence.runCommand(store, actor, { label: `reconcile: ${ev.label}`, command: ev.command, cwd: ev.cwd === '.' ? undefined : ev.cwd, purpose: 'check' });
      checks.push({ previous: ev.id, rerun: rerun.id, command: ev.command, status: rerun.status });
      if (rerun.status !== 'passed') {
        issues.push({ severity: 'blocking', kind: 'check-regressed', previous: ev.id, rerun: rerun.id, detail: `check "${ev.label}" passed at ${ev.at} (ev:${ev.id}) but fails now (ev:${rerun.id}): ${ev.command}` });
      }
    }
  }
  const blocking = issues.filter((i) => i.severity === 'blocking').length;
  const report = { ok: blocking === 0, blocking, warnings: issues.length - blocking, issues, checks, verified: verify };
  store.commit('project.reconciled', actor, { ok: report.ok, blocking, warnings: report.warnings, verified: verify, checks, issues: issues.slice(0, 50) });
  return report;
}

function formatIssues(issues) {
  if (!issues.length) return 'RECONCILE: record matches the working tree.';
  const blocking = issues.filter((i) => i.severity === 'blocking').length;
  return [`RECONCILE: ${blocking} blocking, ${issues.length - blocking} warning(s)`, ...issues.map((i) => `- [${i.severity === 'blocking' ? 'BLOCKING' : 'warning'}] ${i.kind}: ${i.detail}`)].join('\n');
}

module.exports = { inspect, reconcile, checksToVerify, formatIssues };
