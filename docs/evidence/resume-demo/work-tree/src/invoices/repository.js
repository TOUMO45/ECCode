'use strict';
// Data access for invoices. DECIMAL strings are converted to integer cents
// here, at the repository boundary; everything above works in cents.
const money = require('../../vendor/acme-kit/money');

function toInvoice(row) {
  if (!row) return row;
  return { ...row, shipping_fee: row.shipping_fee == null ? 0 : money.fromDecimal(row.shipping_fee) };
}

function listInvoices(db) {
  return db.all('invoices').map(toInvoice);
}

function getInvoice(db, id) {
  return toInvoice(db.get('invoices', id));
}

function linesFor(db, invoiceId) {
  return db.all('invoice_lines', { invoice_id: Number(invoiceId) }).map((l) => ({
    ...l,
    unit_price: money.fromDecimal(l.unit_price),
  }));
}

module.exports = { listInvoices, getInvoice, linesFor };
