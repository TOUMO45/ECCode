'use strict';
// Timing helpers shared by the scheduler and the job dashboard.

/** Milliseconds per unit. */
const UNITS = { h: 3600000, m: 60000, s: 1000 };

/** Milliseconds as a short label, largest units first ("1h 5m 10s"; "0s" for zero). */
function formatDuration(ms) {
  const parts = [];
  let rest = Math.max(0, Math.floor(ms / 1000)) * 1000;
  for (const [unit, size] of Object.entries(UNITS)) {
    const n = Math.floor(rest / size);
    if (n) parts.push(`${n}${unit}`);
    rest -= n * size;
  }
  return parts.join(' ') || '0s';
}

module.exports = { UNITS, formatDuration };
