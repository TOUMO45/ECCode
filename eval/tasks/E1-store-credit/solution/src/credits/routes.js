'use strict';
const { readJson, validate, HttpError } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const { createIdempotency } = require('../idempotency');
const customers = require('../customers/repository');
const repo = require('./repository');

const AMOUNT = /^\d+(\.\d{1,2})?$/;
const MAX_CREDIT_CENTS = 50000; // 500.00 per credit
const SCHEMA = {
  amount: { type: 'string', required: true, pattern: AMOUNT },
  reason: { type: 'string', required: true, min: 1, max: 200 },
};

function register(router, db) {
  const idempotency = createIdempotency();

  router.add('POST', '/api/customers/:id/credits', async (req, res, { params }) =>
    idempotency.respond(req, res, async () => {
      if (!customers.getCustomer(db, params.id)) throw new HttpError(404, 'not_found', `Customer ${params.id} not found`);
      const body = await readJson(req);
      const { fields } = validate(body, SCHEMA);
      if (!fields.includes('amount')) {
        const cents = money.fromDecimal(body.amount);
        if (cents <= 0 || cents > MAX_CREDIT_CENTS) fields.unshift('amount');
      }
      if (fields.length) throw new HttpError(422, 'validation_failed', 'Request body is invalid', { fields });
      const credit = repo.issueCredit(db, Number(params.id), { cents: money.fromDecimal(body.amount), reason: body.reason.trim() });
      return {
        status: 201,
        body: { id: credit.id, customerId: credit.customerId, amount: money.toDecimal(credit.amountCents), reason: credit.reason, createdAt: credit.createdAt },
      };
    }));
}

module.exports = { register };
