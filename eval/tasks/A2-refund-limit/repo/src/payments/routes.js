'use strict';
const { json, problem, readJson, validate, HttpError } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

const AMOUNT = /^\d+(\.\d{1,2})?$/;

function view(db, p) {
  const refunded = repo.refundsFor(db, p.id).reduce((sum, r) => sum + r.amount, 0);
  return { id: p.id, orderRef: p.order_ref, currency: p.currency, amount: p.amount, refunded: String(refunded === 0 ? '0.00' : refunded), refundable: (p.amount - refunded).toFixed(2) };
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
    if (Number(body.amount) <= 0) return problem(res, 422, 'validation_failed', 'Refund must be positive', { fields: ['amount'] });
    const refundedSoFar = repo.refundsFor(db, p.id).reduce((sum, r) => sum + Number(r.amount), 0);
    const refundable = p.amount - refundedSoFar;
    if (body.amount > p.amount || Number(body.amount) > refundable) {
      throw new HttpError(422, 'validation_failed', 'Refund exceeds the refundable amount', { fields: ['amount'] });
    }
    const r = repo.addRefund(db, p.id, body.amount);
    json(res, 201, { id: r.id, paymentId: p.id, amount: r.amount });
  });
}

module.exports = { register };
