'use strict';

function getLot(db, id) {
  const r = db.get('lots', id);
  return r ? { id: r.id, name: r.name, capacity: r.capacity } : null;
}

/** Number of open parking sessions in a lot (a full scan of the lot's sessions). */
function countOpenSessions(db, lotId) {
  return db.all('parking_sessions', { lot_id: Number(lotId) }).filter((s) => !s.exited_at).length;
}

module.exports = { getLot, countOpenSessions };
