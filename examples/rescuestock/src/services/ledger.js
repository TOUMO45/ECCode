// Inventory writes and the append-only inventory ledger (spec: 001_core.sql inventory_ledger, Reservation).
//
// Every change of inventory.on_hand or inventory.reserved goes through this module, and every change writes exactly
// one inventory_ledger row, so for every product SUM(delta_on_hand) = on_hand and SUM(delta_reserved) = reserved
// (the invariant of Data Design > Invariants checked by tests).
//
//   reserveStock      reserved + q, only while reserved + q <= on_hand (conditional UPDATE; false when it would oversell)
//   releaseStock      reserved - q, ledger reason 'release' or 'expire'
//   setOnHand         on_hand to a new value (supplier PATCH): 'restock' when it grows, 'adjust' when it shrinks;
//                     false when it would drop below reserved (RESERVED_STOCK is the caller's answer)
//   resetInventory    both columns to given values with one 'adjust' row (admin reset)
//   closeReservation  reservation active -> released | expired, and the stock back, in the caller's transaction
//
// All functions run inside the caller's transaction (db.tx) and use prepared statements only.
import { isoFromMs } from '../clock.js';
import { assertTransition } from '../domain/states.js';

export function actorOf(user) {
  return user && Number.isSafeInteger(user.id) ? `${user.role}:${user.id}` : 'system';
}

function writeLedger(db, clock, { productId, reason, deltaOnHand, deltaReserved, refType, refId = null, actor, requestId = null }) {
  const row = db.prepare('SELECT supplier_id, on_hand, reserved FROM inventory WHERE product_id = ?').get(productId);
  db.prepare(
    'INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ' +
      'ref_type, ref_id, actor, request_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.supplier_id, productId, reason, deltaOnHand, deltaReserved, row.on_hand, row.reserved,
    refType, Number.isSafeInteger(refId) ? refId : null, actor, requestId, isoFromMs(clock.now()),
  );
}

// reserved + qty, unless that would exceed on_hand. Returns true when the stock was taken.
export function reserveStock(db, clock, { productId, qty, reservationId, actor, requestId = null }) {
  const changed = db
    .prepare('UPDATE inventory SET reserved = reserved + ?, version = version + 1 WHERE product_id = ? AND reserved + ? <= on_hand')
    .run(qty, productId, qty).changes;
  if (changed !== 1) return false;
  writeLedger(db, clock, { productId, reason: 'reserve', deltaOnHand: 0, deltaReserved: qty, refType: 'reservation', refId: reservationId, actor, requestId });
  return true;
}

// reserved - qty. Releasing more than is reserved is a bug in the caller, never a state to hide.
export function releaseStock(db, clock, { productId, qty, reason, refType = 'reservation', refId = null, actor, requestId = null }) {
  if (reason !== 'release' && reason !== 'expire') throw new TypeError('releaseStock needs reason release or expire');
  const changed = db
    .prepare('UPDATE inventory SET reserved = reserved - ?, version = version + 1 WHERE product_id = ? AND reserved >= ?')
    .run(qty, productId, qty).changes;
  if (changed !== 1) throw new Error('inventory invariant: release of more than is reserved');
  writeLedger(db, clock, { productId, reason, deltaOnHand: 0, deltaReserved: -qty, refType, refId, actor, requestId });
}

// on_hand to `newOnHand`. Returns { changed, delta }; changed is false (nothing written) when the value is the
// same, and the result is null when newOnHand is below the reserved quantity.
export function setOnHand(db, clock, { productId, newOnHand, refType = 'supplier_patch', refId = null, actor, requestId = null }) {
  const current = db.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(productId);
  if (!current) throw new Error('inventory row missing');
  if (newOnHand < current.reserved) return null;
  const delta = newOnHand - current.on_hand;
  if (delta === 0) return { changed: false, delta: 0 };
  const changed = db
    .prepare('UPDATE inventory SET on_hand = ?, version = version + 1 WHERE product_id = ? AND reserved <= ?')
    .run(newOnHand, productId, newOnHand).changes;
  if (changed !== 1) return null;
  writeLedger(db, clock, {
    productId, reason: delta > 0 ? 'restock' : 'adjust', deltaOnHand: delta, deltaReserved: 0, refType, refId, actor, requestId,
  });
  return { changed: true, delta };
}

// Both columns to the given values with one 'adjust' row (admin reset restores RS-FIX-1). No row when nothing differs.
export function resetInventory(db, clock, { productId, onHand, reserved = 0, refId = null, actor, requestId = null }) {
  const current = db.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(productId);
  if (!current) throw new Error('inventory row missing');
  const deltaOnHand = onHand - current.on_hand;
  const deltaReserved = reserved - current.reserved;
  if (deltaOnHand === 0 && deltaReserved === 0) return false;
  db.prepare('UPDATE inventory SET on_hand = ?, reserved = ?, version = version + 1 WHERE product_id = ?').run(onHand, reserved, productId);
  writeLedger(db, clock, { productId, reason: 'adjust', deltaOnHand, deltaReserved, refType: 'admin_reset', refId, actor, requestId });
  return true;
}

// active -> released | expired (compare-and-set), then the stock of every item goes back with one ledger row per item
// (reason 'release' or 'expire'). `dueBy` (an ISO time) makes the expiry pass conditional on expires_at <= dueBy.
// Returns false when another actor already moved the row: the second pass of the expiry is exactly this no-op.
export function closeReservation(db, clock, { reservationId, to, dueBy = null, actor, requestId = null }) {
  if (to !== 'released' && to !== 'expired') throw new TypeError('closeReservation needs to = released | expired');
  assertTransition('reservation', 'active', to);
  const now = isoFromMs(clock.now());
  const moved =
    dueBy === null
      ? db.prepare("UPDATE reservations SET status = ?, closed_at = ? WHERE id = ? AND status = 'active'").run(to, now, reservationId).changes
      : db
          .prepare("UPDATE reservations SET status = ?, closed_at = ? WHERE id = ? AND status = 'active' AND expires_at <= ?")
          .run(to, now, reservationId, dueBy).changes;
  if (moved !== 1) return false;
  const items = db.prepare('SELECT product_id, qty FROM reservation_items WHERE reservation_id = ? ORDER BY product_id').all(reservationId);
  for (const item of items) {
    releaseStock(db, clock, {
      productId: item.product_id, qty: item.qty, reason: to === 'expired' ? 'expire' : 'release', refId: reservationId, actor, requestId,
    });
  }
  return true;
}
