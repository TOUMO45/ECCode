'use strict';
// Data access for invoices. DECIMAL columns are converted to integer cents here.
const money = require('../../vendor/acme-kit/money');

const toInvoice = (r) => r && { ...r, shippingCents: r.shipping_fee === null ? 0 : money.fromDecimal(r.shipping_fee) };
const toLine = (r) => ({ ...r, unitPriceCents: money.fromDecimal(r.unit_price) });

function listInvoices(db) {
  return db.all('invoices').map(toInvoice);
}

function getInvoice(db, id) {
  return toInvoice(db.get('invoices', id));
}

function linesFor(db, invoiceId) {
  return db.all('invoice_lines', { invoice_id: Number(invoiceId) }).map(toLine);
}

module.exports = { listInvoices, getInvoice, linesFor };
