'use strict';
// Access decisions for work orders, cached because directory lookups are slow.
const { memo } = require('../../vendor/acme-kit/cache');
const directory = require('./directory');

// Roles allowed to perform an action at the sites they are assigned to.
const PERMISSIONS = {
  view: ['technician', 'contractor', 'supervisor'],
  'view-costs': ['supervisor'],
};

function createAccess(db, { ttlMs = 5 * 60 * 1000 } = {}) {
  // Every argument changes the decision, so all of them are part of the cache
  // key (memo keys on the first argument only by default).
  const allowed = memo(
    (username, siteId, action) => {
      const person = directory.lookup(db, username);
      if (!person) return false;
      return person.siteIds.includes(Number(siteId)) && (PERMISSIONS[action] || []).includes(person.role);
    },
    { ttlMs, key: (username, siteId, action) => JSON.stringify([String(username), Number(siteId), String(action)]) },
  );
  return { allowed };
}

module.exports = { createAccess, PERMISSIONS };
