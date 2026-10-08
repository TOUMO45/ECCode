'use strict';
const path = require('path');
const { createDb } = require('../vendor/acme-kit/db');

function loadDb(file = path.join(__dirname, '..', 'fixtures', 'db.json')) {
  return createDb(require(file));
}

module.exports = { loadDb };
