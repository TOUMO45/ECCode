'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, { db }) {
  // Small list; the school office screens read the whole array.
  router.add('GET', '/api/classes', async (req, res) => {
    json(res, 200, repo.listClasses(db).map((c) => ({ id: c.id, code: c.code, year: c.year })));
  });

  router.add('GET', '/api/classes/:id', async (req, res, { params }) => {
    const c = repo.getClass(db, params.id);
    if (!c) return problem(res, 404, 'not_found', `Class ${params.id} not found`);
    json(res, 200, { id: c.id, code: c.code, year: c.year, lessonsPerWeek: repo.lessonCount(db, c.id) });
  });

  router.add('GET', '/api/periods', async (req, res) => {
    json(res, 200, db.all('periods').map((p) => ({ number: p.number, start: p.start, end: p.end })));
  });
}

module.exports = { register };
