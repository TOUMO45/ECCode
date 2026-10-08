'use strict';
// Data access for the product catalog.

function findProduct(db, sku) {
  return db.all('products', { sku })[0] || null;
}

module.exports = { findProduct };
