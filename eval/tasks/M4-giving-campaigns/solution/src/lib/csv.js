'use strict';

/** A text field: always wrapped in double quotes, embedded quotes doubled. */
const text = (v) => `"${String(v).replace(/"/g, '""')}"`;

/** Join already-formatted fields into CSV text with CRLF line endings. */
function toCsv(headerFields, rows) {
  return [headerFields, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}

module.exports = { text, toCsv };
