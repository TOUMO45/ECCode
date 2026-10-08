'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const plans = require('./plans/routes');
const subscriptions = require('./subscriptions/routes');

function createApp({ db = loadDb(), now = () => new Date() } = {}) {
  const router = createRouter();
  const ctx = { db, now };
  plans.register(router, ctx);
  subscriptions.register(router, ctx);
  return createServer(router);
}

module.exports = { createApp };
