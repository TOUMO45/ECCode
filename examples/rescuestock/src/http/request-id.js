// X-Request-Id: accept an inbound id matching the pattern, otherwise generate
// 16 random bytes as base64url. The base64url underscore is replaced with a
// hyphen so a generated id always satisfies the accepted pattern.
import { randomBytes } from 'node:crypto';

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export function newRequestId() {
  return randomBytes(16).toString('base64url').replace(/_/g, '-');
}

export function resolveRequestId(headerValue) {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : newRequestId();
}
