'use strict';
// Formatting helpers shared by the reports UI.

/** "3 items", "1 item" */
function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

module.exports = { plural, formatDate };
