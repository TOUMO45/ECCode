'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const payments = require('./payments/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  payments.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
