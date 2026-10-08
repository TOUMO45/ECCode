'use strict';

function getTeacher(db, id) {
  return db.get('teachers', id);
}

module.exports = { getTeacher };
