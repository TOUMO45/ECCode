'use strict';
// Data access for subscriptions. DECIMAL balances are converted to cents here.
const money = require('../../vendor/acme-kit/money');
const plans = require('../plans/repository');

const toSubscription = (r) =>
  r && {
    ...r,
    creditCents: money.fromDecimal(r.credit_balance),
    pendingCents: money.fromDecimal(r.pending_charge),
  };

function getSubscription(db, id) {
  return toSubscription(db.get('subscriptions', id));
}

function getAccount(db, id) {
  return db.get('accounts', id);
}

function planOf(db, subscription) {
  return plans.getPlan(db, subscription.plan_id);
}

/** Patch a subscription; cent balances are written back as DECIMAL strings. */
function updateSubscription(db, id, patch) {
  const { creditCents, pendingCents, ...rest } = patch;
  const row = { ...rest };
  if (creditCents !== undefined) row.credit_balance = money.toDecimal(creditCents);
  if (pendingCents !== undefined) row.pending_charge = money.toDecimal(pendingCents);
  return toSubscription(db.update('subscriptions', id, row));
}

module.exports = { getSubscription, getAccount, planOf, updateSubscription, getPlanByCode: plans.getPlanByCode };
