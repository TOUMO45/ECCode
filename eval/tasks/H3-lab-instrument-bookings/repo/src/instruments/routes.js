'use strict';
const { json, problem } = require('../../vendor/acme-kit/http');
const repo = require('./repository');

function register(router, db) {
  // Legacy format: the lobby kiosk reads this bare array.
  router.add('GET', '/api/instruments', async (req, res) => {
    json(res, 200, repo.listInstruments(db));
  });

  router.add('GET', '/api/instruments/:id', async (req, res, { params }) => {
    const instrument = repo.getInstrument(db, params.id);
    if (!instrument) return problem(res, 404, 'not_found', `Instrument ${params.id} not found`);
    json(res, 200, instrument);
  });
}

module.exports = { register };
