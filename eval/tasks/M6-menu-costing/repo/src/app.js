'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { loadDb } = require('./db');
const { createCosting } = require('./costing');
const ingredients = require('./ingredients/routes');
const dishes = require('./dishes/routes');
const menus = require('./menus/routes');

function createApp({ db = loadDb(), now = () => new Date() } = {}) {
  const router = createRouter();
  const costing = createCosting({ db, now });
  ingredients.register(router, { db });
  dishes.register(router, { db, costing });
  menus.register(router, { db, costing });
  return createServer(router);
}

module.exports = { createApp };
