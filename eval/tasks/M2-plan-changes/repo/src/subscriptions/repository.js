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

module.exports = { getSubscription, getAccount, planOf };
