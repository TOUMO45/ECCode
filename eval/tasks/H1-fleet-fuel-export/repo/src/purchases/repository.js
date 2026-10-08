'use strict';
// Data access for fuel card purchases. DECIMAL columns become integer cents here.
const money = require('../../vendor/acme-kit/money');

function toPurchase(db, row) {
  const vehicle = db.get('vehicles', row.vehicle_id);
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    plate: vehicle ? vehicle.plate : null,
    driver: row.driver,
    station: row.station,
    purchasedAt: row.purchased_at,
    litres: row.litres,
    netCents: money.fromDecimal(row.net),
    vatBp: row.vat_bp,
  };
}

function getPurchase(db, id) {
  const row = db.get('fuel_purchases', id);
  return row ? toPurchase(db, row) : null;
}

/** Purchases with start <= purchased_at < end (ISO timestamps), in id order. */
function purchasesBetween(db, { start, end }, where = {}) {
  return db
    .all('fuel_purchases', where)
    .filter((r) => r.purchased_at >= start && r.purchased_at < end)
    .map((r) => toPurchase(db, r));
}

function getVehicle(db, id) {
  return db.get('vehicles', id);
}

module.exports = { getPurchase, purchasesBetween, getVehicle };
