'use strict';
// Data access for campaigns and their donations. DECIMAL columns are converted to cents here.
const money = require('../../vendor/acme-kit/money');

const toCampaign = (r) => r && { ...r, goalCents: money.fromDecimal(r.goal), matchCapCents: money.fromDecimal(r.match_cap) };

const toDonation = (r) =>
  r && {
    ...r,
    amountCents: money.fromDecimal(r.amount),
    feeCents: money.fromDecimal(r.fee),
    matchedCents: money.fromDecimal(r.matched),
  };

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

function getDonor(db, id) {
  return db.get('donors', id);
}

/** Insert a donation; money arrives in cents and is stored as DECIMAL. */
function insertDonation(db, v) {
  return toDonation(
    db.insert('donations', {
      campaign_id: v.campaignId,
      donor_id: v.donorId,
      amount: money.toDecimal(v.amountCents),
      fee: money.toDecimal(v.feeCents),
      covered: v.covered,
      matched: money.toDecimal(v.matchedCents),
      anonymous: v.anonymous,
      created_at: v.createdAt,
    })
  );
}

module.exports = { listCampaigns, getCampaign, donationsFor, getDonor, insertDonation };
