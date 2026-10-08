'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');
const { currentUser } = require('../auth');

function register(router, db, access) {
  router.add('GET', '/api/work-orders/:id', async (req, res, { params }) => {
    const username = currentUser(req);
    const wo = repo.getWorkOrder(db, params.id);
    // Work orders the user may not see answer 404, as if they did not exist.
    if (!wo || !access.allowed(username, wo.siteId, 'view')) return problem(res, 404, 'not_found', `Work order ${params.id} not found`);
    json(res, 200, wo);
  });

  router.add('GET', '/api/work-orders/:id/costs', async (req, res, { params }) => {
    const username = currentUser(req);
    const wo = repo.getWorkOrder(db, params.id);
    if (!wo) return problem(res, 404, 'not_found', `Work order ${params.id} not found`);
    if (!access.allowed(username, wo.siteId, 'view-costs')) return problem(res, 403, 'forbidden', 'Only supervisors of the site can see costs');
    const lines = repo.costLines(db, wo.id);
    json(res, 200, {
      workOrderId: wo.id,
      lines: lines.map((l) => ({ description: l.description, amount: money.toDecimal(l.amountCents) })),
      total: money.toDecimal(money.sum(lines.map((l) => l.amountCents))),
    });
  });
}

module.exports = { register };
