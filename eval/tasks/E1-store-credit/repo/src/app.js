'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const customers = require('./customers/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  customers.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
