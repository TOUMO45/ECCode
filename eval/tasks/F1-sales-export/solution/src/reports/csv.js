'use strict';
// The sales report as CSV for accounting's import: CRLF line endings, a
// header row, every text field in double quotes (embedded quotes doubled) and
// amounts as plain decimals with two digits.
const money = require('../../vendor/acme-kit/money');

const text = (v) => `"${String(v).replace(/"/g, '""')}"`;
const line = (fields) => `${fields.join(',')}\r\n`;

/** report: salesReport() output (amounts in cents). */
function salesCsv(report) {
  const out = [line(['order_number', 'customer', 'placed_on', 'total'].map(text))];
  for (const o of report.orders) {
    out.push(line([text(o.number), text(o.customer), text(o.placedAt.slice(0, 10)), money.toDecimal(o.totalCents)]));
  }
  out.push(line([text('TOTAL'), text(''), text(''), money.toDecimal(report.totalCents)]));
  return out.join('');
}

module.exports = { salesCsv };
