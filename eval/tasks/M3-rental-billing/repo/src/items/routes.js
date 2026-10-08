'use strict';
const { json } = require('../../vendor/acme-kit/http');
const money = require('../../vendor/acme-kit/money');
const repo = require('./repository');

function register(router, db) {
  // The hire catalogue is small; counter clients read the whole array.
  router.add('GET', '/api/items', async (req, res) => {
    json(
      res,
      200,
      repo.listItems(db).map((i) => ({
        id: i.id,
        sku: i.sku,
        name: i.name,
        category: i.category,
        dailyRate: money.toDecimal(i.dailyCents),
        weeklyRate: money.toDecimal(i.weeklyCents),
        deposit: money.toDecimal(i.depositCents),
      }))
    );
  });
}

module.exports = { register };
