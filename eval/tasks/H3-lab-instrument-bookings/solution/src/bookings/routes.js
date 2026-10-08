'use strict';
const { json, problem, readJson, validate, HttpError } = require('../../vendor/acme-kit/http');
const repo = require('./repository');
const instruments = require('../instruments/repository');
const audit = require('../audit');
const { parsePage, page } = require('../pagination');

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function checkBooking(body) {
  const { fields } = validate(body, {
    bookedBy: { type: 'string', required: true, min: 1, max: 100 },
    purpose: { type: 'string', max: 200 },
    startsAt: { type: 'string', required: true, pattern: DATETIME },
    endsAt: { type: 'string', required: true, pattern: DATETIME },
  });
  const start = Date.parse(body && body.startsAt);
  const end = Date.parse(body && body.endsAt);
  for (const [name, t] of [['startsAt', start], ['endsAt', end]]) if (Number.isNaN(t) && !fields.includes(name)) fields.push(name);
  if (!fields.length && end <= start) fields.push('endsAt');
  if (fields.length) throw new HttpError(422, 'validation_failed', 'Request body is invalid', { fields });
  return { start, end };
}

function register(router, db) {
  router.add('GET', '/api/bookings/:id', async (req, res, { params }) => {
    const booking = repo.getBooking(db, params.id);
    if (!booking) return problem(res, 404, 'not_found', `Booking ${params.id} not found`);
    json(res, 200, booking);
  });

  router.add('GET', '/api/instruments/:id/bookings', async (req, res, { params, query }) => {
    const instrument = instruments.getInstrument(db, params.id);
    if (!instrument) return problem(res, 404, 'not_found', `Instrument ${params.id} not found`);
    const p = parsePage(query);
    if (p.fields.length) return problem(res, 422, 'validation_failed', 'Invalid paging parameters', { fields: p.fields });
    json(res, 200, page(repo.bookingsFor(db, instrument.id), p));
  });

  router.add('POST', '/api/instruments/:id/bookings', async (req, res, { params }) => {
    const instrument = instruments.getInstrument(db, params.id);
    if (!instrument) return problem(res, 404, 'not_found', `Instrument ${params.id} not found`);
    const body = await readJson(req);
    const { start, end } = checkBooking(body);
    if (instrument.status === 'retired') return problem(res, 409, 'conflict', `Instrument ${instrument.id} is retired`);
    const clash = repo.bookingsFor(db, instrument.id).find((b) => start < Date.parse(b.endsAt) && end > Date.parse(b.startsAt));
    if (clash) return problem(res, 409, 'conflict', `Overlaps booking ${clash.id}`, { conflictsWith: clash.id });
    const booking = repo.insertBooking(db, { instrumentId: instrument.id, bookedBy: body.bookedBy.trim(), purpose: body.purpose, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
    audit.record(db, req, 'create', 'bookings', booking.id);
    json(res, 201, booking);
  });
}

module.exports = { register };
