'use strict';
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');

/** Earnings not paid out yet, in cents. */
function balanceCents(db, courierId) {
  const earned = money.sum(repo.earningsFor(db, courierId).map((e) => e.amountCents));
  const paid = money.sum(repo.payoutsFor(db, courierId).map((p) => p.amountCents));
  return earned - paid;
}

module.exports = { balanceCents };
