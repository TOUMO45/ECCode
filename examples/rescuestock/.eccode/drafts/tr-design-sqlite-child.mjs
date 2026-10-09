// Child process for tr-design-ddl-race.mjs. Args: <dbFile> <busyTimeoutMs> <mode reserve|expire|hold> <startAtMs>
import { DatabaseSync } from 'node:sqlite';
const [file, bt, mode, startAt] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec('PRAGMA busy_timeout=' + Number(bt));
while (Date.now() < Number(startAt)) { /* align the two processes */ }
try {
  if (mode === 'hold') {
    db.exec('BEGIN IMMEDIATE');
    const t = Date.now(); while (Date.now() - t < 1500) { /* hold the write lock */ }
    db.exec('COMMIT');
    console.log('HELD');
  } else if (mode === 'reserve') {
    db.exec('BEGIN IMMEDIATE');
    const r = db.prepare('UPDATE inventory SET reserved = reserved + ?, version = version + 1 WHERE product_id = ? AND reserved + ? <= on_hand').run(1, 1, 1);
    const t = Date.now(); while (Date.now() - t < 200) { /* widen the window */ }
    if (r.changes === 1) {
      db.prepare("INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, at) VALUES (1, 1, 'reserve', 0, 1, 1, 1, 'reservation', ?, 'test', '2026-10-20T07:00:00.000Z')").run(process.pid);
      db.exec('COMMIT'); console.log('RESERVED');
    } else { db.exec('ROLLBACK'); console.log('OUT_OF_STOCK'); }
  } else if (mode === 'expire') {
    db.exec('BEGIN IMMEDIATE');
    const r = db.prepare("UPDATE reservations SET status='expired', closed_at=? WHERE id=? AND status='active' AND expires_at <= ?").run('2026-10-20T08:00:00.000Z', 1, '2026-10-20T08:00:00.000Z');
    if (r.changes === 1) db.prepare("INSERT INTO inventory_ledger (supplier_id, product_id, reason, delta_on_hand, delta_reserved, on_hand_after, reserved_after, ref_type, ref_id, actor, at) VALUES (1, 1, 'expire', 0, -1, 1, 0, 'reservation', 1, 'test', '2026-10-20T08:00:00.000Z')").run();
    const t = Date.now(); while (Date.now() - t < 200) { /* widen the window */ }
    db.exec('COMMIT'); console.log(r.changes === 1 ? 'EXPIRED' : 'NOOP');
  }
} catch (e) { console.log('ERROR ' + (e.errcode ?? '') + ' ' + e.message); }
