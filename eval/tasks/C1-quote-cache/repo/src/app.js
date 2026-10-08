'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const catalog = require('./catalog/routes');
const quotes = require('./quotes/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  catalog.register(router, db);
  quotes.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
