'use strict';
const { json, problem, readJson, validate, HttpError } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');

const AMOUNT = /^\d+(\.\d{1,2})?$/;

function balances(db, p) {
  const refunded = money.sum(repo.refundsFor(db, p.id).map((r) => r.amountCents));
  return { refunded, refundable: p.amountCents - refunded };
}

function view(db, p) {
  const b = balances(db, p);
  return { id: p.id, orderRef: p.order_ref, currency: p.currency, amount: money.toDecimal(p.amountCents), refunded: money.toDecimal(b.refunded), refundable: money.toDecimal(b.refundable) };
}

function register(router, db) {
  router.add('GET', '/api/payments/:id', async (req, res, { params }) => {
    const p = repo.getPayment(db, params.id);
    if (!p) return problem(res, 404, 'not_found', `Payment ${params.id} not found`);
    json(res, 200, view(db, p));
  });

  router.add('POST', '/api/payments/:id/refunds', async (req, res, { params }) => {
    const p = repo.getPayment(db, params.id);
    if (!p) return problem(res, 404, 'not_found', `Payment ${params.id} not found`);
    const body = await readJson(req);
    const check = validate(body, { amount: { type: 'string', required: true, pattern: AMOUNT } });
    if (!check.ok) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields: check.fields });
    const cents = money.fromDecimal(body.amount);
    if (cents <= 0) return problem(res, 422, 'validation_failed', 'Refund must be positive', { fields: ['amount'] });
    if (cents > balances(db, p).refundable) {
      throw new HttpError(422, 'validation_failed', 'Refund exceeds the refundable amount', { fields: ['amount'] });
    }
    const r = repo.addRefund(db, p.id, cents);
    json(res, 201, { id: r.id, paymentId: p.id, amount: money.toDecimal(r.amountCents) });
  });
}

module.exports = { register };
