'use strict';

function getCustomer(db, id) {
  return db.get('customers', id);
}

module.exports = { getCustomer };
