// Rescue-status derivation (design revision 2, "Rescue status derivation"; computed on read, never stored).
// Rows are evaluated top to bottom and the first match wins. The function is TOTAL: it always returns a row; the
// defensive row 14 is reported with `fallback: true` and a `stateVector` so the caller can log `derive.fallback`.
// The property test in test/unit/domain/derive.test.js requires that no reachable state ends in row 14.
//
// Inputs are persisted rows exactly as the data model names their columns (snake_case; SQLite 0/1 for booleans):
//   request        { id, intake_status }
//   requirements   the confirmed requirements row of the current version, or null: { version, budget_cents, deadline_at }
//   latestRun      latest planning_runs row for the CURRENT requirements version, or null: { id, feasible }
//   versions       plan_versions rows of the request: { id, version, planning_run_id, status, superseded_by,
//                  supersede_reason, non_executable_reason, reason_detail_json (string or object) }
//   reservations   reservations rows: { plan_version_id, status, escalation }
//   orders         supplier_orders rows of all versions: { id, plan_version_id, fulfilment_status, refusal_reason,
//                  supplier_code? }
//   operations     payment_operations rows of all versions: { supplier_order_id, status, prev_status,
//                  cancel_requested_at, buyer_cancelled_at, void_failed, unknown_since, pending_since, updated_at }
//   providerCalls  provider_calls rows: { payment_operation_id, kind, status, created_at, id }
//   replanQueueEntry  { failed_drains | failedDrains } or null
//   now            epoch milliseconds (the injected clock) or a Ts string
//   limits         { unknownEscalateMin = 15, pendingEscalateMin = 1440, replanFailedDrainsBeforeManual = 5 }
//
// Output: { status, rule, nextStepCode, messageCode, messageParams } (+ fallback, stateVector on row 14).
// Texts for nextStepCode and messageCode come from explain.js.

import { parseTs } from './time.js';

export const DEFAULT_LIMITS = Object.freeze({ unknownEscalateMin: 15, pendingEscalateMin: 1440, replanFailedDrainsBeforeManual: 5 });

export const ROW_STATUS = Object.freeze({
  1: 'needs_input',
  2: 'failed_needs_attention',
  3: 'refunding',
  4: 'cancelling',
  '4a': 'replanning',
  5: 'no_feasible_plan',
  '5a': 'cancelled',
  6: 'cancelled',
  7: 'collected',
  8: 'ready_for_pickup',
  9: 'purchase_confirmed',
  10: 'payment_authorized',
  11: 'stock_reserved',
  12: 'plan_found',
  13: 'requirements_confirmed',
  14: 'replanning',
});

export const TERMINAL_OPERATION_STATES = Object.freeze(['voided', 'authorization_failed', 'refunded', 'refund_failed']);
const PENDING_STATES = Object.freeze(['authorization_pending', 'capture_pending', 'refund_pending']);
const CANCELLING_OPEN_STATES = Object.freeze(['approved', 'authorization_pending', 'authorized', 'capture_pending', 'captured', 'unknown']);
const PRICE_REASONS = Object.freeze(['PRICE_CHANGED', 'PREP_FEE_CHANGED', 'READY_TIME_CHANGED']);

const truthy = (v) => v === 1 || v === true;

function toMs(value) {
  return typeof value === 'number' ? value : parseTs(value);
}

function parseDetail(value) {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function result(rule, nextStepCode, messageCode = null, messageParams = {}) {
  return { status: ROW_STATUS[rule], rule: String(rule), nextStepCode, messageCode, messageParams };
}

// Next step for a closed (non_executable) plan with nothing newer behind it.
function closedNextStep(reason) {
  switch (reason) {
    case 'AUTHORIZATION_FAILED':
    case 'AUTHORIZATION_EXPIRED':
    case 'CAPTURE_FAILED':
      return 'REPLAN_OR_OTHER_ACCOUNT';
    case 'REQUEST_DELETED':
    case 'DEMO_RESET':
      return 'NONE';
    default:
      return 'REPLAN';
  }
}

export function deriveRescueStatus(input) {
  const {
    requirements = null,
    latestRun = null,
    versions = [],
    reservations = [],
    orders = [],
    operations = [],
    providerCalls = [],
    replanQueueEntry = null,
    request = null,
  } = input;
  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) };
  const nowMs = toMs(input.now);
  const ageMin = (ts) => (ts === null || ts === undefined ? -1 : (nowMs - toMs(ts)) / 60000);

  // ---- indexes
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const opVersion = (op) => orderById.get(op.supplier_order_id)?.plan_version_id ?? null;
  const opsOfVersion = (v) => operations.filter((op) => opVersion(op) === v.id);
  const ordersOfVersion = (v) => orders.filter((o) => o.plan_version_id === v.id);
  const resStatusOf = (v) => {
    const mine = reservations.filter((r) => r.plan_version_id === v.id);
    if (mine.length === 0) return null;
    const live = mine.find((r) => ['active', 'consumed', 'reconciling'].includes(r.status));
    return (live ?? mine.reduce((a, b) => ((b.id ?? 0) > (a.id ?? 0) ? b : a))).status;
  };
  const latestAuthorizeCall = (op) => {
    let found = null;
    for (const c of providerCalls) {
      if (c.payment_operation_id !== op.id || c.kind !== 'authorize') continue;
      if (found === null || (c.id ?? 0) >= (found.id ?? 0)) found = c;
    }
    return found;
  };

  const allOps = operations;
  const live = versions.filter((v) => v.status !== 'superseded');
  const P = live.length > 0 ? live.reduce((a, b) => (b.version > a.version ? b : a)) : null;
  const pOps = P ? opsOfVersion(P) : [];
  const pOrders = P ? ordersOfVersion(P) : [];
  const pRes = P ? resStatusOf(P) : null;

  // ---- row 1
  if (!requirements || requirements.budget_cents === null || requirements.budget_cents === undefined ||
      requirements.deadline_at === null || requirements.deadline_at === undefined) {
    const nextStep = requirements ? 'ENTER_DETAILS' : (request?.intake_status === 'extracted' ? 'CONFIRM_REQUIREMENTS' : 'ENTER_DETAILS');
    return result(1, nextStep, 'NEEDS_INPUT', {
      missing: requirements ? [requirements.budget_cents == null ? 'budgetCents' : null, requirements.deadline_at == null ? 'deadline' : null].filter(Boolean) : ['requirements'],
    });
  }

  // ---- row 2: failed_needs_attention (brief row 2 plus the revision-2 clauses (a) and (b))
  const escalations = [];
  for (const op of allOps) {
    if (op.status === 'refund_failed') escalations.push('REFUND_FAILED');
    if (truthy(op.void_failed)) escalations.push('VOID_FAILED');
    if (op.status === 'unknown' && ageMin(op.unknown_since) > limits.unknownEscalateMin) escalations.push('UNKNOWN_TOO_LONG');
    if (PENDING_STATES.includes(op.status) && ageMin(op.pending_since ?? op.updated_at ?? op.created_at) > limits.pendingEscalateMin) {
      escalations.push('PENDING_TOO_LONG');
    }
    if (op.status === 'approved') {
      const call = latestAuthorizeCall(op);
      if (call && (call.status === 'intent' || call.status === 'unknown') && ageMin(call.created_at) > limits.unknownEscalateMin) {
        escalations.push('AUTHORIZE_OUTSTANDING_TOO_LONG'); // clause (a)
      }
    }
    if (op.cancel_requested_at && !TERMINAL_OPERATION_STATES.includes(op.status) && ageMin(op.cancel_requested_at) > limits.pendingEscalateMin) {
      escalations.push('CANCELLATION_STUCK'); // clause (b)
    }
  }
  if (reservations.some((r) => r.status === 'reconciling' && r.escalation)) escalations.push('RESERVATION_ESCALATED');
  if (escalations.length > 0) return result(2, 'CONTACT_ORGANISER', 'NEEDS_ATTENTION', { reasons: [...new Set(escalations)] });

  // ---- row 3: refunding (any version; an unknown refund call is still a refund in progress)
  if (allOps.some((op) => op.status === 'refund_requested' || op.status === 'refund_pending' ||
      (op.status === 'unknown' &&(op.prev_status === 'refund_requested' || op.prev_status === 'refund_pending')))) {
    return result(3, 'WAIT', 'REFUND_IN_PROGRESS');
  }

  // ---- row 4: cancelling (a closed version still holds money or stock work)
  const closed = versions.filter((v) => v.status === 'superseded' || v.status === 'non_executable');
  const cancellingVersion = closed.filter((v) => opsOfVersion(v).some((op) => CANCELLING_OPEN_STATES.includes(op.status)) || resStatusOf(v) === 'reconciling')
    .reduce((a, b) => (a === null || b.version > a.version ? b : a), null);
  if (cancellingVersion) {
    const detail = parseDetail(cancellingVersion.reason_detail_json);
    return result(4, 'WAIT', 'CANCELLING', {
      version: cancellingVersion.version,
      reason: cancellingVersion.non_executable_reason ?? cancellingVersion.supersede_reason ?? null,
      supplierCode: detail.supplierCode ?? null,
    });
  }

  // ---- row 4a: replanning (a queued re-plan has not stored its new run yet)
  if (replanQueueEntry) {
    const failed = replanQueueEntry.failed_drains ?? replanQueueEntry.failedDrains ?? 0;
    if (failed >= limits.replanFailedDrainsBeforeManual) return result('4a', 'REPLAN', 'REPLAN_NEEDED', { failedDrains: failed });
    return result('4a', 'WAIT', 'REPLANNING', { failedDrains: failed });
  }

  // ---- row 5: no_feasible_plan
  if (latestRun && !truthy(latestRun.feasible) && (!P || P.planning_run_id < latestRun.id)) {
    return result(5, 'ENTER_DETAILS', 'NO_FEASIBLE_PLAN');
  }

  // ---- row 5a: every operation of an executed plan was refunded afterwards
  if (P && P.status === 'executed' && pOps.length > 0 && pOps.every((op) => op.status === 'refunded')) {
    return result('5a', 'NONE', 'ALL_REFUNDED');
  }

  // ---- row 6: the current plan is closed and nothing newer exists
  if (P && P.status === 'non_executable' && !versions.some((v) => v.version > P.version)) {
    const detail = parseDetail(P.reason_detail_json);
    return result(6, closedNextStep(P.non_executable_reason), P.non_executable_reason, {
      version: P.version,
      supplierCode: detail.supplierCode ?? null,
      refusal: detail.refusal ?? null,
    });
  }

  // ---- rows 7-9: purchase made; operations are captured or (revision 2) refunded, at least one captured
  if (P && P.status === 'executed' && pOps.every((op) => op.status === 'captured' || op.status === 'refunded') &&
      pOps.some((op) => op.status === 'captured')) {
    const refundedCodes = pOps.filter((op) => op.status === 'refunded').map((op) => orderById.get(op.supplier_order_id)?.supplier_code ?? null);
    const hasRefund = refundedCodes.length > 0;
    const message = hasRefund ? 'ORDER_REFUNDED' : null;
    const params = hasRefund ? { supplierCodes: refundedCodes } : {};
    const capturedStatuses = pOps.filter((op) => op.status === 'captured').map((op) => orderById.get(op.supplier_order_id)?.fulfilment_status);
    if (capturedStatuses.every((s) => s === 'collected')) return result(7, 'NONE', message, params);
    if (capturedStatuses.every((s) => s === 'ready' || s === 'collected')) return result(8, 'COLLECT', message, params);
    return result(9, 'WAIT', message ?? 'PURCHASE_CONFIRMED', params);
  }

  // ---- row 10: payment authorized (or captures in progress)
  if (P && ((P.status === 'approved' && pRes === 'active' && pOps.every((op) => op.status === 'authorized')) || P.status === 'executing')) {
    if (P.status === 'executing') return result(10, 'WAIT', 'CAPTURES_IN_PROGRESS');
    const allConfirmed = pOrders.length > 0 && pOrders.every((o) => o.fulfilment_status === 'confirmed');
    return result(10, allConfirmed ? 'COMPLETE_PURCHASE' : 'WAIT_FOR_SUPPLIERS');
  }

  // ---- row 11: stock reserved
  if (P && P.status === 'approved' && pRes === 'active') {
    if (pOps.some((op) => op.status === 'approved' || op.status === 'authorization_pending' || op.status === 'unknown')) {
      return result(11, 'WAIT', 'AUTHORIZATION_IN_PROGRESS');
    }
    if (pOps.some((op) => op.status === 'created' && op.buyer_cancelled_at)) return result(11, 'RETRY_APPROVAL_OR_ABANDON', 'APPROVAL_CANCELLED');
    return result(11, 'APPROVE_PAYMENTS');
  }

  // ---- row 12: plan found
  if (P && (P.status === 'draft' || P.status === 'proposed' || P.status === 'approved') && pRes !== 'active') {
    const previous = versions.filter((v) => v.version < P.version).reduce((a, b) => (a === null || b.version > a.version ? b : a), null);
    if (P.status !== 'approved' && previous) {
      if (previous.status === 'superseded' && PRICE_REASONS.includes(previous.supersede_reason)) {
        return result(12, 'REVIEW_NEW_PLAN', 'PRICES_CHANGED', { version: P.version, reason: previous.supersede_reason });
      }
      if (previous.status === 'non_executable' && previous.non_executable_reason === 'SUPPLIER_REFUSED') {
        const refused = ordersOfVersion(previous).find((o) => o.fulfilment_status === 'refused');
        const detail = parseDetail(previous.reason_detail_json);
        return result(12, 'REVIEW_NEW_PLAN', 'SUPPLIER_REFUSED', {
          version: P.version,
          supplierCode: refused?.supplier_code ?? detail.supplierCode ?? null,
          refusal: refused?.refusal_reason ?? detail.refusal ?? null,
        });
      }
      if (previous.status === 'superseded') return result(12, 'REVIEW_NEW_PLAN', 'PLAN_REPLACED', { version: P.version, reason: previous.supersede_reason });
    }
    return result(12, P.status === 'approved' ? 'RESERVE' : 'APPROVE_PLAN');
  }

  // ---- row 13: requirements confirmed, no planning run for them yet
  if (!latestRun) return result(13, 'PLAN');

  // ---- row 14: defensive. Reaching it is a bug in the derivation or in a state machine, and is reported.
  return {
    ...result(14, 'REPLAN', 'REPLAN_NEEDED', {}),
    fallback: true,
    stateVector: {
      requestId: request?.id ?? null,
      currentVersion: P ? { id: P.id, version: P.version, status: P.status, reservation: pRes } : null,
      versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, reservation: resStatusOf(v) })),
      operations: operations.map((op) => ({ id: op.id ?? null, orderId: op.supplier_order_id, status: op.status, prev: op.prev_status ?? null })),
      latestRun: { id: latestRun.id, feasible: truthy(latestRun.feasible) },
    },
  };
}
