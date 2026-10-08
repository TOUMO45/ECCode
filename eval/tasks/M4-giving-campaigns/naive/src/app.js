'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const campaigns = require('./campaigns/routes');
const donations = require('./donations/routes');

function createApp({ db = loadDb(), now = () => new Date() } = {}) {
  const router = createRouter();
  const ctx = { db, now };
  campaigns.register(router, ctx);
  donations.register(router, ctx);
  return createServer(router);
}

module.exports = { createApp };
