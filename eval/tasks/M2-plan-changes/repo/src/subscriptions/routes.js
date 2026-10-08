'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');
const { today, viewSubscription } = require('./service');

function register(router, { db, now }) {
  router.add('GET', '/api/subscriptions/:id', async (req, res, { params }) => {
    const sub = repo.getSubscription(db, params.id);
    if (!sub) return problem(res, 404, 'not_found', `Subscription ${params.id} not found`);
    const account = repo.getAccount(db, sub.account_id);
    json(res, 200, viewSubscription(sub, { account, plan: repo.planOf(db, sub), day: today(account, now()) }));
  });
}

module.exports = { register };
