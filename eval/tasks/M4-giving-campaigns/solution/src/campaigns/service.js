'use strict';
// Campaign progress.
const money = require('../../vendor/acme-kit/money');
const { creditedCents } = require('../donations/service');

/** Raised so far (credited plus matched), share of the goal, donors and what is left of the match. */
function totals(campaign, donations) {
  const matched = money.sum(donations.map((d) => d.matchedCents));
  const raised = money.sum(donations.map(creditedCents)) + matched;
  return {
    raisedCents: raised,
    percent: campaign.goalCents > 0 ? Math.floor((raised * 100) / campaign.goalCents) : 0,
    donorCount: new Set(donations.map((d) => d.donor_id)).size,
    matchRemainingCents: Math.max(0, campaign.matchCapCents - matched),
  };
}

/** The five latest donations, newest first; anonymous donors are hidden. */
function recent(donations, donorName) {
  return [...donations]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    .slice(0, 5)
    .map((d) => ({ donor: d.anonymous ? 'Anonymous' : donorName(d.donor_id), amount: money.toDecimal(d.amountCents), at: d.created_at }));
}

function viewCampaign(campaign, donations, donorName) {
  const t = totals(campaign, donations);
  const view = {
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
  if (donorName) {
    view.matchRemaining = money.toDecimal(t.matchRemainingCents);
    view.recent = recent(donations, donorName);
  }
  return view;
}

module.exports = { totals, viewCampaign };
