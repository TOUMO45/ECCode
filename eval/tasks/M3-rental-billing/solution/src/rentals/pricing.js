'use strict';
// What a rental costs, in integer cents.
const money = require('../../vendor/acme-kit/money');
const { daysBetween } = require('../lib/dates');

const LATE_FEE_BP = 15000; // 150% of the daily rate per late day

const ZERO = { days: 0, lateDays: 0, rental: 0, lateFee: 0, subtotal: 0, tax: 0, total: 0 };

function chargeFor(rental, { item, taxBp, taxExempt }) {
  if (rental.status === 'cancelled') return { ...ZERO, deposit: item.depositCents };
  const returned = rental.returned_on;
  const billedUntil = returned && returned < rental.due_date ? returned : rental.due_date;
  const days = Math.max(1, daysBetween(rental.start_date, billedUntil));
  const weeks = Math.floor(days / 7);
  const rest = days % 7;
  const base = weeks * item.weeklyCents + Math.min(rest * item.dailyCents, item.weeklyCents);
  const lateDays = returned && returned > rental.due_date ? daysBetween(rental.due_date, returned) : 0;
  const lateFee = money.percent(lateDays * item.dailyCents, LATE_FEE_BP);
  const subtotal = money.sum([base, lateFee]);
  const tax = taxExempt ? 0 : money.percent(subtotal, taxBp);
  return { days, lateDays, rental: base, lateFee, subtotal, tax, total: subtotal + tax, deposit: item.depositCents };
}

module.exports = { chargeFor };
