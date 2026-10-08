'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const customers = require('../customers/repository');

const AMOUNT = /^\d+(\.\d{1,2})?$/;
const MAX_CENTS = 50000;

function register(router, db) {
  router.add('POST', '/api/customers/:id/credits', async (req, res, { params }) => {
    const customer = customers.getCustomer(db, params.id);
    if (!customer) return problem(res, 404, 'not_found', `Customer ${params.id} not found`);
    const body = await readJson(req);
    const { fields } = validate(body, {
      amount: { type: 'string', required: true, pattern: AMOUNT },
      reason: { type: 'string', required: true, min: 1, max: 200 },
    });
    if (!fields.includes('amount')) {
      const cents = money.fromDecimal(body.amount);
      if (cents <= 0 || cents > MAX_CENTS) fields.unshift('amount');
    }
    if (fields.length) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields });

    const cents = money.fromDecimal(body.amount);
    const credit = db.insert('credits', { customer_id: customer.id, amount: money.toDecimal(cents), reason: body.reason.trim(), created_at: new Date().toISOString() });
    db.update('customers', customer.id, { credit_balance: money.toDecimal(money.fromDecimal(customer.credit_balance) + cents) });
    json(res, 201, { id: credit.id, customerId: customer.id, amount: credit.amount, reason: credit.reason, createdAt: credit.created_at });
  });
}

module.exports = { register };
