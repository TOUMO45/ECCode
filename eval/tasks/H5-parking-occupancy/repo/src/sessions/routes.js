'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, db) {
  // Exit gate: closes a parking session.
  router.add('POST', '/api/sessions/:id/exit', async (req, res, { params }) => {
    const session = repo.getSession(db, params.id);
    if (!session) return problem(res, 404, 'not_found', `Parking session ${params.id} not found`);
    if (session.exitedAt) return problem(res, 409, 'conflict', 'Parking session already ended');
    json(res, 200, repo.closeSession(db, session.sessionId));
  });
}

module.exports = { register };
