// Wilson score interval for a binomial proportion (95% by default).
export function wilson(k, n, z = 1.959964) {
  if (!Number.isInteger(n) || n <= 0 || !Number.isInteger(k) || k < 0 || k > n) return { rate: null, lo: null, hi: null, k, n };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), k, n };
}

/** True when two intervals overlap, so the difference is "not distinguishable". */
export function overlaps(a, b) {
  if (a.lo === null || b.lo === null) return true;
  return a.lo <= b.hi && b.lo <= a.hi;
}
