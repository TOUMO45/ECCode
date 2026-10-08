'use strict';
const { json } = require('../../vendor/acme-kit/http');
const notes = require('../notes/repository');

// Tag cloud. Legacy format (a bare array), parsed as-is by the mobile app.
function register(router, db) {
  router.add('GET', '/api/tags', async (req, res) => {
    const counts = new Map();
    for (const note of notes.allNotes(db)) {
      for (const tag of note.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    const cloud = [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([tag, count]) => ({ tag, count }));
    json(res, 200, cloud);
  });
}

module.exports = { register };
