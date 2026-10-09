// Error catalog, AppError and the response senders.
// Every non-2xx JSON response has the one shape
//   {"error":{"code","message","requestId","details"?}}
// `message` is fixed English text per code and never echoes input. `details`
// holds only ids, codes and server-derived values.

export const ERRORS = Object.freeze({
  INVALID_JSON: [400, 'The request body is not valid JSON.'],
  BAD_REQUEST: [400, 'The request is malformed.'],
  IDEMPOTENCY_KEY_REQUIRED: [400, 'An Idempotency-Key header is required.'],
  WEBHOOK_SIGNATURE_INVALID: [400, 'The webhook signature is invalid or missing.'],
  UNAUTHENTICATED: [401, 'Sign in to continue.'],
  INVALID_CREDENTIALS: [401, 'The username or password is incorrect.'],
  FORBIDDEN: [403, 'You are not allowed to do this.'],
  CSRF_FAILED: [403, 'The request could not be verified.'],
  SIGNUP_DISABLED: [403, 'Registration is turned off.'],
  NOT_FOUND: [404, 'Not found.'],
  METHOD_NOT_ALLOWED: [405, 'This method is not allowed here.'],
  PLAN_CHANGED: [409, 'The plan changed. Review the new plan.'],
  PLAN_SUPERSEDED: [409, 'This plan version was superseded.'],
  PLAN_NOT_EXECUTABLE: [409, 'This plan version can no longer be executed.'],
  PLAN_INVALID: [409, 'The stored plan failed validation.'],
  PLAN_IN_PROGRESS: [409, 'A plan version already holds a live reservation.'],
  MISSING_BUDGET: [409, 'A budget is required.'],
  MISSING_DEADLINE: [409, 'A deadline is required.'],
  OUT_OF_STOCK: [409, 'The stock is no longer available.'],
  ALREADY_RESERVED: [409, 'This plan is already reserved.'],
  RESERVATION_LIMIT: [409, 'The reservation limit for this account is reached.'],
  RESERVATION_EXPIRED: [409, 'The reservation expired.'],
  AUTHORIZATION_PENDING: [409, 'A payment authorization is still pending.'],
  AUTHORIZATION_MISSING: [409, 'A payment authorization is missing.'],
  AUTHORIZATION_EXPIRED: [409, 'A payment authorization expired.'],
  COMMITMENT_MISSING: [409, 'A supplier order is not confirmed.'],
  ORDER_EXECUTED: [409, 'The supplier refused after execution started.'],
  HANDOVER_BLOCKED: [409, 'Handover is not possible in this state.'],
  RESERVED_STOCK: [409, 'The change would drop stock below the reserved quantity.'],
  PAYMENT_IN_PROGRESS: [409, 'A payment is in progress.'],
  RESET_BLOCKED: [409, 'The reset is blocked by payments that hold money.'],
  INVALID_STATE: [409, 'This transition is not allowed in the current state.'],
  USERNAME_TAKEN: [409, 'That username is taken.'],
  FAULTS_UNAVAILABLE: [409, 'Fault injection is unavailable with a real payment adapter.'],
  PAYLOAD_TOO_LARGE: [413, 'The request body is too large.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'The media type is not supported.'],
  MISDIRECTED_REQUEST: [421, 'This host is not served here.'],
  VALIDATION_FAILED: [422, 'The request failed validation.'],
  IDEMPOTENCY_KEY_REUSED: [422, 'The Idempotency-Key was used for a different request.'],
  COMMITMENT_INVALID: [422, 'The commitment is invalid.'],
  REQUIREMENTS_INCOMPLETE: [422, 'The requirements are incomplete.'],
  RATE_LIMITED: [429, 'Too many requests. Try again later.'],
  INTERNAL: [500, 'Something went wrong on the server.'],
  PROVIDER_ERROR: [502, 'The payment provider rejected the request.'],
  DB_BUSY: [503, 'The database is busy. Try again.'],
  MODEL_BUDGET_EXHAUSTED: [503, 'The daily model budget is used up.'],
  PROVIDER_UNAVAILABLE: [503, 'The provider is unavailable. Try again later.'],
});

export class AppError extends Error {
  // new AppError(409, 'INVALID_STATE', { details: {from, to}, headers: {'Retry-After': '1'} })
  // The domain-style call new AppError(status, code, message, details) also works; the
  // message is ignored because the text always comes from the catalog.
  constructor(status, code, third, fourth) {
    const entry = ERRORS[code];
    if (!entry) throw new TypeError(`Unknown error code: ${String(code)}`);
    super(entry[1]);
    const { details, headers } = typeof third === 'string' ? { details: fourth } : third || {};
    this.name = 'AppError';
    this.status = Number.isInteger(status) ? status : entry[0];
    this.code = code;
    this.details = details === undefined ? undefined : details;
    this.headers = headers === undefined ? undefined : { ...headers };
  }
}

// src/domain defines its own AppError class (it imports nothing outside domain/).
// The HTTP layer recognises it by duck typing: name 'AppError', an integer status
// and a code that is in the catalog. It is rebuilt as this module's AppError, so the
// message is the catalog text and only a plain-object `details` is carried over.
export function adoptAppError(err) {
  if (err instanceof AppError) return err;
  if (!err || err.name !== 'AppError' || !Number.isInteger(err.status) || err.status < 400 || err.status > 599) return null;
  if (typeof err.code !== 'string' || !Object.prototype.hasOwnProperty.call(ERRORS, err.code)) return null;
  const plain = err.details !== null && typeof err.details === 'object' && !Array.isArray(err.details);
  const headers = err.headers !== null && typeof err.headers === 'object' ? err.headers : undefined;
  return new AppError(err.status, err.code, { details: plain ? err.details : undefined, headers });
}

// Builds an AppError with the catalog's own status.
export function appError(code, opts) {
  const entry = ERRORS[code];
  if (!entry) throw new TypeError(`Unknown error code: ${String(code)}`);
  return new AppError(entry[0], code, opts);
}

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function writeHead(res, status, headers) {
  if (res.headersSent || res.writableEnded) return false;
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers || {})) {
    if (value !== undefined && value !== null) res.setHeader(name, value);
  }
  return true;
}

// Sends a JSON body. On success the body gets a top-level requestId.
export function sendJson(res, status, body, { requestId, headers } = {}) {
  const payload =
    body !== null && typeof body === 'object' && !Array.isArray(body) && requestId !== undefined
      ? { ...body, requestId }
      : body;
  const text = JSON.stringify(payload === undefined ? null : payload);
  if (!writeHead(res, status, headers)) return;
  res.setHeader('Content-Type', JSON_CONTENT_TYPE);
  res.setHeader('Content-Length', Buffer.byteLength(text, 'utf8'));
  res.end(text);
}

export function errorBody(err, requestId) {
  const error = { code: err.code, message: err.message, requestId };
  if (err.details !== undefined) error.details = err.details;
  return { error };
}

export function sendError(res, err, requestId, { headers } = {}) {
  const merged = { ...(err.headers || {}), ...(headers || {}) };
  const text = JSON.stringify(errorBody(err, requestId));
  if (!writeHead(res, err.status, merged)) return;
  res.setHeader('Content-Type', JSON_CONTENT_TYPE);
  res.setHeader('Content-Length', Buffer.byteLength(text, 'utf8'));
  res.end(text);
}
