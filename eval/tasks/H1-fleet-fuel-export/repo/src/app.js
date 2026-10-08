'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const purchases = require('./purchases/routes');
const vehicles = require('./vehicles/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  purchases.register(router, db);
  vehicles.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
