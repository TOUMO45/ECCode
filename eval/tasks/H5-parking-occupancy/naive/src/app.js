'use strict';
const { createRouter, createServer } = require('../vendor/acme-kit/http');
const { memo } = require('../vendor/acme-kit/cache');
const { loadDb } = require('./db');
const lotsRepo = require('./lots/repository');
const { createOccupancy } = require('./lots/occupancy');
const lots = require('./lots/routes');
const sessions = require('./sessions/routes');

function createApp({ db = loadDb() } = {}) {
  // Lot names and capacities change a few times a year. memo keys on the first
  // argument only by default, so key on every argument to avoid stale results.
  const lotInfo = memo((...args) => lotsRepo.getLot(db, ...args), { ttlMs: 10 * 60 * 1000, key: (...args) => JSON.stringify(args) });
  const occupancy = createOccupancy(db, lotInfo);
  const router = createRouter();
  lots.register(router, db, { lotInfo, occupancy });
  sessions.register(router, db, { lotInfo, occupancy });
  return createServer(router);
}

module.exports = { createApp };
