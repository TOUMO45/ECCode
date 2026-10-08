'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, db) {
  router.add('GET', '/api/notes/:id', async (req, res, { params }) => {
    const note = repo.getNote(db, params.id);
    if (!note) return problem(res, 404, 'not_found', `Note ${params.id} not found`);
    json(res, 200, note);
  });
}

module.exports = { register };
