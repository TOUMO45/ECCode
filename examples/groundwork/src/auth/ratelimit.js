// Login limiter (spec 3.2): sliding window of failures per key, bounded map.
export function createLoginLimiter({ clock = Date.now, max = 5, windowMs = 15 * 60 * 1000, maxKeys = 10000 } = {}) {
  // Map keeps recency order: updated keys are re-inserted at the end.
  const entries = new Map(); // key -> number[] (failure timestamps, ascending)

  const live = (arr, now) => arr.filter((t) => now - t < windowMs);

  function sweep(now) {
    // Front of the map = least recently updated; drop expired ones.
    for (const [k, arr] of entries) {
      if (arr.length && now - arr[arr.length - 1] < windowMs) break;
      entries.delete(k);
    }
  }

  return {
    /** @returns {{limited:boolean, retryAfterSeconds?:number}} */
    check(key) {
      const now = clock();
      const arr = entries.get(key);
      if (!arr) return { limited: false };
      const l = live(arr, now);
      if (l.length === 0) { entries.delete(key); return { limited: false }; }
      if (l.length >= max) {
        const wait = l[l.length - max] + windowMs - now;
        return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
      }
      return { limited: false };
    },
    /** Record a failure; returns the number of live failures. */
    fail(key) {
      const now = clock();
      sweep(now);
      const prev = entries.get(key);
      const l = prev ? live(prev, now) : [];
      l.push(now);
      if (l.length > max) l.splice(0, l.length - max); // memory per key bounded
      entries.delete(key);
      entries.set(key, l);
      while (entries.size > maxKeys) entries.delete(entries.keys().next().value);
      return l.length;
    },
    clear(key) { entries.delete(key); },
    get size() { return entries.size; },
  };
}
