// technical-reviewer check (design gate, revision 2): my own implementation of the REVISED rescue-status table
// (spec "Rescue status derivation (revision 2)": rows 1-13 of the brief with r2 changes to 2, 3, 7-9, 13 and the new
// rows 4a, 5a, 14), written from the spec text, not from the designer's probe.
// Part 1: my revision-1 scenarios plus new ones (refund unknown on an executed plan, retries exhausted, queued
//         authorize with cancellation, started authorize unknown past the limit, partial admin refund).
// Part 2: exhaustive enumeration of a loose abstract state space (P status x RES(P) x two operations x two orders x
//         re-plan queue x latest planning run x an older closed version), every operation young (the hardest case
//         for row 2). States that reach the defensive row 14 are printed and classified:
//         UNREACHABLE when (a) a feasible planning run is newer than every version (the spec stores the version in
//         the run's transaction), or (b) an `unknown` operation's prev_status cannot occur under P's status
//         (approved: prev approved; executing: prev authorized; executed: prev refund_requested/refund_pending).
// Exit 0 = RS-36 (i)-(iv) hold and no REACHABLE enumerated state reaches row 14.
const LIM = { unknownMin: 15, pendingMin: 1440 };
const TERMINAL = new Set(['voided', 'authorization_failed', 'refunded', 'refund_failed']);
const PENDING = new Set(['authorization_pending', 'capture_pending', 'refund_pending']);

function derive(st) {
  const { reqConfirmed = true, budgetDeadline = true, latestRun = null, versions = [], queue = false } = st;
  const ops = versions.flatMap((v) => v.ops);
  const live = versions.filter((v) => v.status !== 'superseded');
  const P = live.length ? live.reduce((a, b) => (a.v > b.v ? a : b)) : null;
  if (!reqConfirmed || !budgetDeadline) return '1';
  if (ops.some((o) => o.status === 'refund_failed' || o.voidFailed ||
      (o.status === 'unknown' && o.age > LIM.unknownMin) || (PENDING.has(o.status) && o.age > LIM.pendingMin) ||
      (o.status === 'approved' && (o.authCall === 'intent' || o.authCall === 'unknown') && o.age > LIM.unknownMin) ||
      (o.cancelAge != null && o.cancelAge > LIM.pendingMin && !TERMINAL.has(o.status))) ||
      versions.some((v) => v.res === 'reconciling' && v.esc)) return '2';
  if (ops.some((o) => o.status === 'refund_requested' || o.status === 'refund_pending' ||
      (o.status === 'unknown' && (o.prev === 'refund_requested' || o.prev === 'refund_pending')))) return '3';
  const closed = versions.filter((v) => v.status === 'superseded' || v.status === 'non_executable');
  if (closed.some((v) => v.ops.some((o) => ['approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown'].includes(o.status)) || v.res === 'reconciling')) return '4';
  if (queue) return '4a';
  if (latestRun && !latestRun.feasible && (!P || P.run < latestRun.id)) return '5';
  if (P && P.status === 'executed' && P.ops.length && P.ops.every((o) => o.status === 'refunded')) return '5a';
  if (P && P.status === 'non_executable' && !versions.some((v) => v.v > P.v)) return '6';
  if (P && P.status === 'executed' && P.ops.every((o) => o.status === 'captured' || o.status === 'refunded') && P.ops.some((o) => o.status === 'captured')) {
    const capOrders = P.ops.map((o, i) => (o.status === 'captured' ? P.orders[i] : null)).filter(Boolean);
    if (capOrders.every((s) => s === 'collected')) return '7';
    if (capOrders.every((s) => s === 'ready' || s === 'collected')) return '8';
    return '9';
  }
  if (P && ((P.status === 'approved' && P.res === 'active' && P.ops.every((o) => o.status === 'authorized')) || P.status === 'executing')) return '10';
  if (P && P.status === 'approved' && P.res === 'active') return '11';
  if (P && (P.status === 'proposed' || P.status === 'approved') && P.res !== 'active') return '12';
  if (!latestRun) return '13';
  return '14';
}
const NAME = { 1: 'needs_input', 2: 'failed_needs_attention', 3: 'refunding', 4: 'cancelling', '4a': 'replanning', 5: 'no_feasible_plan', '5a': 'cancelled',
  6: 'cancelled', 7: 'collected', 8: 'ready_for_pickup', 9: 'purchase_confirmed', 10: 'payment_authorized', 11: 'stock_reserved', 12: 'plan_found', 13: 'requirements_confirmed', 14: 'FALLBACK' };

const op = (status, x = {}) => ({ status, age: 1, ...x });
const r1 = { id: 1, feasible: true };
const S = [
  ['S07 RS-36(iii) one ready one collected', { latestRun: r1, versions: [{ v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('captured'), op('captured')], orders: ['ready', 'collected'] }] }, 'ready_for_pickup'],
  ['S09 RS-36(i) old refund_pending, current collected', { latestRun: { id: 2, feasible: true }, versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'reconciling', ops: [op('refund_pending')], orders: ['confirmed'] },
    { v: 2, run: 2, status: 'executed', res: 'consumed', ops: [op('captured')], orders: ['collected'] }] }, 'refunding'],
  ['S10 RS-36(ii) refusal, void outstanding, replan queued', { latestRun: r1, queue: true, versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'released', ops: [op('authorized', { cancelAge: 1 }), op('voided')], orders: ['refused', 'cancelled'] }] }, 'cancelling'],
  ['S11 RS-36(ii) refund_failed', { latestRun: r1, versions: [{ v: 1, run: 1, status: 'non_executable', res: 'reconciling', ops: [op('refund_failed'), op('voided')], orders: ['confirmed', 'confirmed'] }] }, 'failed_needs_attention'],
  ['S11b RS-36(ii) unknown past the limit', { latestRun: r1, versions: [{ v: 1, run: 1, status: 'non_executable', res: 'released', ops: [op('unknown', { prev: 'approved', age: 30, cancelAge: 30 }), op('voided')], orders: ['refused', 'cancelled'] }] }, 'failed_needs_attention'],
  ['S12 RS-36(iv) voids done, v2 proposed, queue entry removed', { latestRun: { id: 2, feasible: true }, versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'released', ops: [op('voided'), op('voided')], orders: ['refused', 'cancelled'] },
    { v: 2, run: 2, status: 'proposed', res: null, ops: [], orders: [] }] }, 'plan_found'],
  ['S13 superseded, voids done, replan queued', { latestRun: r1, queue: true, versions: [{ v: 1, run: 1, status: 'superseded', res: 'released', ops: [op('voided'), op('voided')], orders: ['cancelled', 'cancelled'] }] }, 'replanning'],
  ['S13b superseded, offers_hash retries exhausted (entry kept)', { latestRun: r1, queue: true, versions: [{ v: 1, run: 1, status: 'superseded', res: 'released', ops: [op('voided')], orders: ['cancelled'] }] }, 'replanning'],
  ['S15 executed, A refunded by admin, B collected', { latestRun: r1, versions: [{ v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('refunded'), op('captured')], orders: ['confirmed', 'collected'] }] }, 'collected'],
  ['S15b executed, every order refunded', { latestRun: r1, versions: [{ v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('refunded'), op('refunded')], orders: ['confirmed', 'collected'] }] }, 'cancelled'],
  ['S15c executed, admin refund call unknown', { latestRun: r1, versions: [{ v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('unknown', { prev: 'refund_requested' }), op('captured')], orders: ['collected', 'collected'] }] }, 'refunding'],
  ['S18 expiry, authorize queued never started: call cancelled, op voided locally', { latestRun: r1, versions: [{ v: 1, run: 1, status: 'non_executable', res: 'expired', ops: [op('voided'), op('voided')], orders: ['cancelled', 'cancelled'] }] }, 'cancelled'],
  ['S18b approved with started authorize still unknown, 20 min', { latestRun: r1, versions: [{ v: 1, run: 1, status: 'approved', res: 'active', ops: [op('approved', { authCall: 'unknown', age: 20 }), op('created')], orders: ['awaiting_supplier', 'awaiting_supplier'] }] }, 'failed_needs_attention'],
  ['S18c approved, authorize retryable (429) re-queued, 20 min', { latestRun: r1, versions: [{ v: 1, run: 1, status: 'approved', res: 'active', ops: [op('approved', { authCall: 'intent', age: 20 }), op('authorized')], orders: ['confirmed', 'confirmed'] }] }, 'failed_needs_attention'],
  ['S20 lost reserve race, replan queued', { latestRun: r1, queue: true, versions: [{ v: 1, run: 1, status: 'non_executable', res: null, ops: [], orders: [] }] }, 'replanning'],
  ['S21 requirements changed, new requirements, no run for them yet, no queue', { latestRun: null, versions: [{ v: 1, run: 1, status: 'superseded', res: null, ops: [], orders: [] }] }, 'requirements_confirmed'],
];
let rs36 = 0, scen = 0;
for (const [name, st, exp] of S) {
  const r = derive(st);
  const ok = NAME[r] === exp;
  if (!ok) { scen++; if (/RS-36/.test(name)) rs36++; }
  console.log(`${ok ? 'ok  ' : 'DIFF'} ${name} -> row ${r} ${NAME[r]} (expected ${exp})`);
}

// Part 2: enumeration
const OPS = ['created', 'approved', 'authorization_pending', 'authorized', 'authorization_failed', 'capture_pending', 'captured', 'voided',
  'refund_requested', 'refund_pending', 'refunded', 'refund_failed', 'unknown'];
const opVariants = [];
for (const s of OPS) {
  if (s === 'unknown') for (const p of ['approved', 'authorized', 'refund_requested', 'refund_pending']) opVariants.push({ status: s, prev: p });
  else if (s === 'approved') for (const c of ['none', 'intent', 'unknown']) opVariants.push({ status: s, authCall: c });
  else opVariants.push({ status: s });
}
const allowed = {
  proposed: { res: [null], ops: null },
  approved: { res: [null, 'active'], ops: new Set(['created', 'approved', 'authorization_pending', 'authorized', 'unknown']) },
  executing: { res: ['consumed'], ops: new Set(['authorized', 'captured', 'capture_pending', 'unknown']) },
  executed: { res: ['consumed'], ops: new Set(['captured', 'refund_requested', 'refund_pending', 'refunded', 'refund_failed', 'unknown']) },
  non_executable: { res: [null, 'released', 'expired', 'reconciling'], ops: new Set(OPS) },
};
const PREV_OK = { approved: new Set(['approved']), executing: new Set(['authorized']), executed: new Set(['refund_requested', 'refund_pending']) };
const ORD = ['awaiting_supplier', 'confirmed', 'ready', 'collected', 'refused', 'cancelled'];
let states = 0; const fallbacks = new Map(); const hits = {}; let reachableFallbacks = 0, unreachableFallbacks = 0;
for (const pStatus of ['none', 'proposed', 'approved', 'executing', 'executed', 'non_executable']) {
  for (const older of ['none', 'superseded-done', 'non_executable-done']) {
    for (const queue of [false, true]) {
      for (const runKind of ['none', 'feasibleP', 'feasibleNewer', 'infeasibleNewer']) {
        if (pStatus !== 'none' && runKind === 'none') continue;
        if (pStatus === 'none' && runKind === 'feasibleP') continue;
        if (runKind === 'feasibleNewer' && pStatus !== 'none') continue;
        const a = allowed[pStatus] || { res: [null], ops: null };
        for (const res of a.res) {
          const opSets = (a.ops && res) ? opVariants.filter((o) => a.ops.has(o.status)) : [null];
          for (const o1 of opSets) for (const o2 of opSets) {
            const ordSets = (o1 && pStatus === 'executed') ? ['confirmed', 'ready', 'collected'] : (o1 ? ORD : [null]);
            for (const d1 of ordSets) for (const d2 of ordSets) {
              const versions = [];
              if (older !== 'none') versions.push({ v: 1, run: 1, status: older.split('-')[0], res: 'released', ops: [op('voided')], orders: ['cancelled'] });
              if (pStatus !== 'none') versions.push({ v: 2, run: 2, status: pStatus, res, ops: o1 ? [op(o1.status, o1), op(o2.status, o2)] : [], orders: o1 ? [d1, d2] : [] });
              const latestRun = runKind === 'none' ? null : runKind === 'feasibleP' ? { id: 2, feasible: true }
                : runKind === 'feasibleNewer' ? { id: 3, feasible: true } : { id: 3, feasible: false };
              const r = derive({ latestRun, versions, queue });
              states++; hits[r] = (hits[r] || 0) + 1;
              if (r === '14') {
                const badPrev = [o1, o2].some((o) => o && o.status === 'unknown' && PREV_OK[pStatus] && !PREV_OK[pStatus].has(o.prev));
                const unreachable = runKind === 'feasibleNewer' || badPrev;
                if (unreachable) unreachableFallbacks++; else reachableFallbacks++;
                const k = `${unreachable ? 'UNREACHABLE' : 'REACHABLE'} ` + JSON.stringify({ pStatus, older, queue, runKind, res, o1: o1 && (o1.status + (o1.prev ? '<' + o1.prev : '')), o2: o2 && (o2.status + (o2.prev ? '<' + o2.prev : '')) });
                fallbacks.set(k, (fallbacks.get(k) || 0) + 1);
              }
            }
          }
        }
      }
    }
  }
}
console.log(`enumerated states: ${states}; rows hit: ${JSON.stringify(hits)}`);
console.log(`row-14 states: reachable ${reachableFallbacks}, unreachable ${unreachableFallbacks}; distinct shapes ${fallbacks.size}`);
for (const [k, n] of [...fallbacks].sort().slice(0, 12)) console.log(`  ${k} x${n}`);
console.log(`RS-36 (i)-(iv) failures: ${rs36}; scenario differences: ${scen}`);
process.exit(rs36 === 0 && reachableFallbacks === 0 ? 0 : 1);
