'use strict';

/** Whole days from day `a` to day `b` (both YYYY-MM-DD); negative when b is earlier. */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

module.exports = { daysBetween };
