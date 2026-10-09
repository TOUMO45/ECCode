// Single error envelope (spec 3.1). Messages are fixed per code and never
// derived from exception text, input, SQL or paths.
import { ERRORS } from '../api/contract-schemas.js';

export class ApiError extends Error {
  /**
   * @param {string} code key of ERRORS
   * @param {object} [opts] { details, headers }
   */
  constructor(code, { details, headers } = {}) {
    super(code);
    if (!Object.hasOwn(ERRORS, code)) throw new TypeError(`unknown error code ${code}`);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERRORS[code].status;
    this.details = details;
    this.headers = headers;
  }
}

export function errorBody(code, requestId, details) {
  const error = { code, message: ERRORS[code].message, requestId };
  if (details !== undefined) error.details = details;
  return { error };
}

/** Write a JSON response. Idempotent against double writes. */
export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', payload.length);
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

export function sendError(res, requestId, err) {
  const e = err instanceof ApiError ? err : new ApiError('INTERNAL');
  sendJson(res, e.status, errorBody(e.code, requestId, e.details), e.headers || {});
  return e;
}
