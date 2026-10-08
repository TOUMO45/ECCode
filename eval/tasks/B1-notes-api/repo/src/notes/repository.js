'use strict';
// Data access for notes. `tags` is stored as a JSON array in a TEXT column.

function toNote(row) {
  return { id: row.id, title: row.title, body: row.body, tags: JSON.parse(row.tags || '[]'), createdAt: row.created_at };
}

function getNote(db, id) {
  const row = db.get('notes', id);
  return row ? toNote(row) : null;
}

function allNotes(db) {
  return db.all('notes').map(toNote);
}

module.exports = { getNote, allNotes };
