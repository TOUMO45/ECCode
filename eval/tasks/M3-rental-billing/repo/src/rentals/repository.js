'use strict';
// Data access for rentals.

function getRental(db, id) {
  return db.get('rentals', id);
}

module.exports = { getRental };
