'use strict';
// Data access for plans. DECIMAL prices are converted to cents here.
const money = require('../../vendor/acme-kit/money');

const toPlan = (r) => r && { ...r, priceCents: money.fromDecimal(r.price_per_seat) };

function listPlans(db) {
  return db.all('plans').map(toPlan);
}

function getPlan(db, id) {
  return toPlan(db.get('plans', id));
}

function getPlanByCode(db, code) {
  return listPlans(db).find((p) => p.code === code) || null;
}

module.exports = { listPlans, getPlan, getPlanByCode };
