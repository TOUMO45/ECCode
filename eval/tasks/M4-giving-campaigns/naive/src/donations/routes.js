'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('../campaigns/repository');
const { totals } = require('../campaigns/service');
const { MIN_CENTS, MAX_CENTS, creditedCents, price } = require('./service');

// Fields that contain a comma, a quote or a line break are quoted (RFC 4180).
const field = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const AMOUNT = /^\d+(\.\d{1,2})?$/;
const RECEIPT_HEADER = ['donation_id', 'date', 'donor', 'email', 'amount', 'fee', 'charged', 'matched'];

function register(router, { db, now }) {
  router.add('POST', '/api/campaigns/:id/donations', async (req, res, { params }) => {
    const campaign = repo.getCampaign(db, params.id);
    if (!campaign) return problem(res, 404, 'not_found', `Campaign ${params.id} not found`);
    const body = await readJson(req);
    const check = validate(body, {
      donorId: { type: 'integer', required: true, min: 1 },
      amount: { type: 'string', required: true, pattern: AMOUNT },
      coverFees: { type: 'boolean' },
      anonymous: { type: 'boolean' },
    });
    const fields = [...check.fields];
    if (!fields.includes('amount')) {
      const cents = money.fromDecimal(body.amount);
      if (cents < MIN_CENTS || cents > MAX_CENTS) fields.push('amount');
    }
    if (!fields.includes('donorId') && !repo.getDonor(db, body.donorId)) fields.push('donorId');
    if (fields.length) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields });

    const instant = now();
    const today = instant.toISOString().slice(0, 10);
    if (campaign.status !== 'live' || today < campaign.starts_on || today > campaign.ends_on) {
      return problem(res, 409, 'conflict', 'Campaign is not taking donations');
    }

    const t = totals(campaign, repo.donationsFor(db, campaign.id));
    const p = price({ amountCents: money.fromDecimal(body.amount), coverFees: body.coverFees === true, matchRemainingCents: t.matchRemainingCents });
    const d = repo.insertDonation(db, {
      campaignId: campaign.id,
      donorId: body.donorId,
      amountCents: money.fromDecimal(body.amount),
      feeCents: p.feeCents,
      covered: body.coverFees === true,
      matchedCents: p.matchedCents,
      anonymous: body.anonymous === true,
      createdAt: instant.toISOString(),
    });
    const out = {
      id: d.id,
      campaignId: campaign.id,
      donorId: d.donor_id,
      amount: money.toDecimal(d.amountCents),
      fee: money.toDecimal(d.feeCents),
      covered: d.covered,
      charged: money.toDecimal(p.chargedCents),
      credited: money.toDecimal(creditedCents(d)),
      matched: money.toDecimal(d.matchedCents),
      anonymous: d.anonymous,
      createdAt: d.created_at,
    };
    json(res, 201, out);
  });

  // Receipts for Finance's accounting system: every donation of a year, donors named even when anonymous publicly.
  router.add('GET', '/api/campaigns/:id/receipts.csv', async (req, res, { params, query }) => {
    const campaign = repo.getCampaign(db, params.id);
    if (!campaign) return problem(res, 404, 'not_found', `Campaign ${params.id} not found`);
    const year = query.get('year');
    if (!year || !/^\d{4}$/.test(year)) return problem(res, 422, 'validation_failed', 'year must look like 2026', { fields: ['year'] });
    const rows = repo
      .donationsFor(db, campaign.id)
      .filter((d) => d.created_at.slice(0, 4) === year)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
      .map((d) => {
        const donor = repo.getDonor(db, d.donor_id);
        return [
          d.id,
          d.created_at.slice(0, 10),
          donor.name,
          donor.email,
          money.toDecimal(d.amountCents),
          money.toDecimal(d.feeCents),
          money.toDecimal(d.covered ? d.amountCents + d.feeCents : d.amountCents),
          money.toDecimal(d.matchedCents),
        ];
      });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end([RECEIPT_HEADER, ...rows].map((r) => r.map(field).join(',')).join('\n') + '\n');
  });
}

module.exports = { register };
