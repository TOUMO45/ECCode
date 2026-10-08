'use strict';
// Campaign progress.
const money = require('../../vendor/acme-kit/money');

/** Raised so far, share of the goal and number of distinct donors. */
function totals(campaign, donations) {
  const raised = money.sum(donations.map((d) => d.amountCents));
  return {
    raisedCents: raised,
    percent: campaign.goalCents > 0 ? Math.floor((raised * 100) / campaign.goalCents) : 0,
    donorCount: new Set(donations.map((d) => d.donor_id)).size,
  };
}

function viewCampaign(campaign, donations) {
  const t = totals(campaign, donations);
  return {
    id: campaign.id,
    slug: campaign.slug,
    title: campaign.title,
    status: campaign.status,
    goal: money.toDecimal(campaign.goalCents),
    raised: money.toDecimal(t.raisedCents),
    percent: t.percent,
    donorCount: t.donorCount,
    endsOn: campaign.ends_on,
  };
}

module.exports = { totals, viewCampaign };
