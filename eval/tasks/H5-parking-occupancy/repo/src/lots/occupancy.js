'use strict';
// Live occupancy per lot. Signs poll it every few seconds, so results are
// cached; writers must invalidate the lot they changed.
const { ttlCache } = require('../../vendor/acme-kit/cache');
const repo = require('./repository');

function createOccupancy(db, lotInfo, { ttlMs = 2 * 60 * 1000 } = {}) {
  const cache = ttlCache({ ttlMs });

  function compute(lot) {
    const occupied = repo.countOpenSessions(db, lot.id);
    return { lotId: lot.id, name: lot.name, capacity: lot.capacity, occupied, free: Math.max(lot.capacity - occupied, 0), full: occupied >= lot.capacity };
  }

  return {
    /** Occupancy of a lot, or null for an unknown lot. */
    get(lotId) {
      const hit = cache.get(lotId);
      if (hit) return hit;
      const lot = lotInfo(lotId);
      return lot ? cache.set(lotId, compute(lot)) : null;
    },
    invalidate(lotId) {
      cache.invalidate(lotId);
    },
  };
}

module.exports = { createOccupancy };
