'use strict';
// acme-kit/cache: small in-process caches.
//
// memo(fn, { ttlMs, key }) caches results of fn. The cache key is computed by
// `key(...args)`; the DEFAULT key is JSON.stringify(args[0]) - the FIRST
// argument only (see README "Caveats"). Functions with more than one argument
// that affects the result must pass an explicit `key`.
//
// ttlCache({ ttlMs }) is a plain key/value cache with get/set/invalidate.

function memo(fn, { ttlMs = 60000, key = (...args) => JSON.stringify(args[0]), now = Date.now } = {}) {
  const entries = new Map();
  const wrapped = function memoized(...args) {
    const k = key(...args);
    const hit = entries.get(k);
    const t = now();
    if (hit && hit.expires > t) return hit.value;
    const value = fn.apply(this, args);
    entries.set(k, { value, expires: t + ttlMs });
    return value;
  };
  wrapped.clear = () => entries.clear();
  wrapped.size = () => entries.size;
  return wrapped;
}

function ttlCache({ ttlMs = 60000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(k) {
      const hit = entries.get(k);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        entries.delete(k);
        return undefined;
      }
      return hit.value;
    },
    set(k, value) {
      entries.set(k, { value, expires: now() + ttlMs });
      return value;
    },
    invalidate(k) {
      return entries.delete(k);
    },
    clear() {
      entries.clear();
    },
  };
}

module.exports = { memo, ttlCache };
