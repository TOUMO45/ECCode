'use strict';
// Donation pricing: platform fee, what the campaign receives, and the sponsor match.
const money = require('../../vendor/acme-kit/money');

const MIN_CENTS = 500;
const MAX_CENTS = 1000000;
const FEE_BP = 290; // 2.9%
const FEE_FIXED_CENTS = 30;

/** Platform fee for a gift: 2.9% + 0.30, rounded half up. */
const feeCents = (amountCents) => money.percent(amountCents, FEE_BP) + FEE_FIXED_CENTS;

/** What the campaign receives from a donation (before any match). */
const creditedCents = (d) => (d.covered ? d.amountCents : d.amountCents - d.feeCents);

/** Price a new gift. */
function price({ amountCents, coverFees, matchRemainingCents }) {
  const fee = feeCents(amountCents);
  const credited = coverFees ? amountCents : amountCents - fee;
  return {
    feeCents: fee,
    chargedCents: coverFees ? amountCents + fee : amountCents,
    creditedCents: credited,
    matchedCents: Math.max(0, Math.min(credited, matchRemainingCents)),
  };
}

module.exports = { MIN_CENTS, MAX_CENTS, feeCents, creditedCents, price };
