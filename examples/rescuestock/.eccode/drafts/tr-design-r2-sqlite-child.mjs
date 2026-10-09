// Child process for tr-design-r2-ddl-race.mjs.
// Args: <dbFile> <busyTimeoutMs> <mode reserve|expire|hold> <startAtMs> [customerId planVersionId productId key]
// reserve follows the revision-2 Reservation steps 3-5 inside one BEGIN IMMEDIATE: live-reservation cap (1),
// conditional inventory UPDATE, reservation row with idempotency_key and operation_key res:<c>:<pv>:<key>.
import { DatabaseSync } from 'node:sqlite';
const [file, bt, mode, startAt, customerId, planVersionId, productId, key] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec('PRAGMA busy_timeout=' + Number(bt));
while (Date.now() < Number(startAt)) { /* align processes */ }
const now = '2026-10-20T07:00:00.000Z';
try {
  if (mode === 'hold') {
    db.exec('BEGIN IMMEDIATE');
    const t = Date.now(); while (Date.now() - t < 1500) { /* hold */ }
    db.exec('COMMIT'); console.log('HELD');
  } else if (mode === 'reserve') {
    db.exec('BEGIN IMMEDIATE');
    const live = db.prepare("SELECT count(*) AS n FROM reservations WHERE customer_id = ? AND status = 'active'").get(Number(customerId)).n;
    const t = Date.now(); while (Date.now() - t < 200) { /* widen the window */ }
    if (live >= 1) { db.exec('ROLLBACK'); console.log('RESERVATION_LIMIT'); }
    else {
      const r = db.prepare('UPDATE inventory SET reserved = reserved + 1, version = version + 1 WHERE product_id = ? AND reserved + 1 <= on_hand').run(Number(productId));
      if (r.changes !== 1) { db.exec('ROLLBACK'); console.log('OUT_OF_STOCK'); }
      else {
        const ins = db.prepare("INSERT INTO reservations (plan_version_id, customer_id, idempotency_key, operation_key, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'active', '2026-10-20T07:30:00.000Z', ?)")
          .run(Number(planVersionId), Number(customerId), key, `res:${customerId}:${planVersionId}:${key}`, now);
        db.prepare("INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, at) VALUES (1, ?, 'reserve', 0, 1, 1, 1, 'reservation', ?, 'test', ?)")
          .run(Number(productId), Number(ins.lastInsertRowid), now);
        db.exec('COMMIT'); console.log('RESERVED');
      }
    }
  } else if (mode === 'expire') {
    db.exec('BEGIN IMMEDIATE');
    const r = db.prepare("UPDATE reservations SET status='expired', closed_at=? WHERE id=? AND status='active' AND expires_at <= ?").run('2026-10-20T08:00:00.000Z', Number(planVersionId), '2026-10-20T08:00:00.000Z');
    if (r.changes === 1) db.prepare("INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, at) VALUES (1, 1, 'expire', 0, -1, 1, 0, 'reservation', ?, 'test', '2026-10-20T08:00:00.000Z')").run(Number(planVersionId));
    const t = Date.now(); while (Date.now() - t < 200) { /* widen */ }
    db.exec('COMMIT'); console.log(r.changes === 1 ? 'EXPIRED' : 'NOOP');
  }
} catch (e) { console.log('ERROR ' + (e.errcode ?? '') + ' ' + e.message); }
