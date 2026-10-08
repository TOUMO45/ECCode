'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const { createAccess } = require('./access/access');
const workOrders = require('./workorders/routes');
const users = require('./users/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  const access = createAccess(db);
  users.register(router, db);
  workOrders.register(router, db, access);
  return createServer(router);
}

module.exports = { createApp };
