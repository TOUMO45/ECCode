'use strict';

/** Calendar day (YYYY-MM-DD) of an instant in an IANA time zone. */
function localDay(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Whole days from day `a` to day `b` (both YYYY-MM-DD); negative when b is earlier. */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

module.exports = { localDay, daysBetween };
