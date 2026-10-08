'use strict';
// Data access for classes.

function listClasses(db) {
  return db.all('classes');
}

function getClass(db, id) {
  return db.get('classes', id);
}

function lessonCount(db, classId) {
  return db.all('lessons', { class_id: Number(classId) }).length;
}

module.exports = { listClasses, getClass, lessonCount };
