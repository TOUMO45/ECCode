'use strict';
// Data access for campaigns and their donations. DECIMAL columns are converted to cents here.
const money = require('../../vendor/acme-kit/money');

const toCampaign = (r) => r && { ...r, goalCents: money.fromDecimal(r.goal), matchCapCents: money.fromDecimal(r.match_cap) };

const toDonation = (r) => ({
  ...r,
  amountCents: money.fromDecimal(r.amount),
  feeCents: money.fromDecimal(r.fee),
  matchedCents: money.fromDecimal(r.matched),
});

function listCampaigns(db) {
  return db.all('campaigns').map(toCampaign);
}

function getCampaign(db, id) {
  return toCampaign(db.get('campaigns', id));
}

/** A campaign's donations, oldest first. */
function donationsFor(db, campaignId) {
  return db.all('donations', { campaign_id: Number(campaignId) }).map(toDonation);
}

module.exports = { listCampaigns, getCampaign, donationsFor };
