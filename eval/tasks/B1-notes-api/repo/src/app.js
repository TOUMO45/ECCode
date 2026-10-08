'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const notes = require('./notes/routes');
const tags = require('./tags/routes');

function createApp({ db = loadDb() } = {}) {
  const router = createRouter();
  notes.register(router, db);
  tags.register(router, db);
  return createServer(router);
}

module.exports = { createApp };
