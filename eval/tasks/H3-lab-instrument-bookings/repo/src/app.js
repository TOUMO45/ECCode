'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const instruments = require('./instruments/routes');
const bookings = require('./bookings/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  instruments.register(router, db);
  bookings.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
