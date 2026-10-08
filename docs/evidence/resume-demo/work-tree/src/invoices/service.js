'use strict';
// Invoice totals shown by the API. All arithmetic is in integer cents.
const money = require('../../vendor/acme-kit/money');

/** invoice.shipping_fee and lines[].unit_price are integer cents (see repository). */
function computeTotals(invoice, lines) {
  const items = lines.map((l) => ({
    description: l.description,
    unitPrice: money.toDecimal(l.unit_price),
    quantity: l.quantity,
    lineTotal: money.toDecimal(l.unit_price * l.quantity),
  }));
  const subtotal = money.sum(lines.map((l) => l.unit_price * l.quantity));
  const discount = money.percent(subtotal, invoice.discount_bp || 0);
  const shipping = invoice.shipping_fee || 0;
  const total = subtotal - discount + shipping;
  return {
    lines: items,
    subtotal: money.toDecimal(subtotal),
    discount: money.toDecimal(discount),
    shipping: money.toDecimal(shipping),
    total: money.toDecimal(total),
  };
}

module.exports = { computeTotals };
