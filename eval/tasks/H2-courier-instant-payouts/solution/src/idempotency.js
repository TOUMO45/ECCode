'use strict';
// Remembers the response to a money-moving request per Idempotency-Key, so a
// retried request gets the original answer instead of moving money twice.

function createIdempotencyStore() {
  const responses = new Map();
  return {
    keyFor(req, scope) {
      const key = req.headers['idempotency-key'];
      return key ? `${scope}|${key}` : null;
    },
    get: (k) => (k ? responses.get(k) : undefined),
    set(k, status, body) {
      if (k) responses.set(k, { status, body });
    },
  };
}

module.exports = { createIdempotencyStore };
