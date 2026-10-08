'use strict';
// Invoice totals shown by the API.

const amount = (n) => (typeof n === 'number' ? n.toFixed(2) : String(n));

function computeTotals(invoice, lines) {
  const items = lines.map((l) => ({
    description: l.description,
    unitPrice: l.unit_price,
    quantity: l.quantity,
    lineTotal: amount(l.unit_price * l.quantity),
  }));
  const subtotal = lines.reduce((sum, l) => sum + l.unit_price * l.quantity, 0);
  const discount = (subtotal * invoice.discount_bp) / 10000;
  const shipping = invoice.shipping_fee || 0;
  const total = subtotal - discount + shipping;
  return {
    lines: items,
    subtotal: amount(subtotal),
    discount: amount(discount),
    shipping: amount(Number(shipping)),
    total: amount(total),
  };
}

module.exports = { computeTotals };
