'use strict';
const fs = require('fs');
const path = require('path');
const { createDb } = require('../vendor/acme-kit/db');

function loadDb(file = path.join(__dirname, '..', 'fixtures', 'db.json')) {
  // A fresh copy per app instance, so tests never see each other's writes.
  return createDb(JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = { loadDb };
