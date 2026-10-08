'use strict';

const toInstrument = (r) => ({ id: r.id, name: r.name, room: r.room, status: r.status });

function listInstruments(db) {
  return db.all('instruments').map(toInstrument);
}

function getInstrument(db, id) {
  const r = db.get('instruments', id);
  return r ? toInstrument(r) : null;
}

module.exports = { listInstruments, getInstrument };
