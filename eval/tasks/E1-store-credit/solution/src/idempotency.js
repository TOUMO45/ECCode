'use strict';
// Idempotency-Key support for POST endpoints that move money: a repeated
// request with the same key gets the original status and body, nothing new
// is created. Requests without the header are handled normally.
const { json } = require('../vendor/acme-kit/http');
const { ttlCache } = require('../vendor/acme-kit/cache');

function createIdempotency({ ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  const seen = ttlCache({ ttlMs });
  return {
    /** handler() resolves to { status, body }; successful results are remembered per key. */
    async respond(req, res, handler) {
      const key = req.headers['idempotency-key'];
      const scope = key && `${req.method} ${new URL(req.url, 'http://localhost').pathname} ${key}`;
      const hit = scope && seen.get(scope);
      if (hit) return json(res, hit.status, hit.body);
      const result = await handler();
      if (scope && result.status < 400) seen.set(scope, result);
      return json(res, result.status, result.body);
    },
  };
}

module.exports = { createIdempotency };
