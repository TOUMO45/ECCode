// Turns an ApiError into text that tells the user what to do next. The envelope message is the fallback; the
// requestId is always carried so a person can quote it. Texts are fixed English; nothing comes from a model.

import { EXACT } from './texts.js';

const GUIDE = Object.freeze({
  CLIENT_TIMEOUT: { message: 'The server is taking too long.', action: 'Try again in a moment.' },
  UNAUTHENTICATED: { message: 'Your session has ended.', action: 'Sign in again.' },
  INVALID_CREDENTIALS: { message: 'The username or password is not right.', action: 'Check both and try again.' },
  CSRF_FAILED: { message: 'This page is out of date.', action: 'Reload the page and try again.' },
  RATE_LIMITED: { message: 'Too many attempts in a short time.', action: 'Wait a little and try again.' },
  FORBIDDEN: { message: 'You are not allowed to do that.', action: 'Use an account that has access.' },
  NOT_FOUND: { message: 'That item was not found.', action: 'Go back to your list and open it again.' },
  USERNAME_TAKEN: { message: 'That username is taken.', action: 'Choose another one.' },
  SIGNUP_DISABLED: { message: 'Registration is turned off.', action: 'Ask the organiser for an account.' },
  VALIDATION_FAILED: { message: 'Some values are not valid.', action: 'Correct the marked fields and send again.' },
  REQUIREMENTS_INCOMPLETE: { message: 'Some required details are missing.', action: 'Fill in every required field and confirm again.' },
  MISSING_BUDGET: { message: 'A budget is needed before the plan can be approved.', action: 'Add a budget under “What you need”.' },
  MISSING_DEADLINE: { message: 'A deadline is needed before the plan can be approved.', action: 'Add a deadline under “What you need”.' },
  PLAN_CHANGED: { message: 'The plan changed while you were looking at it. Nothing was approved.', action: 'Review the new plan and approve it again.' },
  PLAN_SUPERSEDED: { message: 'This plan was replaced by a newer one.', action: 'Review the new plan.' },
  PLAN_NOT_EXECUTABLE: { message: 'This plan can no longer be carried out.', action: 'Re-plan with current stock.' },
  PLAN_INVALID: { message: 'This plan no longer covers what you need.', action: 'Re-plan with current stock.' },
  PLAN_IN_PROGRESS: { message: 'A plan for this request is already being carried out.', action: 'Wait for it to finish.' },
  OUT_OF_STOCK: { message: 'The stock was taken by another buyer. No money was taken.', action: 'Re-plan with current stock.' },
  ALREADY_RESERVED: { message: 'This plan already has a reservation.', action: 'Reload the page to see it.' },
  RESERVATION_LIMIT: { message: 'You already hold stock for another request — finish or abandon it first', action: 'Open your requests.' },
  RESERVATION_EXPIRED: { message: EXACT.RESERVATION_EXPIRED, action: 'Re-plan with current stock.' },
  IDEMPOTENCY_KEY_REUSED: { message: 'This reservation attempt was already used for a different plan.', action: 'Reload the page and try again.' },
  AUTHORIZATION_PENDING: { message: 'PayPal has not confirmed every authorization yet.', action: 'Wait a moment; this page updates by itself.' },
  AUTHORIZATION_MISSING: { message: 'Not every payment has been approved with PayPal.', action: 'Approve each payment first.' },
  AUTHORIZATION_EXPIRED: { message: 'A PayPal authorization expired. No money was taken.', action: 'Re-plan or try another PayPal account.' },
  COMMITMENT_MISSING: { message: 'Not every supplier has confirmed yet.', action: 'Wait for the suppliers to confirm.' },
  PAYMENT_IN_PROGRESS: { message: 'A payment is in progress, so this request cannot be deleted yet.', action: 'Try again when the payment has finished.' },
  INVALID_STATE: { message: 'That step is not available right now.', action: 'Reload the page to see the current state.' },
  PROVIDER_ERROR: { message: 'PayPal refused the request.', action: 'Try again, or abandon the purchase.' },
  PROVIDER_UNAVAILABLE: { message: 'PayPal did not answer.', action: 'Try again in a moment.' },
  DB_BUSY: { message: 'The server is busy.', action: 'Try again in a moment.' },
  MODEL_BUDGET_EXHAUSTED: { message: 'Automatic reading is unavailable today.', action: 'Enter the details by hand.' },
  COMMITMENT_INVALID: { message: 'The confirmation does not cover the planned quantity or is later than the deadline.', action: 'Correct the bundles or the ready time.' },
  RESERVED_STOCK: { message: 'Stock cannot go below what is reserved.', action: 'Enter a higher quantity.' },
  RESET_BLOCKED: { message: 'A payment is still in progress, so the demo cannot be reset.', action: 'Wait, or force the reset with a reason.' },
  HANDOVER_BLOCKED: { message: 'This step is not allowed yet.', action: 'Check the order status first.' },
  ORDER_EXECUTED: { message: 'The buyer has already completed this purchase.', action: 'It can no longer be refused.' },
  FAULTS_UNAVAILABLE: { message: 'That fault only works with the simulated payment provider.', action: 'Choose another fault.' },
});

/**
 * describeError(err) -> { message, action, requestId, code, retryable, fields, linkHash }
 *   fields    [{field, rule}] from VALIDATION_FAILED / REQUIREMENTS_INCOMPLETE
 *   linkHash  an in-app link that helps (only for RESERVATION_LIMIT)
 */
export function describeError(err) {
  const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
  const guide = Object.hasOwn(GUIDE, code) ? GUIDE[code] : null;
  const fields = Array.isArray(err?.details?.fields)
    ? err.details.fields.filter((f) => f && typeof f.field === 'string').map((f) => ({ field: f.field, rule: String(f.rule ?? 'invalid') }))
    : [];
  return {
    code,
    message: guide ? guide.message : (typeof err?.message === 'string' && err.message ? err.message : 'Something went wrong.'),
    action: guide ? guide.action : 'Try again. If it keeps happening, quote the request id to the organiser.',
    requestId: typeof err?.requestId === 'string' ? err.requestId : null,
    retryable: ['CLIENT_TIMEOUT', 'NETWORK_ERROR', 'DB_BUSY', 'PROVIDER_UNAVAILABLE', 'INTERNAL', 'BAD_RESPONSE'].includes(code) ||
      (typeof err?.status === 'number' && err.status >= 500),
    fields,
    linkHash: code === 'RESERVATION_LIMIT' ? '#/requests' : null,
  };
}

export function fieldErrorMap(described) {
  const map = {};
  for (const { field, rule } of described.fields) {
    if (!Object.hasOwn(map, field)) map[field] = `${rule}`;
  }
  return map;
}
