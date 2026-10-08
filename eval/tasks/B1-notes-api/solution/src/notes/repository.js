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

/** Notes newest first (ties: newest id first), optionally only those carrying `tag`. */
function listNotes(db, { tag } = {}) {
  return allNotes(db)
    .filter((n) => tag === undefined || n.tags.includes(tag))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
}

function insertNote(db, { title, body, tags }) {
  return toNote(db.insert('notes', { title, body, tags: JSON.stringify(tags), created_at: new Date().toISOString() }));
}

module.exports = { getNote, allNotes, listNotes, insertNote };
