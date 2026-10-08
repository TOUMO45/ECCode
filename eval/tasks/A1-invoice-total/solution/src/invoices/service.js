'use strict';
// Invoice totals shown by the API, computed in integer cents.
const money = require('../../vendor/acme-kit/money');

function computeTotals(invoice, lines) {
  const items = lines.map((l) => ({
    description: l.description,
    unitPrice: money.toDecimal(l.unitPriceCents),
    quantity: l.quantity,
    lineTotal: money.toDecimal(l.unitPriceCents * l.quantity),
  }));
  const subtotal = money.sum(lines.map((l) => l.unitPriceCents * l.quantity));
  const discount = money.percent(subtotal, invoice.discount_bp);
  const total = subtotal - discount + invoice.shippingCents;
  return {
    lines: items,
    subtotal: money.toDecimal(subtotal),
    discount: money.toDecimal(discount),
    shipping: money.toDecimal(invoice.shippingCents),
    total: money.toDecimal(total),
  };
}

module.exports = { computeTotals };
