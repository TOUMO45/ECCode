'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('../couriers/repository');
const { balanceCents } = require('../couriers/balance');

const AMOUNT = /^\d+(\.\d{1,2})?$/;
const INSTANT_FEE_BP = 150; // 1.5%

function view(p) {
  return {
    id: p.id,
    courierId: p.courierId,
    kind: p.kind,
    amount: money.toDecimal(p.amountCents),
    fee: money.toDecimal(p.feeCents),
    net: money.toDecimal(p.amountCents - p.feeCents),
    createdAt: p.createdAt,
  };
}

function register(router, db) {
  router.add('GET', '/api/payouts/:id', async (req, res, { params }) => {
    const p = repo.getPayout(db, params.id);
    if (!p) return problem(res, 404, 'not_found', `Payout ${params.id} not found`);
    json(res, 200, view(p));
  });

  router.add('POST', '/api/couriers/:id/payouts', async (req, res, { params }) => {
    const courier = repo.getCourier(db, params.id);
    if (!courier) return problem(res, 404, 'not_found', `Courier ${params.id} not found`);
    const body = await readJson(req);
    const check = validate(body, { amount: { type: 'string', required: true, pattern: AMOUNT } });
    if (!check.ok) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields: check.fields });
    const amountCents = money.fromDecimal(body.amount);
    if (amountCents <= 0) return problem(res, 422, 'validation_failed', 'Amount must be positive', { fields: ['amount'] });
    if (amountCents > balanceCents(db, courier.id)) return problem(res, 422, 'validation_failed', 'Amount exceeds the balance', { fields: ['amount'] });
    const feeCents = money.percent(amountCents, INSTANT_FEE_BP);
    const p = repo.insertPayout(db, { courierId: courier.id, kind: 'instant', amountCents, feeCents });
    json(res, 201, { id: p.id, courierId: p.courierId, amount: money.toDecimal(p.amountCents), fee: money.toDecimal(p.feeCents), net: money.toDecimal(p.amountCents - p.feeCents) });
  });
}

module.exports = { register, view };
