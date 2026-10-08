'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const couriers = require('./couriers/routes');
const payouts = require('./payouts/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  couriers.register(router, db);
  payouts.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
