'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const events = require('./events/routes');
const tickets = require('./tickets/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  events.register(router, db);
  tickets.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
