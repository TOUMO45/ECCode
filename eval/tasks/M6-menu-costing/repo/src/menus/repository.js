'use strict';
// Data access for menus. DECIMAL selling prices are converted to cents here.
const money = require('../../vendor/acme-kit/money');

function getMenu(db, id) {
  return db.get('menus', id);
}

function itemsOf(db, menuId) {
  return db.all('menu_items', { menu_id: Number(menuId) }).map((i) => ({ ...i, sellCents: money.fromDecimal(i.sell_price) }));
}

module.exports = { getMenu, itemsOf };
