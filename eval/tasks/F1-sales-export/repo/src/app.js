'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const reports = require('./reports/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  reports.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
