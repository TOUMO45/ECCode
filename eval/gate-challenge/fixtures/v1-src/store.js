'use strict';
// In-memory note repository.

function createStore() {
  const notes = new Map();
  let next = 1;
  return {
    create(owner, { title, body }) {
      const note = { id: next++, owner, title, body, createdAt: new Date().toISOString() };
      notes.set(note.id, note);
      return note;
    },
    listByOwner(owner) {
      return [...notes.values()].filter((n) => n.owner === owner);
    },
    get(id) {
      return notes.get(Number(id)) || null;
    },
    remove(id) {
      return notes.delete(Number(id));
    },
  };
}

module.exports = { createStore };
