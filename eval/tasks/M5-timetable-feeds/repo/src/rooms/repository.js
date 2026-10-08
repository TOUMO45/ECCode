'use strict';

function getRoom(db, id) {
  return db.get('rooms', id);
}

module.exports = { getRoom };
