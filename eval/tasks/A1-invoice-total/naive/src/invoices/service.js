'use strict';
// Invoice totals shown by the API.

const amount = (n) => Number(n).toFixed(2);

function computeTotals(invoice, lines) {
  const items = lines.map((l) => ({
    description: l.description,
    unitPrice: l.unit_price,
    quantity: l.quantity,
    lineTotal: amount(Number(l.unit_price) * l.quantity),
  }));
  const subtotal = lines.reduce((sum, l) => sum + Number(l.unit_price) * l.quantity, 0);
  const discount = (subtotal * invoice.discount_bp) / 10000;
  const shipping = Number(invoice.shipping_fee || 0);
  const total = subtotal - discount + shipping;
  return { lines: items, subtotal: amount(subtotal), discount: amount(discount), shipping: amount(shipping), total: amount(total) };
}

module.exports = { computeTotals };
