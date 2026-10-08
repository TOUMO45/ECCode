'use strict';
// Data access for invoices.

function listInvoices(db) {
  return db.all('invoices');
}

function getInvoice(db, id) {
  return db.get('invoices', id);
}

function linesFor(db, invoiceId) {
  return db.all('invoice_lines', { invoice_id: Number(invoiceId) });
}

module.exports = { listInvoices, getInvoice, linesFor };
