'use strict';
// Data access for hire items. DECIMAL rates are converted to cents here.
const money = require('../../vendor/acme-kit/money');

const toItem = (r) =>
  r && {
    ...r,
    dailyCents: money.fromDecimal(r.daily_rate),
    weeklyCents: money.fromDecimal(r.weekly_rate),
    depositCents: money.fromDecimal(r.deposit),
  };

function listItems(db) {
  return db.all('items').map(toItem);
}

function getItem(db, id) {
  return toItem(db.get('items', id));
}

function taxBpFor(db, category) {
  const c = db.all('categories', { name: category })[0];
  return c ? c.tax_bp : 0;
}

module.exports = { listItems, getItem, taxBpFor };
