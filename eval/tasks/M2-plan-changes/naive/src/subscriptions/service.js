'use strict';
// Subscription view and proration.
const money = require('../../vendor/acme-kit/money');
const { localDay, daysBetween } = require('../lib/dates');

/** The account-local calendar day for `instant`. */
function today(account, instant) {
  return localDay(instant, account.timezone);
}

function viewSubscription(sub, { account, plan, day }) {
  return {
    id: sub.id,
    account: { id: account.id, name: account.name },
    plan: { code: plan.code, name: plan.name, pricePerSeat: money.toDecimal(plan.priceCents) },
    seats: sub.seats,
    status: sub.status,
    cycleStart: sub.cycle_start,
    cycleEnd: sub.cycle_end,
    daysLeft: sub.status === 'cancelled' ? 0 : Math.max(0, daysBetween(day, sub.cycle_end)),
    monthlyCost: money.toDecimal(plan.priceCents * sub.seats),
    creditBalance: money.toDecimal(sub.creditCents),
    pendingCharge: money.toDecimal(sub.pendingCents),
  };
}

/** Share of an amount for the days left in the cycle, via the kit's basis-point helper. */
function prorate(cents, remaining, cycleDays) {
  return money.percent(cents, Math.round((remaining / cycleDays) * 10000));
}

/** Days left in the cycle counting `day` itself, and the real length of the cycle. */
function cycleDays(sub, day) {
  const length = daysBetween(sub.cycle_start, sub.cycle_end);
  return { length, remaining: Math.min(length, Math.max(0, daysBetween(day, sub.cycle_end))) };
}

/** Proration for moving `sub` (on `plan`) to `newPlan` with `seats`, effective on `day`. Trials are free. */
function quote(sub, { plan, newPlan, seats, day }) {
  const { length, remaining } = cycleDays(sub, day);
  if (sub.status === 'trialing') return { remainingDays: remaining, cycleDays: length, credit: 0, charge: 0, net: 0 };
  const credit = prorate(plan.priceCents * sub.seats, remaining, length);
  const charge = prorate(newPlan.priceCents * seats, remaining, length);
  return { remainingDays: remaining, cycleDays: length, credit, charge, net: charge - credit };
}

/** Unused value of the current plan, handed back on cancellation. Trials get nothing. */
function refundFor(sub, { plan, day }) {
  if (sub.status === 'trialing') return 0;
  const { length, remaining } = cycleDays(sub, day);
  return prorate(plan.priceCents * sub.seats, remaining, length);
}

function viewQuote(q) {
  return { remainingDays: q.remainingDays, cycleDays: q.cycleDays, credit: money.toDecimal(q.credit), charge: money.toDecimal(q.charge), net: money.toDecimal(q.net) };
}

module.exports = { today, viewSubscription, prorate, quote, refundFor, viewQuote };
