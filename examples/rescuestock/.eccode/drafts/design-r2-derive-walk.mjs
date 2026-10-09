// Design probe (technical-designer, design rev 2, F-TR-2 / F-TR-3 / F-TR-5): is the REVISED rescue-status
// derivation total over states reachable through the spec's machines, saga, void rule and replan queue?
// Part 1 re-runs the technical reviewer's scenarios S01-S20 (tr-design-derive-totality.mjs) with the revised rows.
// Part 2 is a seeded random walk (the model the spec prescribes for test/unit/domain/derive.test.js): 20,000 walks
// x 60 events over one request with up to 4 plan versions of 2 supplier orders each. After every event the
// derivation must return a row other than the defensive row 14; every row hit is counted.
// Exit 0 = RS-36 (i)-(iv) hold, S13/S15/S18/S20 give the revised statuses, and the walk never reaches row 14.
const LIM = { unknownMin: 15, pendingMin: 1440 };
const TERMINAL = new Set(['voided', 'authorization_failed', 'refunded', 'refund_failed']);
const isPending = (s) => s === 'authorization_pending' || s === 'capture_pending' || s === 'refund_pending';

export function derive(st) {
  const { reqConfirmed = true, budgetDeadline = true, runs = [], versions = [], queue = false, now = 0 } = st;
  const allOps = versions.flatMap((v) => v.ops || []);
  const age = (t) => (t == null ? -1 : now - t);
  const live = versions.filter((v) => v.status !== 'superseded');
  const P = live.length ? live.reduce((a, b) => (a.v > b.v ? a : b)) : null;
  const latestRun = runs.length ? runs[runs.length - 1] : null;
  if (!reqConfirmed || !budgetDeadline) return '1';
  if (allOps.some((o) => o.status === 'refund_failed' || o.voidFailed ||
      (o.status === 'unknown' && age(o.since) > LIM.unknownMin) ||
      (isPending(o.status) && age(o.since) > LIM.pendingMin) ||
      (o.status === 'approved' && (o.authCall === 'intent' || o.authCall === 'unknown') && age(o.since) > LIM.unknownMin) || // r2 F-TR-3
      (o.cancelAt != null && !TERMINAL.has(o.status) && age(o.cancelAt) > LIM.pendingMin)) ||                            // r2 generalised ARCH-22 clause
      versions.some((v) => v.res === 'reconciling' && v.resEscalation)) return '2';
  if (allOps.some((o) => o.status === 'refund_requested' || o.status === 'refund_pending' ||
      (o.status === 'unknown' && o.prev === 'refund'))) return '3'; // r2: a refund whose call outcome is unknown is still refunding
  const closed = versions.filter((v) => v.status === 'superseded' || v.status === 'non_executable');
  if (closed.some((v) => v.ops.some((o) => ['approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown'].includes(o.status)) || v.res === 'reconciling')) return '4';
  if (queue) return '4a';                                                                                  // r2 replanning
  if (latestRun && !latestRun.feasible && (!P || P.run < latestRun.id)) return '5';
  if (P && P.status === 'executed' && P.ops.every((o) => o.status === 'refunded')) return '5a';            // r2 (OQ-D2 narrowed)
  if (P && P.status === 'non_executable' && !versions.some((v) => v.v > P.v)) return '6';
  if (P && P.status === 'executed') {
    const cap = P.ops.map((o, i) => [o, P.orders[i]]).filter(([o]) => o.status === 'captured');
    const rest = P.ops.every((o) => o.status === 'captured' || o.status === 'refunded');
    if (rest && cap.length) {
      if (cap.every(([, s]) => s === 'collected')) return '7';
      if (cap.every(([, s]) => s === 'ready' || s === 'collected')) return '8';
      return '9';
    }
  }
  if (P && ((P.status === 'approved' && P.res === 'active' && P.ops.every((o) => o.status === 'authorized')) || P.status === 'executing')) return '10';
  if (P && P.status === 'approved' && P.res === 'active') return '11';
  if (P && (P.status === 'proposed' || P.status === 'approved') && P.res !== 'active') return '12';
  if (!latestRun) return '13';
  return '14';
}
const NAME = { 1: 'needs_input', 2: 'failed_needs_attention', 3: 'refunding', 4: 'cancelling', '4a': 'replanning', 5: 'no_feasible_plan',
  '5a': 'cancelled', 6: 'cancelled', 7: 'collected', 8: 'ready_for_pickup', 9: 'purchase_confirmed', 10: 'payment_authorized',
  11: 'stock_reserved', 12: 'plan_found', 13: 'requirements_confirmed', 14: '<fallback>' };

// ---------- Part 1: reviewer scenarios, revised expectations ----------
const op = (status, extra = {}) => ({ status, since: 0, ...extra });
const run1 = { id: 1, feasible: true };
const at = 1; // "now" in minutes for static scenarios
const S = [
  ['S09 RS-36(i)', { now: at, runs: [run1, { id: 2, feasible: true }], versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'reconciling', ops: [op('refund_pending')], orders: ['confirmed'] },
    { v: 2, run: 2, status: 'executed', res: 'consumed', ops: [op('captured')], orders: ['collected'] }] }, 'refunding'],
  ['S10 RS-36(ii) void outstanding', { now: at, runs: [run1, { id: 2, feasible: true }], versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'released', ops: [op('authorized', { cancelAt: 0 }), op('voided')], orders: ['refused', 'cancelled'] },
    { v: 2, run: 2, status: 'proposed', ops: [], orders: [] }] }, 'cancelling'],
  ['S11 RS-36(ii) refund_failed', { now: at, runs: [run1], versions: [{ v: 1, run: 1, status: 'non_executable', res: 'reconciling', ops: [op('refund_failed'), op('voided')], orders: ['confirmed', 'confirmed'] }] }, 'failed_needs_attention'],
  ['S07 RS-36(iii)', { now: at, runs: [run1], versions: [{ v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('captured'), op('captured')], orders: ['ready', 'collected'] }] }, 'ready_for_pickup'],
  ['S12 RS-36(iv)', { now: at, runs: [run1, { id: 2, feasible: true }], versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'released', ops: [op('voided'), op('voided')], orders: ['refused', 'cancelled'] },
    { v: 2, run: 2, status: 'proposed', ops: [], orders: [] }] }, 'plan_found'],
  ['S13 superseded, voids done, replan queued', { now: at, queue: true, runs: [run1], versions: [
    { v: 1, run: 1, status: 'superseded', res: 'released', ops: [op('voided'), op('voided')], orders: ['cancelled', 'cancelled'] }] }, 'replanning'],
  ['S15 executed, A refunded by admin, B collected', { now: at, runs: [run1], versions: [
    { v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('refunded'), op('captured')], orders: ['confirmed', 'collected'] }] }, 'collected'],
  ['S15b executed, both refunded by admin', { now: at, runs: [run1], versions: [
    { v: 1, run: 1, status: 'executed', res: 'consumed', ops: [op('refunded'), op('refunded')], orders: ['confirmed', 'confirmed'] }] }, 'cancelled'],
  ['S18 approved with queued authorize, 3 days', { now: 4320, runs: [run1], versions: [
    { v: 1, run: 1, status: 'non_executable', res: 'expired', ops: [op('approved', { authCall: 'intent', cancelAt: 0 }), op('voided')], orders: ['cancelled', 'cancelled'] }] }, 'failed_needs_attention'],
  ['S20 reserve lost race, replan queued', { now: at, queue: true, runs: [run1], versions: [{ v: 1, run: 1, status: 'non_executable', res: null, ops: [], orders: [] }] }, 'replanning'],
];
let fails = 0;
for (const [name, st, expect] of S) {
  const row = derive(st);
  const ok = NAME[row] === expect;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} -> row ${row} ${NAME[row]} (expected ${expect})`);
}
// Row-2 coverage: every non-terminal op state left in a closed version escalates eventually.
const states = ['created', 'approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown', 'refund_requested', 'refund_pending'];
const never = states.filter((s) => {
  const st = { now: 1e6, runs: [run1], versions: [{ v: 1, run: 1, status: 'non_executable', res: 'released',
    ops: [op(s, { cancelAt: 0, authCall: s === 'approved' ? 'intent' : undefined })], orders: ['cancelled'] }] };
  const row = derive(st);
  return row !== '2' && s !== 'created'; // 'created' is voided locally by the void rule in the same transaction
});
console.log(`non-terminal states in a closed version that never escalate: ${never.join(', ') || 'none'}`);
if (never.length) fails++;

// ---------- Part 2: seeded random walk ----------
let seed = Number(process.argv[2] || 12345); // mulberry32 (32-bit safe; an LCG in float arithmetic loses precision and skews picks)
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
function fresh() { return { reqConfirmed: true, budgetDeadline: rnd() < 0.9, runs: [], versions: [], queue: false, now: 0, nextRun: 1 }; }
const curP = (st) => { const l = st.versions.filter((v) => v.status !== 'superseded'); return l.length ? l.reduce((a, b) => (a.v > b.v ? a : b)) : null; };

function voidRule(st, v, status) {
  v.status = status;
  if (v.res === 'active') v.res = 'released';
  v.orders = v.orders.map((s) => (s === 'awaiting_supplier' || s === 'confirmed' ? 'cancelled' : s));
  for (const o of v.ops) {
    if (TERMINAL.has(o.status)) continue;
    o.cancelAt = st.now;
    if (o.status === 'created' || (o.status === 'approved' && !o.authCall)) { o.status = 'voided'; o.local = true; }
    else if (o.status === 'authorized') o.voidCall = 'intent';
  }
}
function toAuthorized(o) { o.status = 'authorized'; o.authCall = 'done'; if (o.cancelAt != null && !o.voidCall) o.voidCall = 'intent'; }
function replan(st) {
  const P = curP(st);
  if (P && (P.res === 'active' || ['executing', 'executed'].includes(P.status))) return; // PLAN_IN_PROGRESS
  const feasible = rnd() < 0.8;
  const run = { id: st.nextRun++, feasible };
  st.runs.push(run);
  st.queue = false;
  if (!feasible) return;
  for (const v of st.versions) if ((v.status === 'proposed' || v.status === 'approved') && v.res !== 'active') v.status = 'superseded';
  st.versions.push({ v: st.versions.length + 1, run: run.id, status: 'proposed', res: null, ops: [], orders: [] });
}
function compensate(st, P) {
  P.status = 'non_executable'; P.res = 'reconciling';
  for (const o of P.ops) {
    if (TERMINAL.has(o.status)) continue;
    o.cancelAt = st.now;
    if (o.status === 'authorized') o.voidCall = 'intent';
    else if (o.status === 'captured') o.status = 'refund_requested';
  }
}
function releaseCheck(v) {
  if (v.res !== 'reconciling') return;
  const open = v.ops.some((o) => ['unknown', 'authorization_pending', 'capture_pending', 'refund_pending', 'refund_requested', 'refund_failed', 'authorized', 'captured'].includes(o.status) || o.voidFailed);
  if (!open) v.res = 'released';
  else if (v.ops.some((o) => o.status === 'refund_failed' || o.voidFailed)) v.resEscalation = true;
}
const EVENTS = {
  plan(st) { if (st.versions.length < 4 && !st.queue) replan(st); },
  drain(st) {
    if (!st.queue) return;
    if (st.versions.length < 4) replan(st);
    else { st.runs.push({ id: st.nextRun++, feasible: false }); st.queue = false; } // model bound: store an infeasible run
  },
  approve(st) { const P = curP(st); if (P && P.status === 'proposed' && st.budgetDeadline) P.status = 'approved'; },
  reserve(st) {
    const P = curP(st); if (!P || P.status !== 'approved' || P.res) return;
    if (rnd() < 0.8) { P.res = 'active'; P.ops = [{ status: 'created', since: st.now }, { status: 'created', since: st.now }]; P.orders = ['awaiting_supplier', 'awaiting_supplier']; }
    else { P.status = 'non_executable'; st.queue = true; } // OUT_OF_STOCK
  },
  ret(st) { const P = curP(st); if (!P || P.status !== 'approved') return; const o = P.ops.find((x) => x.status === 'created'); if (o) { o.status = 'approved'; o.authCall = 'intent'; o.since = st.now; } },
  sendAuth(st) {
    for (const v of st.versions) for (const o of v.ops) {
      if (o.status !== 'approved' || o.authCall !== 'intent') continue;
      if (o.cancelAt != null) { o.authCall = 'cancelled'; o.status = 'voided'; o.local = true; return; } // r2 F-TR-3
      const r = rnd();
      if (r < 0.6) toAuthorized(o);
      else if (r < 0.7) { o.status = 'authorization_pending'; o.since = st.now; }
      else if (r < 0.8) { o.status = 'authorization_failed'; o.authCall = 'done'; if (v.status === 'approved') { voidRule(st, v, 'non_executable'); } }
      else { o.prev = 'approved'; o.status = 'unknown'; o.authCall = 'unknown'; o.since = st.now; }
      return;
    }
  },
  resolve(st) {
    for (const v of st.versions) for (const o of v.ops) {
      if (o.status === 'unknown') {
        const r = rnd();
        if (o.prev === 'approved') { if (r < 0.5) toAuthorized(o); else { o.status = 'approved'; o.authCall = 'intent'; } }
        else if (o.prev === 'authorized-capture') { if (r < 0.5) o.status = 'captured'; else o.status = 'authorized'; if (o.status === 'captured' && v.status === 'non_executable') o.status = 'refund_requested'; }
        else if (o.prev === 'authorized-void') { o.status = r < 0.5 ? 'voided' : 'authorized'; o.voidCall = o.status === 'voided' ? 'done' : 'intent'; }
        else if (o.prev === 'refund') { o.status = r < 0.5 ? 'refunded' : 'refund_requested'; }
        releaseCheck(v); return;
      }
      if (o.status === 'authorization_pending') { if (rnd() < 0.7) toAuthorized(o); else { o.status = 'authorization_failed'; if (v.status === 'approved') voidRule(st, v, 'non_executable'); } return; }
      if (o.status === 'capture_pending') { o.status = rnd() < 0.7 ? 'captured' : 'authorized'; if (o.status === 'authorized' && v.status === 'executing') compensate(st, v); else if (o.status === 'captured' && v.status === 'non_executable') o.status = 'refund_requested'; releaseCheck(v); return; }
      if (o.status === 'refund_pending') { o.status = rnd() < 0.8 ? 'refunded' : 'refund_failed'; releaseCheck(v); return; }
    }
  },
  sendVoid(st) {
    for (const v of st.versions) for (const o of v.ops) {
      if (o.status !== 'authorized' || o.voidCall !== 'intent' || o.voidFailed) continue;
      const r = rnd();
      if (r < 0.75) { o.status = 'voided'; o.voidCall = 'done'; }
      else if (r < 0.85) o.voidFailed = true;
      else if (r < 0.92) { o.status = 'captured'; o.voidCall = 'done'; if (v.status !== 'executed') o.status = 'refund_requested'; } // r2 F-TR-6
      else { o.prev = 'authorized-void'; o.status = 'unknown'; o.since = st.now; }
      releaseCheck(v); return;
    }
  },
  sendRefund(st) {
    for (const v of st.versions) for (const o of v.ops) {
      if (o.status !== 'refund_requested') continue;
      const r = rnd();
      if (r < 0.6) o.status = 'refunded'; else if (r < 0.75) { o.status = 'refund_pending'; o.since = st.now; }
      else if (r < 0.85) o.status = 'refund_failed'; else { o.prev = 'refund'; o.status = 'unknown'; o.since = st.now; }
      releaseCheck(v); return;
    }
  },
  confirm(st) { const P = curP(st); if (!P || P.status !== 'approved') return; const i = P.orders.indexOf('awaiting_supplier'); if (i >= 0) P.orders[i] = 'confirmed'; },
  refuse(st) { const P = curP(st); if (!P || P.status !== 'approved' || !P.res) return; const i = P.orders.findIndex((s) => s === 'awaiting_supplier' || s === 'confirmed'); if (i < 0) return; voidRule(st, P, 'non_executable'); P.orders[i] = 'refused'; st.queue = true; },
  offerChange(st) {
    const P = curP(st); if (!P || !['proposed', 'approved'].includes(P.status)) return;
    if (P.orders.length && P.orders.every((s) => s === 'confirmed')) return; // every affected supplier confirmed: no supersession
    voidRule(st, P, 'superseded'); st.queue = true;
  },
  reqChange(st) {
    const P = curP(st);
    if (P && ['executing', 'executed'].includes(P.status)) return; // confirm refused: PLAN_IN_PROGRESS
    if (P && ['proposed', 'approved'].includes(P.status)) voidRule(st, P, 'superseded');
    st.runs = []; st.queue = !!P;
  },
  expire(st) { const P = curP(st); if (P && P.status === 'approved' && P.res === 'active' && rnd() < 0.5) { P.res = 'expired'; voidRule(st, P, 'non_executable'); } },
  abandon(st) { const P = curP(st); if (P && P.status === 'approved' && P.res === 'active') voidRule(st, P, 'non_executable'); },
  execute(st) {
    const P = curP(st);
    if (!P || P.status !== 'approved' || P.res !== 'active' || !P.ops.every((o) => o.status === 'authorized') || !P.orders.every((s) => s === 'confirmed')) return;
    P.status = 'executing'; P.res = 'consumed';
    if (rnd() < 0.1) compensate(st, P); // post-claim AUTHORIZATION_EXPIRED: voids only
  },
  capture(st) {
    const P = curP(st); if (!P || P.status !== 'executing') return;
    if (P.ops.some((o) => o.status === 'capture_pending' || o.status === 'unknown')) return; // paused (F-TR-7)
    const o = P.ops.find((x) => x.status === 'authorized'); if (!o) { if (P.ops.every((x) => x.status === 'captured')) P.status = 'executed'; return; }
    const r = rnd();
    if (r < 0.75) o.status = 'captured';
    else if (r < 0.83) { o.status = 'capture_pending'; o.since = st.now; }
    else if (r < 0.92) compensate(st, P);
    else { o.prev = 'authorized-capture'; o.status = 'unknown'; o.since = st.now; }
    if (P.status === 'executing' && P.ops.every((x) => x.status === 'captured')) P.status = 'executed';
  },
  ready(st) { const P = curP(st); if (P && P.status === 'executed') { const i = P.orders.indexOf('confirmed'); if (i >= 0 && P.ops[i].status === 'captured') P.orders[i] = 'ready'; } },
  collect(st) { const P = curP(st); if (P && P.status === 'executed') { const i = P.orders.indexOf('ready'); if (i >= 0) { P.orders[i] = 'collected'; collected++; } } },
  adminRefund(st) { const P = curP(st); if (P && P.status === 'executed') { const o = P.ops.find((x) => x.status === 'captured'); if (o) o.status = 'refund_requested'; } },
  time(st) { st.now += pick([1, 5, 30, 2000]); },
};
// Weighted so that walks reach execution, collection, compensation and refunds, not only the early states.
const WEIGHT = { plan: 4, drain: 4, approve: 4, reserve: 4, ret: 6, sendAuth: 6, resolve: 4, sendVoid: 3, sendRefund: 3,
  confirm: 6, refuse: 1, offerChange: 1, reqChange: 0.3, expire: 1, abandon: 0.5, execute: 5, capture: 8, ready: 4,
  collect: 4, adminRefund: 0.5, time: 1 };
let collected = 0;
const names = Object.keys(EVENTS).flatMap((n) => Array(Math.round((WEIGHT[n] ?? 1) * 10)).fill(n));
const hits = {};
let fallback = 0; let example = null;
for (let w = 0; w < 20000; w++) {
  const st = fresh();
  for (let e = 0; e < 120; e++) {
    EVENTS[pick(names)](st);
    const row = derive(st);
    hits[row] = (hits[row] || 0) + 1;
    if (row === '14') { fallback++; if (!example) example = JSON.stringify(st); }
  }
}
console.log('collect events applied:', collected, '| names pool size:', names.length, '| collect in pool:', names.filter((n) => n === 'collect').length);
console.log('rows hit:', Object.entries(hits).sort().map(([k, n]) => `${k}:${n}`).join(' '));
console.log(`fallback row 14 reached: ${fallback}${example ? ' e.g. ' + example.slice(0, 400) : ''}`);
const okAll = fails === 0 && fallback === 0;
console.log(okAll ? 'revised derivation total over the walk; scenarios as expected' : 'NOT total or scenario mismatch');
process.exit(okAll ? 0 : 1);
