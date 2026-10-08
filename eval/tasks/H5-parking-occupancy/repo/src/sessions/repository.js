'use strict';

function toSession(r) {
  return { sessionId: r.id, lotId: r.lot_id, plate: r.plate, enteredAt: r.entered_at, exitedAt: r.exited_at };
}

function getSession(db, id) {
  const r = db.get('parking_sessions', id);
  return r ? toSession(r) : null;
}

function openSession(db, lotId, plate) {
  return toSession(db.insert('parking_sessions', { lot_id: lotId, plate, entered_at: new Date().toISOString(), exited_at: null }));
}

function closeSession(db, id) {
  return toSession(db.update('parking_sessions', id, { exited_at: new Date().toISOString() }));
}

module.exports = { getSession, openSession, closeSession };
