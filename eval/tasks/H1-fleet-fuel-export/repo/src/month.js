'use strict';
// Calendar months in UTC, written as YYYY-MM.

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** parseMonth('2026-09') -> { month, start, end } (ISO timestamps, end exclusive) or null. */
function parseMonth(value) {
  const m = MONTH.exec(value || '');
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return {
    month: value,
    start: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    end: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
}

module.exports = { parseMonth };
