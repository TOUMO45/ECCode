'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, { db }) {
  router.add('GET', '/api/teachers/:id', async (req, res, { params }) => {
    const t = repo.getTeacher(db, params.id);
    if (!t) return problem(res, 404, 'not_found', `Teacher ${params.id} not found`);
    json(res, 200, { id: t.id, name: t.name, subject: t.subject });
  });
}

module.exports = { register };
