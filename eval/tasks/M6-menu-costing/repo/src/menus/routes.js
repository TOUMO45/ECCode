'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, { db, costing }) {
  router.add('GET', '/api/menus/:id/report', async (req, res, { params }) => {
    const menu = repo.getMenu(db, params.id);
    if (!menu) return problem(res, 404, 'not_found', `Menu ${params.id} not found`);
    json(res, 200, costing.menuReport(menu.id));
  });
}

module.exports = { register };
