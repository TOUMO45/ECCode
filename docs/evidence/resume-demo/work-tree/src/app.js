'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const invoices = require('./invoices/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  invoices.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
