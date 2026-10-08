'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, { db }) {
  router.add('GET', '/api/rooms/:id', async (req, res, { params }) => {
    const r = repo.getRoom(db, params.id);
    if (!r) return problem(res, 404, 'not_found', `Room ${params.id} not found`);
    json(res, 200, { id: r.id, code: r.code, kind: r.kind });
  });
}

module.exports = { register };
