// Explanations: English text rendered by FIXED TEMPLATES from planner codes, derive codes and the planner trace.
// Every number and supplier code in a sentence comes from the trace or the derive output; nothing is free text and
// nothing comes from a model (RS-05, SEC-7). Question texts for clarification are server templates per field.

import { formatUsd } from './money.js';
import { formatLocalTime } from './time.js';

// ---- the exact sentences the brief and the design list under "Shared response objects" -------------------------

export const EXACT_SENTENCES = Object.freeze({
  REVIEW_NEW_PLAN: 'Review the new plan',
  REPLAN_WITH_CURRENT_STOCK: 'Re-plan with current stock',
  REPLAN_OR_OTHER_ACCOUNT: 'Re-plan or try another PayPal account',
  RESERVATION_EXPIRED: 'Reservation expired — no money was taken; re-plan with current stock',
  DEGRADED_EXTRACTION: 'Automatic reading unavailable — please enter the details',
  REPLANNING: 'Finding a new plan with current stock…',
  ALL_REFUNDED: 'All payments were refunded by the organiser',
  ORDER_NOT_PAID: 'Cancelled — payment did not complete',
  PRICE_NOTICE: 'Test prices, not market prices',
});

export function pricesChangedText(version) {
  return `Prices changed: review plan v${version}`;
}

export function authorizationDeclinedText(supplier) {
  return `PayPal declined the payment for ${supplier}. No money was taken; other authorizations were voided. Re-plan or try another PayPal account`;
}

export function orderRefundedText(supplier) {
  return `Order from ${supplier} was refunded by the organiser`;
}

// ---- clarification questions (server templates per field, SEC-7) ----------------------------------------------

export const QUESTION_FIELDS = Object.freeze([
  'productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups',
]);

const QUESTIONS = Object.freeze({
  productType: 'Do you need cups, lids, or cups with matching lids?',
  cupQuantity: 'How many cups do you need?',
  lidQuantity: 'How many lids do you need?',
  capacityMl: 'What capacity are the cups, in millilitres?',
  diameterMm: 'What diameter are the cups, in millimetres?',
  material: 'Should the cups be paper or plastic?',
  deadline: 'By when do you need them? Please give a date and a time.',
  budgetCents: 'What is your maximum budget, in US dollars?',
  maxPickups: 'How many different pickup locations can you visit, at most?',
});

export function questionText(field) {
  if (!Object.hasOwn(QUESTIONS, field)) throw new RangeError('unknown question field');
  return QUESTIONS[field];
}

// Field names (from a model or a form) -> Question[] in canonical order, unknown names dropped, duplicates removed.
export function buildQuestions(fields) {
  const wanted = new Set(Array.isArray(fields) ? fields : []);
  return QUESTION_FIELDS.filter((f) => wanted.has(f)).map((field) => ({ field, question: QUESTIONS[field] }));
}

// ---- rescue status: next step and message texts ----------------------------------------------------------------

const NEXT_STEP_TEXT = Object.freeze({
  ENTER_DETAILS: 'Enter the missing details',
  CONFIRM_REQUIREMENTS: 'Confirm your requirements',
  PLAN: 'Find a plan',
  APPROVE_PLAN: 'Approve the plan',
  RESERVE: 'Reserve the stock',
  APPROVE_PAYMENTS: 'Approve each payment with PayPal',
  RETRY_APPROVAL_OR_ABANDON: 'Try approval again or abandon the purchase',
  WAIT_FOR_SUPPLIERS: 'Wait for the suppliers to confirm their orders',
  COMPLETE_PURCHASE: 'Complete the purchase',
  WAIT: 'Please wait: this page updates by itself',
  COLLECT: 'Collect your order from the pickup points',
  REVIEW_NEW_PLAN: EXACT_SENTENCES.REVIEW_NEW_PLAN,
  REPLAN: EXACT_SENTENCES.REPLAN_WITH_CURRENT_STOCK,
  REPLAN_OR_OTHER_ACCOUNT: EXACT_SENTENCES.REPLAN_OR_OTHER_ACCOUNT,
  CONTACT_ORGANISER: 'Contact the organiser',
  NONE: 'Nothing more to do',
});

export const NEXT_STEP_CODES = Object.freeze(Object.keys(NEXT_STEP_TEXT));

// A few next steps read differently in the context of the message that accompanies them.
const NEXT_STEP_BY_CONTEXT = Object.freeze({
  'WAIT:REPLANNING': EXACT_SENTENCES.REPLANNING,
  'WAIT:PURCHASE_CONFIRMED': 'Wait for the suppliers to prepare your order',
  'ENTER_DETAILS:NO_FEASIBLE_PLAN': 'Adjust your budget, deadline or pickup limit, or accept a suggested change',
});

export function nextStepText(code, messageCode = null) {
  if (!Object.hasOwn(NEXT_STEP_TEXT, code)) throw new RangeError('unknown next-step code');
  const key = `${code}:${messageCode}`;
  return Object.hasOwn(NEXT_STEP_BY_CONTEXT, key) ? NEXT_STEP_BY_CONTEXT[key] : NEXT_STEP_TEXT[code];
}

function supplierLabel(params) {
  if (params.supplierName) return String(params.supplierName);
  return params.supplierCode ? `Supplier ${params.supplierCode}` : 'a supplier';
}

function joinNames(codes) {
  const names = codes.map((c) => (c ? `Supplier ${c}` : 'a supplier'));
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const MESSAGES = Object.freeze({
  NEEDS_INPUT: (p) => {
    const missing = Array.isArray(p.missing) ? p.missing : [];
    if (missing.includes('requirements')) return 'Confirm what you need before a plan can be made.';
    const names = missing.map((m) => (m === 'budgetCents' ? 'budget' : m === 'deadline' ? 'deadline' : String(m)));
    return `We still need your ${names.join(' and ')} before a plan can be made.`;
  },
  NEEDS_ATTENTION: () => 'A payment or refund needs the organiser’s attention.',
  REFUND_IN_PROGRESS: () => 'Refunds are in progress.',
  CANCELLING: () => 'Cancelling the previous plan: outstanding payments are being cancelled.',
  REPLANNING: () => EXACT_SENTENCES.REPLANNING,
  REPLAN_NEEDED: () => EXACT_SENTENCES.REPLAN_WITH_CURRENT_STOCK,
  NO_FEASIBLE_PLAN: () => 'No plan satisfies your budget, deadline and pickup limit. Nothing was reserved, ordered or paid.',
  ALL_REFUNDED: () => EXACT_SENTENCES.ALL_REFUNDED,
  ORDER_REFUNDED: (p) => (Array.isArray(p.supplierCodes) && p.supplierCodes.length > 0
    ? p.supplierCodes.map((c) => orderRefundedText(c ? `Supplier ${c}` : 'a supplier')).join('; ')
    : orderRefundedText('a supplier')),
  PURCHASE_CONFIRMED: () => 'Payment was captured. The suppliers are preparing your order.',
  CAPTURES_IN_PROGRESS: () => 'Payments are being captured.',
  AUTHORIZATION_IN_PROGRESS: () => 'Waiting for PayPal to confirm the authorizations.',
  APPROVAL_CANCELLED: () => 'PayPal approval was cancelled for at least one supplier.',
  RESERVATION_EXPIRED: () => EXACT_SENTENCES.RESERVATION_EXPIRED,
  AUTHORIZATION_FAILED: (p) => authorizationDeclinedText(supplierLabel(p)),
  AUTHORIZATION_EXPIRED: () => 'A PayPal authorization expired before the purchase could be completed. No money was taken. Re-plan or try another PayPal account',
  CAPTURE_FAILED: () => 'A payment could not be completed. Captured payments are being refunded and the other authorizations voided. Re-plan or try another PayPal account',
  PAYMENT_CANCELLED: () => 'The purchase was abandoned. No money was taken; re-plan with current stock',
  OUT_OF_STOCK: () => 'The stock was taken by another buyer before it could be reserved. No money was taken; re-plan with current stock',
  REQUEST_DELETED: () => 'This request was closed.',
  DEMO_RESET: () => 'The demonstration data was reset by the organiser.',
  SUPPLIER_REFUSED: (p) => {
    const reason = typeof p.refusal === 'string' && p.refusal.length > 0 ? `: ${p.refusal}` : '';
    return `${supplierLabel(p)} refused the order${reason}. No money was taken.`;
  },
  PRICES_CHANGED: (p) => pricesChangedText(p.version),
  PLAN_REPLACED: () => EXACT_SENTENCES.REVIEW_NEW_PLAN,
});

export function messageText(messageCode, params = {}) {
  if (messageCode === null || messageCode === undefined) return null;
  if (!Object.hasOwn(MESSAGES, messageCode)) throw new RangeError('unknown message code');
  return MESSAGES[messageCode](params ?? {});
}

// derive.js output -> the RescueStatus object of the API (without the `underlying` block, which the view adds).
export function explainRescueStatus(derived) {
  return {
    status: derived.status,
    rule: derived.rule,
    nextStep: { code: derived.nextStepCode, text: nextStepText(derived.nextStepCode, derived.messageCode) },
    message: messageText(derived.messageCode, derived.messageParams),
  };
}

// ---- planner explanations --------------------------------------------------------------------------------------

function planLabel(supplierCodes) {
  return supplierCodes.join('+');
}

function bodyLabel(body) {
  return body.lines.length === 0 ? '' : [...new Set(body.lines.map((l) => l.supplierCode))].map((code) => {
    const bundles = body.lines.filter((l) => l.supplierCode === code).reduce((n, l) => n + l.bundles, 0);
    return bundles > 1 ? `${code}×${bundles}` : code;
  }).join('+');
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function findCandidate(trace, rejection) {
  return trace.candidates.find((c) => c.offerId === rejection.offerId) ?? null;
}

function rejectionLine(code, rejection, candidate, inputs) {
  const who = `Supplier ${rejection.supplierCode}`;
  switch (code) {
    case 'INCOMPATIBLE_LID_DIAMETER':
      return `${who} is rejected: its cups are ${candidate?.cupDiameterMm} mm and its lids ${candidate?.lidDiameterMm} mm, and no compatibility is confirmed.`;
    case 'READY_AFTER_DEADLINE':
      return `${who} is rejected: it is ready at ${formatLocalTime(candidate.readyAt)}, after the ${formatLocalTime(inputs.deadlineAt)} deadline.`;
    case 'OUT_OF_STOCK':
      return `${who} is rejected: it has no stock available.`;
    case 'OFFER_WITHDRAWN':
      return `${who} is rejected: its offer was withdrawn.`;
    default:
      throw new RangeError('unknown rejection code');
  }
}

function supplyText(candidate, inputs) {
  const { cups, lids } = inputs.requirement;
  if (cups === lids && candidate.suppliesCups === candidate.suppliesLids) {
    return `${candidate.suppliesCups} of the ${cups} cups and lids needed`;
  }
  return `${candidate.suppliesCups} of the ${cups} cups and ${candidate.suppliesLids} of the ${lids} lids needed`;
}

function candidateLine(code, entry, candidate, inputs) {
  const who = `Supplier ${entry.supplierCode}`;
  switch (code) {
    case 'INSUFFICIENT_QTY':
      return `${who} alone supplies ${supplyText(candidate, inputs)}.`;
    case 'TOO_MANY_PICKUPS':
      return `${who}: the cheapest combination that covers the need (${planLabel(candidate.cheapestCover.supplierCodes)}) uses ${plural(candidate.cheapestCover.pickupCount, 'pickup', 'pickups')}; the limit is ${inputs.maxPickups}.`;
    case 'OVER_BUDGET':
      return `${who}: the cheapest combination that covers the need (${planLabel(candidate.cheapestCover.supplierCodes)}) costs ${formatUsd(candidate.cheapestCover.totalCents)}; the budget is ${formatUsd(inputs.budgetCents)}.`;
    default:
      throw new RangeError('unknown candidate code');
  }
}

function relaxationLine(r) {
  const p = r.plan;
  const who = planLabel(p.supplierCodes);
  switch (r.constraint) {
    case 'budget':
      return `Raise the budget to ${formatUsd(r.neededValue)} to get ${who} (${plural(p.pickupCount, 'pickup', 'pickups')}, ready by ${formatLocalTime(p.readyAt)}).`;
    case 'deadline':
      return `Move the deadline to ${formatLocalTime(r.neededValue)} to get ${who} for ${formatUsd(p.totalCents)} (${plural(p.pickupCount, 'pickup', 'pickups')}).`;
    case 'maxPickups':
      return `Allow ${plural(r.neededValue, 'pickup', 'pickups')} to get ${who} for ${formatUsd(p.totalCents)} (ready by ${formatLocalTime(p.readyAt)}).`;
    default:
      throw new RangeError('unknown relaxation constraint');
  }
}

function comparisonLine(c, best, alt) {
  const head = `${bodyLabel(best)} beats ${bodyLabel(alt)}`;
  switch (c.decidedBy) {
    case 'total':
      return `${head}: total ${formatUsd(c.best)} < ${formatUsd(c.alternative)}.`;
    case 'pickups':
      return `${head}: ${plural(c.best, 'pickup', 'pickups')} < ${plural(c.alternative, 'pickup', 'pickups')}.`;
    case 'readyAt':
      return `${head}: ready by ${formatLocalTime(c.best)} < ${formatLocalTime(c.alternative)}.`;
    default:
      return `${head}: tie broken by supplier order (${c.best} before ${c.alternative}).`;
  }
}

/**
 * explainPlan(result): planner output -> Explanation { lines: [{code, text}], rephrased: null }.
 * Codes are the planner's own codes (rejection, candidate and relaxation codes) or PLAN_BEST / PLAN_BEATS_<X> /
 * NO_FEASIBLE_PLAN / BLOCKING.
 */
export function explainPlan(result) {
  const lines = [];
  const { inputs } = result.trace;
  if (result.feasible) {
    const b = result.best;
    lines.push({
      code: 'PLAN_BEST',
      text: `Best plan: ${bodyLabel(b)} for ${formatUsd(b.totalCents)} in total, ${plural(b.pickupCount, 'pickup', 'pickups')}, ready by ${formatLocalTime(b.readyAt)}.`,
    });
    for (const c of result.trace.comparisons) {
      lines.push({ code: `PLAN_BEATS_${c.decidedBy.toUpperCase()}`, text: comparisonLine(c, b, result.alternatives[c.rank - 1]) });
    }
  } else {
    lines.push({ code: 'NO_FEASIBLE_PLAN', text: 'No plan satisfies every constraint. Nothing was reserved, ordered or paid.' });
  }
  for (const rej of result.rejections) {
    const candidate = findCandidate(result.trace, rej);
    for (const code of rej.codes) lines.push({ code, text: rejectionLine(code, rej, candidate, inputs) });
  }
  if (!result.feasible) {
    for (const entry of result.candidateCodes) {
      const candidate = findCandidate(result.trace, entry);
      for (const code of entry.codes) lines.push({ code, text: candidateLine(code, entry, candidate, inputs) });
    }
    for (const r of result.relaxations) lines.push({ code: r.code, text: relaxationLine(r) });
    lines.push({
      code: 'BLOCKING',
      text: `Blocking constraints: ${result.blocking.join(', ')}.`,
    });
  }
  return { lines, rephrased: null };
}
