// Display helpers. Pure functions: no DOM, no network, no clock. Money is integer USD cents and is never
// converted through floating point. Times are shown in Asia/Amman. Nothing here computes a price: the server's
// cents are only formatted (spec: Frontend, "No secrets, client ids or amounts are computed client-side").

import { EXACT } from './texts.js';

export const TIME_ZONE = 'Asia/Amman';
export const PRICE_NOTICE = EXACT.PRICE_NOTICE;
export const NOT_FOUND_LABEL = 'Not found';

const wallFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// ---- money ----------------------------------------------------------------------------------------------------

export function isCents(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// 8400 -> "$84.00", 123456 -> "$1,234.56". Integer arithmetic on the cent count; grouping is done on the digit string.
export function formatUsd(cents) {
  if (!isCents(cents)) throw new RangeError('amount must be an integer number of cents, 0 or more');
  const dollars = String(Math.trunc(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${dollars}.${pad(cents % 100)}`;
}

// For optional amounts: null or undefined reads as a dash.
export function formatUsdOrDash(cents) {
  return cents === null || cents === undefined ? '—' : formatUsd(cents);
}

// 9500 -> "95.00" (the value shown in an input that takes dollars).
export function centsToDollarInput(cents) {
  if (!isCents(cents)) throw new RangeError('amount must be an integer number of cents, 0 or more');
  return `${Math.trunc(cents / 100)}.${pad(cents % 100)}`;
}

// "95", "95.5", "$95.00", "1,200.25" -> cents. Anything else -> null. String arithmetic only.
export function parseUsdToCents(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  return Number(m[1]) * 100 + Number(frac);
}

// ---- time (Asia/Amman) ------------------------------------------------------------------------------------------

function wallParts(ms) {
  const parts = {};
  for (const p of wallFormatter.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts;
}

function offsetMinutesAt(ms) {
  const w = wallParts(ms);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const whole = Math.floor(ms / 1000) * 1000;
  return Math.round((wallAsUtc - whole) / 60000);
}

// ISO-8601 with an explicit zone -> epoch ms, or null.
export function parseTs(ts) {
  if (typeof ts !== 'string') return null;
  const m = TS_RE.exec(ts);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0', frac = '0', zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(frac.padEnd(3, '0')));
  if (zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    ms -= sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60000;
  }
  return Number.isFinite(ms) ? ms : null;
}

// Ts -> "YYYY-MM-DDTHH:MM" wall clock in Asia/Amman, or null for an unreadable value.
export function utcToLocal(ts) {
  const ms = parseTs(ts);
  if (ms === null) return null;
  const w = wallParts(ms);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

// Ts -> "10:30" (Asia/Amman).
export function formatLocalTime(ts) {
  const local = utcToLocal(ts);
  return local === null ? '—' : local.slice(11);
}

// Ts -> "2026-10-20 10:30" (Asia/Amman).
export function formatLocalDateTime(ts) {
  const local = utcToLocal(ts);
  return local === null ? '—' : `${local.slice(0, 10)} ${local.slice(11)}`;
}

// A LocalDateTime ("YYYY-MM-DDTHH:MM", Asia/Amman) as shown to the user: "2026-10-20 11:00".
export function formatLocalDateTimeValue(local) {
  return typeof local === 'string' && LOCAL_RE.test(local) ? `${local.slice(0, 10)} ${local.slice(11)}` : '—';
}

// LocalDateTime (Asia/Amman) -> Ts, or null when the text is not a real local time. Used for inputs only: the server
// re-validates every value.
export function localToTs(local) {
  if (typeof local !== 'string') return null;
  const m = LOCAL_RE.exec(local.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
  let result = naive - offsetMinutesAt(naive) * 60000;
  result = naive - offsetMinutesAt(result) * 60000;
  const w = wallParts(result);
  if (w.year !== year || w.month !== month || w.day !== day || w.hour !== hour || w.minute !== minute) return null;
  return new Date(result).toISOString();
}

// ---- text labels (fixed English; unknown codes are shown as the code itself, as text) ------------------------------

function labelFrom(map, key) {
  return Object.hasOwn(map, key) ? map[key] : String(key);
}

const RESCUE_STATUS_TEXT = Object.freeze({
  needs_input: 'Needs your input',
  failed_needs_attention: 'Needs the organiser’s attention',
  refunding: 'Refunding',
  cancelling: 'Cancelling',
  replanning: 'Finding a new plan',
  no_feasible_plan: 'No feasible plan',
  cancelled: 'Cancelled',
  collected: 'Collected',
  ready_for_pickup: 'Ready for pickup',
  purchase_confirmed: 'Purchase confirmed',
  payment_authorized: 'Payment authorized',
  stock_reserved: 'Stock reserved',
  plan_found: 'Plan found',
  requirements_confirmed: 'Requirements confirmed',
});
export const rescueStatusText = (status) => labelFrom(RESCUE_STATUS_TEXT, status);

const PLAN_STATUS_TEXT = Object.freeze({
  proposed: 'Proposed',
  approved: 'Approved',
  superseded: 'Superseded',
  non_executable: 'Not executable',
  executing: 'Executing',
  executed: 'Executed',
});
export const planStatusText = (status) => labelFrom(PLAN_STATUS_TEXT, status);

const PAYMENT_STATUS_TEXT = Object.freeze({
  created: 'Not yet approved',
  approved: 'Approved by you, waiting for PayPal',
  authorization_pending: 'PayPal is confirming the authorization',
  authorized: 'Authorized — no money taken yet',
  authorization_failed: 'Authorization failed — no money taken',
  capture_pending: 'Payment is being captured',
  captured: 'Paid',
  voided: 'Authorization voided — no money taken',
  refund_requested: 'Refund requested',
  refund_pending: 'Refund in progress',
  refunded: 'Refunded',
  refund_failed: 'Refund failed — contact the organiser',
  unknown: 'Waiting for PayPal to confirm',
});
export const paymentStatusText = (status) => labelFrom(PAYMENT_STATUS_TEXT, status);

const FULFILMENT_TEXT = Object.freeze({
  awaiting_supplier: 'Waiting for the supplier to confirm',
  confirmed: 'Confirmed by the supplier',
  refused: 'Refused by the supplier',
  cancelled: 'Cancelled',
  ready: 'Ready for pickup',
  collected: 'Collected',
});
export const fulfilmentText = (status) => labelFrom(FULFILMENT_TEXT, status);

export const NOT_PAID_TEXT = EXACT.ORDER_NOT_PAID;
const PRESENTATION_TEXT = Object.freeze({
  active: 'Active',
  cancelled_payment_incomplete: NOT_PAID_TEXT,
  cancelled: 'Cancelled',
  refused: 'Refused by the supplier',
  refunded: 'Refunded',
});
export const presentationText = (presentation) => labelFrom(PRESENTATION_TEXT, presentation);

// ---- request fields ---------------------------------------------------------------------------------------------

export const FIELD_NAMES = Object.freeze([
  'productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups',
]);
// The six fields the server requires before a plan (REQUIREMENTS_INCOMPLETE).
export const CORE_FIELD_NAMES = Object.freeze(['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'maxPickups']);

export const FIELD_LABELS = Object.freeze({
  productType: 'Product type',
  cupQuantity: 'Number of cups',
  lidQuantity: 'Number of lids',
  capacityMl: 'Cup capacity (ml)',
  diameterMm: 'Cup diameter (mm)',
  material: 'Material',
  deadline: 'Needed by (Amman time)',
  budgetCents: 'Budget (US dollars)',
  maxPickups: 'Most pickups you accept',
});

const PRODUCT_TYPE_TEXT = Object.freeze({ cups_and_lids: 'Cups and lids', cups: 'Cups only', lids: 'Lids only' });
const MATERIAL_TEXT = Object.freeze({ paper: 'Paper', plastic: 'Plastic', other: 'Other' });

export function provenanceText(fieldValue) {
  if (!fieldValue || fieldValue.status !== 'known') return NOT_FOUND_LABEL;
  switch (fieldValue.provenance) {
    case 'user_text': return 'From your text';
    case 'image': return 'From the photo';
    case 'manual': return 'Entered by you';
    default: return NOT_FOUND_LABEL;
  }
}

// FieldValue -> the text shown in the value column.
export function fieldValueText(name, fieldValue) {
  if (!fieldValue || fieldValue.status !== 'known' || fieldValue.value === null || fieldValue.value === undefined) return NOT_FOUND_LABEL;
  const v = fieldValue.value;
  switch (name) {
    case 'productType': return labelFrom(PRODUCT_TYPE_TEXT, v);
    case 'material': return labelFrom(MATERIAL_TEXT, v);
    case 'budgetCents': return isCents(v) ? formatUsd(v) : String(v);
    case 'deadline': return formatLocalDateTimeValue(v) === '—' ? String(v) : `${formatLocalDateTimeValue(v)} (Amman)`;
    default: return String(v);
  }
}

export function pluralize(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function supplierLabel(code, name = null) {
  return typeof name === 'string' && name.length > 0 ? name : `Supplier ${code}`;
}

// Supplier codes joined the way the planner writes a combination: ["A","B"] -> "A+B".
export function joinCodes(codes) {
  return Array.isArray(codes) ? codes.join('+') : '';
}

// Navigation to a payment provider is allowed to http(s) only (the fake and Sandbox approval pages).
export function isNavigableUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
