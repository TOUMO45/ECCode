'use strict';
// Data access for customers.

function getCustomer(db, id) {
  return db.get('customers', id);
}

module.exports = { getCustomer };
