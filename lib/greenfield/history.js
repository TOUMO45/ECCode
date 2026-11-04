'use strict';
// The record as it stood when a gate was approved. An artifact is judged against the design state (questions,
// assumptions, decisions, ADRs) of ITS approval: something recorded afterwards is not a defect of an earlier
// approval, and something missing then is still missing now.
const { reduce, initialState } = require('../reducer');

/** The base state right after the review that approved `gateId`'s current approved submission; null when the gate is not approved. */
function stateAtApproval(log, state, gateId) {
  const g = state.gates && state.gates[gateId];
  if (!g || g.status !== 'approved') return null;
  let seq = null;
  for (const ev of log) {
    if (ev.type === 'review.recorded' && ev.data && ev.data.gate === gateId && ev.data.submissionId === g.approvedSubmission && ev.data.review && ev.data.review.decision === 'approve') seq = ev.seq;
  }
  if (seq === null) return state;
  let s = initialState();
  for (const ev of log) {
    if (ev.seq > seq) break;
    s = reduce(s, ev);
  }
  return s;
}

module.exports = { stateAtApproval };
