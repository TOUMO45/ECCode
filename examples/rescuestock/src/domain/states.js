// The four persisted state machines (brief > State machines; design OQ-D1 adds reasons within allowed edges).
// Plan version, reservation, payment operation and supplier-order fulfilment are separate machines. A transition
// that is not in a table is refused: assertTransition throws AppError(409, INVALID_STATE) with details.from/to.
// The rescue status is NOT a state here: it is derived on read (derive.js).

import { AppError } from './errors.js';

export const MACHINE_NAMES = Object.freeze(['plan', 'reservation', 'payment', 'fulfilment']);

// ---- reasons (OQ-D1 included) ----------------------------------------------------------------------------------

export const SUPERSEDE_REASONS = Object.freeze([
  'PRICE_CHANGED', 'PREP_FEE_CHANGED', 'READY_TIME_CHANGED', 'OFFER_WITHDRAWN',
  'AVAILABILITY_DROPPED', 'REQUIREMENTS_CHANGED', 'REPLANNED',
]);

// approved -> non_executable (before the execute claim)
const PRE_CLAIM_NON_EXECUTABLE = Object.freeze([
  'SUPPLIER_REFUSED', 'AUTHORIZATION_FAILED', 'AUTHORIZATION_EXPIRED', 'PAYMENT_CANCELLED',
  'RESERVATION_EXPIRED', 'OUT_OF_STOCK', 'REQUEST_DELETED', 'DEMO_RESET',
]);

// executing -> non_executable (compensation): a capture failed, or the post-claim authorization check failed (OQ-D1)
const POST_CLAIM_NON_EXECUTABLE = Object.freeze(['CAPTURE_FAILED', 'AUTHORIZATION_EXPIRED']);

export const NON_EXECUTABLE_REASONS = Object.freeze([...new Set([...PRE_CLAIM_NON_EXECUTABLE, ...POST_CLAIM_NON_EXECUTABLE])]);

// ---- tables ----------------------------------------------------------------------------------------------------
// Each table maps from -> to -> true (any reason) or an array of allowed reasons.

const ANY = true;

const PLAN = {
  draft: { proposed: ANY },
  proposed: { approved: ANY, superseded: SUPERSEDE_REASONS },
  approved: { superseded: SUPERSEDE_REASONS, non_executable: PRE_CLAIM_NON_EXECUTABLE, executing: ANY },
  executing: { executed: ANY, non_executable: POST_CLAIM_NON_EXECUTABLE },
  executed: {},
  superseded: {},
  non_executable: {},
};

const RESERVATION = {
  active: { consumed: ANY, expired: ANY, released: ANY },
  consumed: { reconciling: ANY },
  reconciling: { released: ANY },
  expired: {},
  released: {},
};

// The payment machine. `unknown` may resolve to whatever the provider reports, or restore the previous state.
const FROM_UNKNOWN = [
  'created', 'approved', 'authorization_pending', 'authorized', 'authorization_failed', 'capture_pending', 'captured',
  'voided', 'refund_requested', 'refund_pending', 'refunded', 'refund_failed',
];

const PAYMENT = {
  created: { approved: ANY, created: ANY, voided: ANY },
  approved: { authorized: ANY, authorization_pending: ANY, authorization_failed: ANY, unknown: ANY, voided: ANY },
  authorization_pending: { authorized: ANY, authorization_failed: ANY },
  authorized: { capture_pending: ANY, captured: ANY, unknown: ANY, voided: ANY, authorized: ANY },
  capture_pending: { captured: ANY, authorized: ANY },
  captured: { refund_requested: ANY },
  refund_requested: { refund_pending: ANY, unknown: ANY },
  refund_pending: { refunded: ANY, refund_failed: ANY, unknown: ANY },
  unknown: Object.fromEntries(FROM_UNKNOWN.map((s) => [s, ANY])),
  authorization_failed: {},
  voided: {},
  refunded: {},
  refund_failed: {},
};

const FULFILMENT = {
  awaiting_supplier: { confirmed: ANY, refused: ANY, cancelled: ANY },
  confirmed: { refused: ANY, cancelled: ANY, ready: ANY },
  ready: { collected: ANY },
  refused: {},
  cancelled: {},
  collected: {},
};

export const TABLES = deepFreeze({ plan: PLAN, reservation: RESERVATION, payment: PAYMENT, fulfilment: FULFILMENT });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Payment states from which no transition exists (brief: voided, authorization_failed, refunded, refund_failed).
export const TERMINAL_PAYMENT_STATES = Object.freeze(['voided', 'authorization_failed', 'refunded', 'refund_failed']);

function tableOf(machine) {
  const table = Object.hasOwn(TABLES, machine) ? TABLES[machine] : undefined;
  if (!table) throw new RangeError(`unknown state machine "${String(machine)}"`);
  return table;
}

export function statesOf(machine) {
  return Object.keys(tableOf(machine));
}

export function allowedTargets(machine, from) {
  const row = Object.hasOwn(tableOf(machine), from) ? tableOf(machine)[from] : undefined;
  return row ? Object.keys(row) : [];
}

// Allowed reasons of an edge: null when the edge does not exist, true when any/no reason applies, else a list.
export function transitionReasons(machine, from, to) {
  const table = tableOf(machine);
  const row = Object.hasOwn(table, from) ? table[from] : undefined;
  if (!row || !Object.hasOwn(row, to)) return null;
  return row[to];
}

/**
 * canTransition(machine, from, to[, reason]): is the edge in the table? When the edge lists reasons and a reason
 * is given it must be one of them; when no reason is given the answer is about the edge alone (use requiresReason
 * to ask whether a reason must accompany the edge).
 */
export function canTransition(machine, from, to, reason) {
  const allowed = transitionReasons(machine, from, to);
  if (allowed === null) return false;
  if (reason === undefined || allowed === true) return true;
  return allowed.includes(reason);
}

export function requiresReason(machine, from, to) {
  const allowed = transitionReasons(machine, from, to);
  return Array.isArray(allowed);
}

export function assertTransition(machine, from, to, reason) {
  if (!canTransition(machine, from, to, reason)) {
    const details = { machine, from: String(from), to: String(to) };
    if (reason !== undefined) details.reason = String(reason);
    throw new AppError(409, 'INVALID_STATE', 'The requested state change is not allowed.', details);
  }
}
