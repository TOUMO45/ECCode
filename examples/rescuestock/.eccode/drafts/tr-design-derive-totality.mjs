// technical-reviewer check (design gate): is the rescue-status derivation (brief rows 1-13, plus the spec's
// ARCH-22 clause on row 2 and the OQ-D2 default row) total over states the design can reach, and does it
// give the RS-36 (i)-(iv) results? It also reports which non-terminal operation states in a cancelled version
// have no age-based escalation in row 2 (they could stay "cancelling" forever).
// Exit 0 when RS-36 (i)-(iv) give the brief's results; gaps are REPORTED, not failed.
const LIM = { unknownMin: 15, pendingMin: 1440 };
const isPending = (s) => s === 'authorization_pending' || s === 'capture_pending' || s === 'refund_pending';

function derive(sc, { oqd2 = true } = {}) {
  const { reqConfirmed = true, budgetDeadline = true, runs = [], versions = [] } = sc;
  const allOps = versions.flatMap((v) => v.ops || []);
  const live = versions.filter((v) => v.status !== 'superseded');
  const P = live.length ? live.reduce((a, b) => (a.v > b.v ? a : b)) : null;
  const latestRun = runs.length ? runs[runs.length - 1] : null; // runs for the CURRENT requirements only
  if (!reqConfirmed || !budgetDeadline) return [1, 'needs_input'];
  if (allOps.some((o) => o.status === 'refund_failed' || o.voidFailed ||
      (o.status === 'unknown' && o.ageMin > LIM.unknownMin) || (isPending(o.status) && o.ageMin > LIM.pendingMin) ||
      (o.cancelAgeMin > LIM.pendingMin && o.status === 'authorized' && !o.hasVoidCall)) ||
      versions.some((v) => v.res === 'reconciling' && v.resEscalation)) return [2, 'failed_needs_attention'];
  if (allOps.some((o) => o.status === 'refund_requested' || o.status === 'refund_pending')) return [3, 'refunding'];
  const closed = versions.filter((v) => v.status === 'superseded' || v.status === 'non_executable');
  if (closed.some((v) => (v.ops || []).some((o) => ['approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown'].includes(o.status)) || v.res === 'reconciling'))
    return [4, 'cancelling'];
  if (latestRun && !latestRun.feasible && (!P || P.run < latestRun.id)) return [5, 'no_feasible_plan'];
  if (oqd2 && P && P.status === 'executed' && P.ops.some((o) => o.status === 'refunded')) return ['5a(OQ-D2)', 'cancelled'];
  if (P && P.status === 'non_executable' && !versions.some((v) => v.v > P.v)) return [6, 'cancelled'];
  const allCap = P && P.ops.every((o) => o.status === 'captured');
  if (P && P.status === 'executed' && allCap && P.orders.every((s) => s === 'collected')) return [7, 'collected'];
  if (P && P.status === 'executed' && allCap && P.orders.every((s) => s === 'ready' || s === 'collected')) return [8, 'ready_for_pickup'];
  if (P && P.status === 'executed' && allCap) return [9, 'purchase_confirmed'];
  if (P && ((P.status === 'approved' && P.res === 'active' && P.ops.every((o) => o.status === 'authorized')) || P.status === 'executing')) return [10, 'payment_authorized'];
  if (P && P.status === 'approved' && P.res === 'active') return [11, 'stock_reserved'];
  if (P && (P.status === 'proposed' || P.status === 'approved') && P.res !== 'active') return [12, 'plan_found'];
  if (!latestRun) return [13, 'requirements_confirmed'];
  return [null, '<NO ROW MATCHES>'];
}

const op = (status, extra = {}) => ({ status, ageMin: 1, ...extra });
const run1 = { id: 1, feasible: true };
const S = [
  ['S01 confirmed, no run', { runs: [] }, 'requirements_confirmed'],
  ['S02 v1 proposed', { runs: [run1], versions: [{ v: 1, run: 1, status: 'proposed', ops: [], orders: [] }] }, 'plan_found'],
  ['S03 v1 approved, res active, ops created', { runs: [run1], versions: [{ v: 1, run: 1, status: 'approved', res: 'active', ops: [op('created'), op('created')], orders: ['awaiting_supplier', 'awaiting_supplier'] }] }, 'stock_reserved'],
  ['S04 all authorized', { runs: [run1], versions: [{ v: 1, run: 1, status: 'approved', res: 'active', ops: [op('authorized'), op('authorized')], orders: ['confirmed', 'confirmed'] }] }, 'payment_authorized'],
  ['S05 executing', { runs: [run1], versions: [{ v: 1, run: 1, status: 'executing', res: 'consumed', ops: [op('captured'), op('authorized')], orders: ['confirmed', 'confirmed'] }] }, 'payment_authorized'],
  ['S06 executed, all captured', { runs: [run1], versions: [{ v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('captured'), op('captured')], orders: ['confirmed', 'confirmed'] }] }, 'purchase_confirmed'],
  ['S07 RS-36(iii) one ready one collected', { runs: [run1], versions: [{ v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('captured'), op('captured')], orders: ['ready', 'collected'] }] }, 'ready_for_pickup'],
  ['S08 all collected', { runs: [run1], versions: [{ v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('captured'), op('captured')], orders: ['collected', 'collected'] }] }, 'collected'],
  ['S09 RS-36(i) old version refund_pending, current all collected', { runs: [run1, { id: 2, feasible: true }], versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'reconciling', ops: [op('refund_pending')], orders: ['confirmed'] },
    { v: 2, run: 2, status: 'executed', res: 'consumed', ops: [op('captured')], orders: ['collected'] }] }, 'refunding'],
  ['S10 RS-36(ii) refusal, void outstanding, v2 proposed', { runs: [run1, { id: 2, feasible: true }], versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'released', ops: [op('authorized', { cancelAgeMin: 1, hasVoidCall: true }), op('voided')], orders: ['refused', 'cancelled'] },
    { v: 2, run: 2, status: 'proposed', ops: [], orders: [] }] }, 'cancelling'],
  ['S11 RS-36(ii) refund_failed', { runs: [run1], versions: [{ v: 1, run: 1, status: 'non_executable', res: 'reconciling', ops: [op('refund_failed'), op('voided')], orders: ['confirmed', 'confirmed'] }] }, 'failed_needs_attention'],
  ['S12 RS-36(iv) voids done after refusal, v2 proposed', { runs: [run1, { id: 2, feasible: true }], versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'released', ops: [op('voided'), op('voided')], orders: ['refused', 'cancelled'] },
    { v: 2, run: 2, status: 'proposed', ops: [], orders: [] }] }, 'plan_found'],
  ['S13 supersession (spec L724-725): v1 superseded, voids done, replan queued or offers_hash retries exhausted', { runs: [run1], versions: [
    { v: 1, run: 1, status: 'superseded', res: 'released', ops: [op('voided'), op('voided')], orders: ['cancelled', 'cancelled'] }] }, null],
  ['S14 supersession, replan stored infeasible', { runs: [run1, { id: 2, feasible: false }], versions: [
    { v: 1, run: 1, status: 'superseded', res: 'released', ops: [op('voided')], orders: ['cancelled'] }] }, 'no_feasible_plan'],
  ['S15 executed, admin refund_order on A completed, B collected (OQ-D2 case)', { runs: [run1], versions: [
    { v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('refunded'), op('captured')], orders: ['confirmed', 'collected'] }] }, null],
  ['S16 compensation complete (CAPTURE_FAILED)', { runs: [run1], versions: [{ v: 1, run: 1, status: 'non_executable', res: 'released', ops: [op('refunded'), op('voided')], orders: ['confirmed', 'confirmed'] }] }, 'cancelled'],
  ['S17 post-claim AUTHORIZATION_EXPIRED, voids outstanding', { runs: [run1], versions: [{ v: 1, run: 1, status: 'non_executable', res: 'reconciling', ops: [op('authorized', { cancelAgeMin: 1, hasVoidCall: true }), op('authorized', { cancelAgeMin: 1, hasVoidCall: true })], orders: ['confirmed', 'confirmed'] }] }, 'cancelling'],
  ['S18 expiry, op approved with authorize call queued but never started, 3 days later', { runs: [run1], versions: [{ v: 1, run: 1, status: 'non_executable', res: 'expired', ops: [op('approved', { ageMin: 4320, cancelAgeMin: 4320 }), op('voided')], orders: ['cancelled', 'cancelled'] }] }, null],
  ['S19 requirements changed, v2 requirements confirmed, no run for them', { runs: [], versions: [{ v: 1, run: 1, status: 'superseded', ops: [], orders: [] }] }, 'requirements_confirmed'],
  ['S20 reserve lost race: v1 non_executable OUT_OF_STOCK, replan pending', { runs: [run1], versions: [{ v: 1, run: 1, status: 'non_executable', ops: [], orders: [] }] }, 'cancelled'],
];

let rs36fail = 0; const gaps = [];
for (const [name, sc, expect] of S) {
  const [rule, status] = derive(sc);
  const [ruleBrief, statusBrief] = derive(sc, { oqd2: false });
  const tag = rule === null ? 'GAP' : (expect && status !== expect ? 'MISMATCH' : 'ok');
  if (tag !== 'ok') gaps.push(name);
  if (/RS-36/.test(name) && status !== expect) rs36fail++;
  console.log(`${tag.padEnd(8)} ${name} -> rule ${rule} ${status}` + (statusBrief !== status ? `  [brief rows only: rule ${ruleBrief} ${statusBrief}]` : '') + (expect ? `  (expected ${expect})` : ''));
}
// Escalation coverage: which operation states, left in a closed version, are never escalated by row 2 at any age?
const states = ['created', 'approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown', 'refund_requested', 'refund_pending'];
const never = states.filter((s) => {
  const sc = { runs: [run1], versions: [{ v: 1, run: 1, status: 'non_executable', res: 'released', ops: [op(s, { ageMin: 1e6, cancelAgeMin: 1e6, hasVoidCall: s === 'authorized' })], orders: ['cancelled'] }] };
  const [rule, status] = derive(sc);
  return rule !== 2 && status !== 'cancelled';
});
console.log(`non-terminal states in a closed version that never escalate (stay non-final forever): ${never.join(', ') || 'none'}`);
console.log(`RS-36 (i)-(iv) failures: ${rs36fail}; gaps/mismatches: ${gaps.length}`);
process.exit(rs36fail === 0 ? 0 : 1);
