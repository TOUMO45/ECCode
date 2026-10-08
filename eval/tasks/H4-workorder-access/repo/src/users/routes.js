'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const directory = require('../access/directory');
const { currentUser } = require('../auth');

function register(router, db) {
  router.add('GET', '/api/me', async (req, res) => {
    const person = directory.lookup(db, currentUser(req));
    if (!person) return problem(res, 401, 'unauthorized', 'Unknown user');
    const sites = person.siteIds.map((id) => db.get('sites', id)).filter(Boolean).map((s) => ({ id: s.id, name: s.name }));
    json(res, 200, { username: person.username, name: person.name, role: person.role, sites });
  });
}

module.exports = { register };
