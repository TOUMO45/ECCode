'use strict';
const path = require('path');
const { createDb } = require('../vendor/acme-kit/db');

function loadDb(file = path.join(__dirname, '..', 'fixtures', 'db.json')) {
  // A fresh copy per app instance: tests must not see each other's refunds.
  return createDb(JSON.parse(require('fs').readFileSync(file, 'utf8')));
}

module.exports = { loadDb };
