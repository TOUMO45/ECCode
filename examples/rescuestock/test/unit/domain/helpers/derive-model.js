// Test model for the rescue-status derivation (F-TR-2, F-TR-5).
//
//  * refDerive(st): the revision-2 table written as a compact reference (ported from the design probe
//    .eccode/drafts/design-r2-derive-walk.mjs). It works on the abstract model state `st`.
//  * toInput(st): maps the abstract model state to the persisted rows that src/domain/derive.js consumes.
//  * makeWalk(seed): the seeded random walk over the COMPOSED machines (plan, reservation, payment, fulfilment, the
//    void rule with its resolution hooks, compensation, the re-plan queue, admin refunds and clock jumps). Every
//    status change is asserted against src/domain/states.js, so a model move the tables forbid fails the walk.
//
// Abstract state:
//   { reqConfirmed, budgetDeadline, runs: [{id, feasible}], versions: [{v, run, status, res, resEscalation, reason,
//     ops: [{status, since, prev, authCall, cancelAt, voidCall, voidFailed, local, buyerCancelled}], orders: [..]}],
//     queue: bool, now: minutes }
import { assertTransition } from '../../../../src/domain/states.js';

export const LIM = { unknownMin: 15, pendingMin: 1440 };
const TERMINAL = new Set(['voided', 'authorization_failed', 'refunded', 'refund_failed']);
const isPending = (s) => s === 'authorization_pending' || s === 'capture_pending' || s === 'refund_pending';

export const ROW_NAME = {
  1: 'needs_input', 2: 'failed_needs_attention', 3: 'refunding', 4: 'cancelling', '4a': 'replanning', 5: 'no_feasible_plan',
  '5a': 'cancelled', 6: 'cancelled', 7: 'collected', 8: 'ready_for_pickup', 9: 'purchase_confirmed', 10: 'payment_authorized',
  11: 'stock_reserved', 12: 'plan_found', 13: 'requirements_confirmed', 14: 'replanning',
};

// ---------------------------------------------------------------- reference table

export function refDerive(st) {
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
      (o.status === 'approved' && (o.authCall === 'intent' || o.authCall === 'unknown') && age(o.since) > LIM.unknownMin) ||
      (o.cancelAt != null && !TERMINAL.has(o.status) && age(o.cancelAt) > LIM.pendingMin)) ||
      versions.some((v) => v.res === 'reconciling' && v.resEscalation)) return '2';
  if (allOps.some((o) => o.status === 'refund_requested' || o.status === 'refund_pending' ||
      (o.status === 'unknown' && (o.prev === 'refund' || o.prev === 'refund_requested' || o.prev === 'refund_pending')))) return '3';
  const closed = versions.filter((v) => v.status === 'superseded' || v.status === 'non_executable');
  if (closed.some((v) => v.ops.some((o) => ['approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown'].includes(o.status)) || v.res === 'reconciling')) return '4';
  if (queue) return '4a';
  if (latestRun && !latestRun.feasible && (!P || P.run < latestRun.id)) return '5';
  if (P && P.status === 'executed' && P.ops.length && P.ops.every((o) => o.status === 'refunded')) return '5a';
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

// ---------------------------------------------------------------- model -> persisted rows

export const T0 = Date.parse('2026-10-20T07:00:00.000Z');
export const ts = (min) => new Date(T0 + min * 60000).toISOString();

const PREV = { refund: 'refund_requested', 'authorized-capture': 'authorized', 'authorized-void': 'authorized' };

export function toInput(st) {
  const versions = [];
  const reservations = [];
  const orders = [];
  const operations = [];
  const providerCalls = [];
  for (const v of st.versions) {
    versions.push({
      id: v.v, version: v.v, planning_run_id: v.run, status: v.status, superseded_by: null,
      supersede_reason: v.status === 'superseded' ? (v.reason ?? 'REPLANNED') : null,
      non_executable_reason: v.status === 'non_executable' ? (v.reason ?? 'PAYMENT_CANCELLED') : null,
      reason_detail_json: '{}',
    });
    if (v.res) {
      reservations.push({ id: v.v, plan_version_id: v.v, status: v.res, escalation: v.res === 'reconciling' && v.resEscalation ? 'REFUND_FAILED' : null });
    }
    const count = Math.max(v.ops.length, v.orders.length);
    for (let j = 0; j < count; j += 1) {
      const id = v.v * 10 + j + 1;
      orders.push({ id, plan_version_id: v.v, fulfilment_status: v.orders[j] ?? 'confirmed', supplier_code: 'AB'[j] ?? 'C', refusal_reason: null });
      const o = v.ops[j];
      if (!o) continue;
      operations.push({
        id,
        supplier_order_id: id,
        status: o.status,
        prev_status: o.prev ? (PREV[o.prev] ?? o.prev) : null,
        cancel_requested_at: o.cancelAt == null ? null : ts(o.cancelAt),
        buyer_cancelled_at: o.buyerCancelled ? ts(0) : null,
        void_failed: o.voidFailed ? 1 : 0,
        unknown_since: o.status === 'unknown' ? ts(o.since) : null,
        pending_since: isPending(o.status) ? ts(o.since) : null,
        created_at: ts(0),
        updated_at: ts(o.since ?? 0),
      });
      if (o.authCall) providerCalls.push({ id, payment_operation_id: id, kind: 'authorize', status: o.authCall, created_at: ts(o.since ?? 0) });
    }
  }
  const latest = st.runs.length ? st.runs[st.runs.length - 1] : null;
  return {
    request: { id: 1, intake_status: st.reqConfirmed ? 'confirmed' : 'extracted' },
    requirements: st.reqConfirmed
      ? { version: 1, budget_cents: st.budgetDeadline ? 12000 : null, deadline_at: st.budgetDeadline ? ts(240) : null }
      : null,
    latestRun: latest ? { id: latest.id, feasible: latest.feasible ? 1 : 0 } : null,
    versions, reservations, orders, operations, providerCalls,
    replanQueueEntry: st.queue ? { failed_drains: 0 } : null,
    now: T0 + st.now * 60000,
    limits: { unknownEscalateMin: LIM.unknownMin, pendingEscalateMin: LIM.pendingMin },
  };
}

// ---------------------------------------------------------------- the composed-machine random walk

function mv(machine, obj, key, to, reason) {
  const from = obj[key];
  if (from === to) return;
  assertTransition(machine, from, to, reason);
  obj[key] = to;
}

export function makeWalk(initialSeed, profile = "default") {
  let seed = initialSeed >>> 0;
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const counters = { collected: 0, transitions: 0 };

  const curP = (st) => {
    const l = st.versions.filter((v) => v.status !== 'superseded');
    return l.length ? l.reduce((a, b) => (a.v > b.v ? a : b)) : null;
  };
  const planTo = (v, status, reason) => { counters.transitions += 1; mv('plan', v, 'status', status, reason); if (reason) v.reason = reason; };
  const opTo = (o, status) => { counters.transitions += 1; mv('payment', o, 'status', status); };
  const resTo = (v, status) => { counters.transitions += 1; mv('reservation', v, 'res', status); };
  const orderTo = (v, i, status) => { counters.transitions += 1; const holder = { s: v.orders[i] }; mv('fulfilment', holder, 's', status); v.orders[i] = holder.s; };

  function voidRule(st, v, status, reason) {
    planTo(v, status, reason);
    if (v.res === 'active') resTo(v, 'released');
    v.orders.forEach((s, i) => { if (s === 'awaiting_supplier' || s === 'confirmed') orderTo(v, i, 'cancelled'); });
    for (const o of v.ops) {
      if (TERMINAL.has(o.status)) continue;
      o.cancelAt = st.now;
      if (o.status === 'created' || (o.status === 'approved' && !o.authCall)) { opTo(o, 'voided'); o.local = true; }
      else if (o.status === 'authorized') o.voidCall = 'intent';
    }
  }
  function toAuthorized(o) {
    opTo(o, 'authorized'); o.authCall = 'done';
    if (o.cancelAt != null && !o.voidCall) o.voidCall = 'intent';
  }
  function replan(st) {
    const P = curP(st);
    if (P && (P.res === 'active' || ['executing', 'executed'].includes(P.status))) return;
    const feasible = rnd() < 0.8;
    const run = { id: st.nextRun++, feasible };
    st.runs.push(run);
    st.queue = false;
    if (!feasible) return;
    for (const v of st.versions) if ((v.status === 'proposed' || v.status === 'approved') && v.res !== 'active') planTo(v, 'superseded', 'REPLANNED');
    st.versions.push({ v: st.versions.length + 1, run: run.id, status: 'proposed', res: null, ops: [], orders: [] });
  }
  function compensate(st, P, reason) {
    planTo(P, 'non_executable', reason);
    resTo(P, 'reconciling');
    for (const o of P.ops) {
      if (TERMINAL.has(o.status)) continue;
      o.cancelAt = st.now;
      if (o.status === 'authorized') o.voidCall = 'intent';
      else if (o.status === 'captured') opTo(o, 'refund_requested');
    }
  }
  function releaseCheck(v) {
    if (v.res !== 'reconciling') return;
    const open = v.ops.some((o) => ['unknown', 'authorization_pending', 'capture_pending', 'refund_pending', 'refund_requested', 'refund_failed', 'authorized', 'captured'].includes(o.status) || o.voidFailed);
    if (!open) resTo(v, 'released');
    else if (v.ops.some((o) => o.status === 'refund_failed' || o.voidFailed)) v.resEscalation = true;
  }
  function refundOutcome(o, to) { // refund_requested -> refund_pending -> to (the call being sent puts the op in pending)
    opTo(o, 'refund_pending');
    if (to !== 'refund_pending') opTo(o, to);
  }

  const EVENTS = {
    plan(st) { if (st.versions.length < 4 && !st.queue) replan(st); },
    drain(st) {
      if (!st.queue) return;
      if (st.versions.length < 4) replan(st);
      else { st.runs.push({ id: st.nextRun++, feasible: false }); st.queue = false; } // model bound: store an infeasible run
    },
    approve(st) { const P = curP(st); if (P && P.status === 'proposed' && st.budgetDeadline) planTo(P, 'approved'); },
    reserve(st) {
      const P = curP(st); if (!P || P.status !== 'approved' || P.res) return;
      if (rnd() < 0.8) {
        P.res = 'active';
        P.ops = [{ status: 'created', since: st.now }, { status: 'created', since: st.now }];
        P.orders = ['awaiting_supplier', 'awaiting_supplier'];
      } else { planTo(P, 'non_executable', 'OUT_OF_STOCK'); st.queue = true; }
    },
    ret(st) {
      const P = curP(st); if (!P || P.status !== 'approved') return;
      const o = P.ops.find((x) => x.status === 'created');
      if (o) { opTo(o, 'approved'); o.authCall = 'intent'; o.since = st.now; }
    },
    cancelApproval(st) { // the cancel URL: created -> created with buyer_cancelled_at
      const P = curP(st); if (!P || P.status !== 'approved') return;
      const o = P.ops.find((x) => x.status === 'created');
      if (o) { opTo(o, 'created'); o.buyerCancelled = true; }
    },
    sendAuth(st) {
      for (const v of st.versions) for (const o of v.ops) {
        if (o.status !== 'approved' || o.authCall !== 'intent') continue;
        if (o.cancelAt != null) { o.authCall = 'cancelled'; opTo(o, 'voided'); o.local = true; return; }
        const r = rnd();
        if (r < 0.6) toAuthorized(o);
        else if (r < 0.7) { opTo(o, 'authorization_pending'); o.since = st.now; }
        else if (r < 0.8) { opTo(o, 'authorization_failed'); o.authCall = 'done'; if (v.status === 'approved') voidRule(st, v, 'non_executable', 'AUTHORIZATION_FAILED'); }
        else { o.prev = 'approved'; opTo(o, 'unknown'); o.authCall = 'unknown'; o.since = st.now; }
        return;
      }
    },
    resolve(st) {
      for (const v of st.versions) for (const o of v.ops) {
        if (o.status === 'unknown') {
          const r = rnd();
          if (o.prev === 'approved') { if (r < 0.5) toAuthorized(o); else { opTo(o, 'approved'); o.authCall = 'intent'; } }
          else if (o.prev === 'authorized-capture') {
            if (r < 0.5) { opTo(o, 'captured'); if (v.status === 'non_executable') opTo(o, 'refund_requested'); } else opTo(o, 'authorized');
          } else if (o.prev === 'authorized-void') {
            if (r < 0.5) { opTo(o, 'voided'); o.voidCall = 'done'; } else { opTo(o, 'authorized'); o.voidCall = 'intent'; }
          } else if (o.prev === 'refund') { opTo(o, r < 0.5 ? 'refunded' : 'refund_requested'); }
          releaseCheck(v); return;
        }
        if (o.status === 'authorization_pending') {
          if (rnd() < 0.7) toAuthorized(o);
          else { opTo(o, 'authorization_failed'); if (v.status === 'approved') voidRule(st, v, 'non_executable', 'AUTHORIZATION_FAILED'); }
          return;
        }
        if (o.status === 'capture_pending') {
          if (rnd() < 0.7) { opTo(o, 'captured'); if (v.status === 'non_executable') opTo(o, 'refund_requested'); }
          else { opTo(o, 'authorized'); if (v.status === 'executing') compensate(st, v, 'CAPTURE_FAILED'); }
          releaseCheck(v); return;
        }
        if (o.status === 'refund_pending') { opTo(o, rnd() < 0.8 ? 'refunded' : 'refund_failed'); releaseCheck(v); return; }
      }
    },
    sendVoid(st) {
      for (const v of st.versions) for (const o of v.ops) {
        if (o.status !== 'authorized' || o.voidCall !== 'intent' || o.voidFailed) continue;
        const r = rnd();
        if (r < 0.75) { opTo(o, 'voided'); o.voidCall = 'done'; }
        else if (r < 0.85) o.voidFailed = true;
        else if (r < 0.92) { opTo(o, 'captured'); o.voidCall = 'done'; if (v.status !== 'executed') opTo(o, 'refund_requested'); } // F-TR-6
        else { o.prev = 'authorized-void'; opTo(o, 'unknown'); o.since = st.now; }
        releaseCheck(v); return;
      }
    },
    sendRefund(st) {
      for (const v of st.versions) for (const o of v.ops) {
        if (o.status !== 'refund_requested') continue;
        const r = rnd();
        if (r < 0.6) refundOutcome(o, 'refunded');
        else if (r < 0.75) { refundOutcome(o, 'refund_pending'); o.since = st.now; }
        else if (r < 0.85) refundOutcome(o, 'refund_failed');
        else { o.prev = 'refund'; opTo(o, 'unknown'); o.since = st.now; }
        releaseCheck(v); return;
      }
    },
    confirm(st) {
      const P = curP(st); if (!P || P.status !== 'approved') return;
      const i = P.orders.indexOf('awaiting_supplier'); if (i >= 0) orderTo(P, i, 'confirmed');
    },
    refuse(st) {
      const P = curP(st); if (!P || P.status !== 'approved' || !P.res) return;
      const i = P.orders.findIndex((s) => s === 'awaiting_supplier' || s === 'confirmed'); if (i < 0) return;
      orderTo(P, i, 'refused');
      voidRule(st, P, 'non_executable', 'SUPPLIER_REFUSED');
      st.queue = true;
    },
    offerChange(st) {
      const P = curP(st); if (!P || !['proposed', 'approved'].includes(P.status)) return;
      if (P.orders.length && P.orders.every((s) => s === 'confirmed')) return; // every affected supplier confirmed: no supersession
      voidRule(st, P, 'superseded', 'PRICE_CHANGED'); st.queue = true;
    },
    reqChange(st) {
      const P = curP(st);
      if (P && ['executing', 'executed'].includes(P.status)) return; // confirm refused: PLAN_IN_PROGRESS
      if (P && ['proposed', 'approved'].includes(P.status)) voidRule(st, P, 'superseded', 'REQUIREMENTS_CHANGED');
      st.runs = []; st.queue = !!P;
    },
    expire(st) {
      const P = curP(st);
      if (P && P.status === 'approved' && P.res === 'active' && rnd() < 0.5) { resTo(P, 'expired'); voidRule(st, P, 'non_executable', 'RESERVATION_EXPIRED'); }
    },
    abandon(st) { const P = curP(st); if (P && P.status === 'approved' && P.res === 'active') voidRule(st, P, 'non_executable', 'PAYMENT_CANCELLED'); },
    execute(st) {
      const P = curP(st);
      if (!P || P.status !== 'approved' || P.res !== 'active' || !P.ops.every((o) => o.status === 'authorized') || !P.orders.every((s) => s === 'confirmed')) return;
      planTo(P, 'executing'); resTo(P, 'consumed');
      if (rnd() < 0.1) compensate(st, P, 'AUTHORIZATION_EXPIRED'); // post-claim authorization check: voids only
    },
    capture(st) {
      const P = curP(st); if (!P || P.status !== 'executing') return;
      if (P.ops.some((o) => o.status === 'capture_pending' || o.status === 'unknown')) return; // paused (F-TR-7)
      const o = P.ops.find((x) => x.status === 'authorized');
      if (!o) { if (P.ops.every((x) => x.status === 'captured')) planTo(P, 'executed'); return; }
      const r = rnd();
      if (r < 0.75) opTo(o, 'captured');
      else if (r < 0.83) { opTo(o, 'capture_pending'); o.since = st.now; }
      else if (r < 0.92) compensate(st, P, 'CAPTURE_FAILED');
      else { o.prev = 'authorized-capture'; opTo(o, 'unknown'); o.since = st.now; }
      if (P.status === 'executing' && P.ops.every((x) => x.status === 'captured')) planTo(P, 'executed');
    },
    ready(st) {
      const P = curP(st);
      if (P && P.status === 'executed') { const i = P.orders.indexOf('confirmed'); if (i >= 0 && P.ops[i].status === 'captured') orderTo(P, i, 'ready'); }
    },
    collect(st) {
      const P = curP(st);
      if (P && P.status === 'executed') { const i = P.orders.indexOf('ready'); if (i >= 0) { orderTo(P, i, 'collected'); counters.collected += 1; } }
    },
    adminRefund(st) {
      const P = curP(st);
      if (P && P.status === 'executed') { const o = P.ops.find((x) => x.status === 'captured'); if (o) opTo(o, 'refund_requested'); }
    },
    time(st) { st.now += pick([1, 5, 30, 2000]); },
  };
  // Weighted so that walks reach execution, collection, compensation and refunds, not only the early states.
  const WEIGHT = { plan: 4, drain: 4, approve: 4, reserve: 4, ret: 6, cancelApproval: 0.5, sendAuth: 6, resolve: 4, sendVoid: 3, sendRefund: 3,
    confirm: 6, refuse: 1, offerChange: 1, reqChange: 0.3, expire: 1, abandon: 0.5, execute: 5, capture: 8, ready: 4,
    collect: 4, adminRefund: 2, time: 1 };
  // "progress": failures and re-plans are rare, so walks go on to execution, collection and admin refunds.
  const PROGRESS = { ...WEIGHT, refuse: 0.05, offerChange: 0.05, reqChange: 0.02, expire: 0.05, abandon: 0.02, cancelApproval: 0.1, approve: 8, reserve: 8, ret: 10, sendAuth: 10, confirm: 10, execute: 10, capture: 12, ready: 8, collect: 8, adminRefund: 4, sendRefund: 6, time: 0.3 };
  const weights = profile === "progress" ? PROGRESS : WEIGHT;
  const names = Object.keys(EVENTS).flatMap((n) => Array(Math.round((weights[n] ?? 1) * 10)).fill(n));

  return {
    counters,
    fresh: () => ({ reqConfirmed: true, budgetDeadline: rnd() < 0.9, runs: [], versions: [], queue: false, now: 0, nextRun: 1 }),
    step: (st) => { const name = pick(names); EVENTS[name](st); return name; },
    eventNames: Object.keys(EVENTS),
  };
}
