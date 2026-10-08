'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const books = require('./books/routes');
const members = require('./members/routes');
const loans = require('./loans/routes');

function createApp({ db = loadDb(), now = () => new Date() } = {}) {
  const router = createRouter();
  const ctx = { db, now };
  books.register(router, ctx);
  members.register(router, ctx);
  loans.register(router, ctx);
  return createServer(router);
}

module.exports = { createApp };
