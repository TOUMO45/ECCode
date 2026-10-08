'use strict';

const keyOf = (req) => {
  const k = req.headers['idempotency-key'];
  return k ? `${req.method} ${req.url.split('?')[0]} ${k}` : null;
};

/** In-process replay store for the Idempotency-Key header (one per app instance). */
function createIdempotency() {
  const seen = new Map();
  return {
    /** The stored { status, body } if this key was already used on this endpoint. */
    lookup(req) {
      const k = keyOf(req);
      return k ? seen.get(k) : undefined;
    },
    store(req, status, body) {
      const k = keyOf(req);
      if (k) seen.set(k, { status, body });
    },
  };
}

module.exports = { createIdempotency };
