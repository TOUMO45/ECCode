'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const sessionsRepo = require('../sessions/repository');

const PLATE = /^[A-Z0-9][A-Z0-9 -]{1,9}$/i;

function register(router, db, { lotInfo, occupancy }) {
  router.add('GET', '/api/lots/:id', async (req, res, { params }) => {
    const lot = lotInfo(params.id);
    if (!lot) return problem(res, 404, 'not_found', `Lot ${params.id} not found`);
    json(res, 200, lot);
  });

  router.add('GET', '/api/lots/:id/occupancy', async (req, res, { params }) => {
    const occ = occupancy.get(params.id);
    if (!occ) return problem(res, 404, 'not_found', `Lot ${params.id} not found`);
    json(res, 200, occ);
  });

  // Entry gate: opens a parking session if the lot has a free space.
  router.add('POST', '/api/lots/:id/entries', async (req, res, { params }) => {
    const lot = lotInfo(params.id);
    if (!lot) return problem(res, 404, 'not_found', `Lot ${params.id} not found`);
    const body = await readJson(req);
    const check = validate(body, { plate: { type: 'string', required: true, pattern: PLATE } });
    if (!check.ok) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields: check.fields });
    if (occupancy.get(params.id).full) return problem(res, 409, 'conflict', 'Lot is full');
    const session = sessionsRepo.openSession(db, lot.id, body.plate.trim().toUpperCase());
    occupancy.invalidate(lot.id);
    json(res, 201, session);
  });
}

module.exports = { register };
