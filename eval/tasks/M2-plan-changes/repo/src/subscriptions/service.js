'use strict';
// Subscription view.
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

module.exports = { today, viewSubscription };
