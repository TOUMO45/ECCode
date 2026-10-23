'use strict';
// Unit prices in cents, and whether an item is taxed (books are not).
const CATALOG = {
  pen: { unitCents: 150, taxed: true },
  notebook: { unitCents: 420, taxed: true },
  book: { unitCents: 1299, taxed: false },
};

function find(sku) {
  const item = CATALOG[sku];
  if (!item) throw new Error(`unknown sku: ${sku}`);
  return item;
}

module.exports = { find };
