'use strict';
const { json, problem, readJson, validate } = require('../../vendor/acme-kit/http');
const repo = require('./repository');
const instruments = require('../instruments/repository');

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function register(router, db) {
  router.add('GET', '/api/bookings/:id', async (req, res, { params }) => {
    const booking = repo.getBooking(db, params.id);
    if (!booking) return problem(res, 404, 'not_found', `Booking ${params.id} not found`);
    json(res, 200, booking);
  });

  router.add('GET', '/api/instruments/:id/bookings', async (req, res, { params }) => {
    const instrument = instruments.getInstrument(db, params.id);
    if (!instrument) return problem(res, 404, 'not_found', `Instrument ${params.id} not found`);
    json(res, 200, repo.bookingsFor(db, instrument.id));
  });

  router.add('POST', '/api/instruments/:id/bookings', async (req, res, { params }) => {
    const instrument = instruments.getInstrument(db, params.id);
    if (!instrument) return problem(res, 404, 'not_found', `Instrument ${params.id} not found`);
    const body = await readJson(req);
    const check = validate(body, {
      bookedBy: { type: 'string', required: true, min: 1 },
      purpose: { type: 'string' },
      startsAt: { type: 'string', required: true, pattern: DATETIME },
      endsAt: { type: 'string', required: true, pattern: DATETIME },
    });
    const fields = check.fields;
    const start = Date.parse(body && body.startsAt);
    const end = Date.parse(body && body.endsAt);
    if (!fields.length && !(end > start)) fields.push('endsAt');
    if (fields.length) return problem(res, 422, 'validation_failed', 'Request body is invalid', { fields });
    if (instrument.status === 'retired') return problem(res, 409, 'conflict', 'Instrument is retired');
    const overlaps = repo.bookingsFor(db, instrument.id).some((b) => start < Date.parse(b.endsAt) && end > Date.parse(b.startsAt));
    if (overlaps) return problem(res, 409, 'conflict', 'The instrument is already booked at that time');
    const booking = repo.insertBooking(db, { instrumentId: instrument.id, bookedBy: body.bookedBy, purpose: body.purpose, startsAt: body.startsAt, endsAt: body.endsAt });
    json(res, 201, booking);
  });
}

module.exports = { register };
