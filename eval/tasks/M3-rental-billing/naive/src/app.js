'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const items = require('./items/routes');
const customers = require('./customers/routes');
const rentals = require('./rentals/routes');
const statements = require('./statements/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  items.register(router, db);
  customers.register(router, db);
  rentals.register(router, db);
  statements.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
