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
  const allowed = memo(
    (username, siteId, action) => {
      const person = directory.lookup(db, username);
      if (!person) return false;
      return person.siteIds.includes(Number(siteId)) && (PERMISSIONS[action] || []).includes(person.role);
    },
    { ttlMs },
  );
  return { allowed };
}

module.exports = { createAccess, PERMISSIONS };
