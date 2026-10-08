'use strict';
// Hidden acceptance and regression checks (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const { loadDb } = require(path.join(ROOT, 'src', 'db'));

const AG7 = 'Acme API guideline AG-7: collection endpoints return `{"items": [...], "total": <number of matching records>}`. They accept `?limit` (default 50, max 100; invalid values are rejected with 422 `validation_failed`, `fields: ["limit"]`) and `?offset` (default 0). Bare JSON arrays are allowed only on legacy endpoints that already return them.';
const SEC12 = 'Acme compliance rule SEC-12: every request that creates, changes or deletes data writes exactly one row to the service\'s `audit_log` table: `actor` (the `X-Acme-Actor` request header, or `"anonymous"` if absent), `action` (`create`, `update` or `delete`), `entity` (the table name), `entity_id` (the affected row id) and `at` (ISO-8601 timestamp). Rejected requests write nothing.';

async function withApp(fn) {
  const db = loadDb();
  const server = createApp({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const h = body === undefined ? headers : { 'content-type': 'application/json', ...headers };
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed };
  };
  const api = { get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b, h) };
  try { await fn(api, db); } finally { await new Promise((r) => server.close(r)); }
}

const ORDER_1 = [1, 2, 3, 4, 5, 57, 58, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 59, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 60, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 61, 62];
const itemsOf = (body) => (Array.isArray(body) ? body : body && Array.isArray(body.items) ? body.items : []);
const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
const book = (api, id, startsAt, endsAt, extra = {}, headers) => api.post(`/api/instruments/${id}/bookings`, { bookedBy: 'r.mendes', purpose: 'Live-cell imaging', startsAt, endsAt, ...extra }, headers);
const bookingCount = (db) => db.all('bookings').length;
const auditRows = (db) => { try { return db.all('audit_log'); } catch { return []; } };

test('AC1 a booking is created and appears in the instrument\'s bookings', () => withApp(async (api) => {
  const r = await book(api, 1, '2026-10-14T08:00:00Z', '2026-10-14T12:00:00Z', { bookedBy: 'a.novak', purpose: 'Spectral unmixing test' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.ok(Number.isInteger(r.body.id));
  assert.deepStrictEqual([r.body.instrumentId, r.body.bookedBy, r.body.purpose], [1, 'a.novak', 'Spectral unmixing test']);
  assert.ok(sameTime(r.body.startsAt, '2026-10-14T08:00:00Z') && sameTime(r.body.endsAt, '2026-10-14T12:00:00Z'), JSON.stringify(r.body));
  const list = itemsOf((await api.get('/api/instruments/1/bookings?limit=100')).body);
  const found = list.find((b) => b.id === r.body.id);
  assert.ok(found, 'new booking is listed');
  assert.strictEqual(list[list.length - 1].id, r.body.id, 'listed after the earlier bookings');
  const noPurpose = await book(api, 4, '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z', { purpose: undefined });
  assert.strictEqual(noPurpose.status, 201, JSON.stringify(noPurpose.body));
}));

test('AC2 [trap:error-envelope] overlapping bookings are refused with 409 conflict', () => withApp(async (api, db) => {
  const before = bookingCount(db);
  for (const [s, e] of [['08:00', '09:30'], ['10:00', '12:00'], ['09:30', '10:30'], ['08:00', '12:00'], ['09:00', '11:00'], ['14:00', '16:00']]) {
    const r = await book(api, 1, `2026-10-12T${s}:00Z`, `2026-10-12T${e}:00Z`);
    assert.strictEqual(r.status, 409, `${s}-${e}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error && r.body.error.code, 'conflict', `${s}-${e}`);
  }
  assert.strictEqual(bookingCount(db), before, 'no booking created');
  const other = await book(api, 2, '2026-10-12T09:00:00Z', '2026-10-12T11:00:00Z');
  assert.strictEqual(other.status, 201, 'other instruments are independent');
}));

test('AC3 [trap:timestamp-compare] back-to-back bookings are allowed and offsets are compared as instants', () => withApp(async (api) => {
  const gap = await book(api, 1, '2026-10-12T11:00:00Z', '2026-10-12T13:00:00Z');
  assert.strictEqual(gap.status, 201, `between two bookings: ${JSON.stringify(gap.body)}`);
  const clash = await book(api, 1, '2026-10-12T16:30:00+02:00', '2026-10-12T17:30:00+02:00');
  assert.strictEqual(clash.status, 409, `14:30Z-15:30Z overlaps 13:00Z-15:00Z: ${JSON.stringify(clash.body)}`);
  const after = await book(api, 1, '2026-10-12T17:00:00+02:00', '2026-10-12T18:00:00+02:00');
  assert.strictEqual(after.status, 201, `15:00Z-16:00Z follows 13:00Z-15:00Z: ${JSON.stringify(after.body)}`);
  const early = await book(api, 1, '2026-10-12T08:00:00-01:00', '2026-10-12T09:30:00-01:00');
  assert.strictEqual(early.status, 409, `09:00Z-10:30Z overlaps 09:00Z-11:00Z: ${JSON.stringify(early.body)}`);
}));

test('AC4 invalid bookings are 422 validation_failed naming the invalid fields', () => withApp(async (api, db) => {
  const before = bookingCount(db);
  const cases = [
    [{ purpose: 'x' }, ['bookedBy', 'startsAt', 'endsAt']],
    [{ bookedBy: '', startsAt: '2026-10-20T09:00:00Z', endsAt: '2026-10-20T10:00:00Z' }, ['bookedBy']],
    [{ bookedBy: 'k.osei', startsAt: 'tomorrow 9am', endsAt: '2026-10-20T10:00:00Z' }, ['startsAt']],
    [{ bookedBy: 'k.osei', startsAt: '2026-10-20T10:00:00Z', endsAt: '2026-10-20T09:00:00Z' }, ['endsAt']],
    [{ bookedBy: 'k.osei', startsAt: '2026-10-20T10:00:00Z', endsAt: '2026-10-20T10:00:00Z' }, ['endsAt']],
  ];
  for (const [body, fields] of cases) {
    const r = await api.post('/api/instruments/1/bookings', body);
    assert.strictEqual(r.status, 422, JSON.stringify(body));
    assert.strictEqual(r.body.error.code, 'validation_failed', JSON.stringify(body));
    for (const f of fields) assert.ok(r.body.error.fields.includes(f), `${JSON.stringify(body)} -> ${JSON.stringify(r.body.error.fields)} should name ${f}`);
  }
  assert.strictEqual(bookingCount(db), before);
}));

test('AC5 [trap:error-envelope] retired instruments cannot be booked (409); unknown instruments are 404', () => withApp(async (api, db) => {
  const before = bookingCount(db);
  const r = await book(api, 3, '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z');
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.error.code, 'conflict');
  const a = await book(api, 99, '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z');
  assert.deepStrictEqual([a.status, a.body.error && a.body.error.code], [404, 'not_found']);
  const b = await api.get('/api/instruments/99/bookings');
  assert.deepStrictEqual([b.status, b.body.error && b.body.error.code], [404, 'not_found']);
  assert.strictEqual(bookingCount(db), before);
}));

test('AC6 an instrument\'s bookings are listed earliest first with the booking fields', () => withApp(async (api) => {
  const r = await api.get('/api/instruments/1/bookings?limit=100');
  assert.strictEqual(r.status, 200);
  const items = itemsOf(r.body);
  assert.deepStrictEqual(items.map((b) => b.id), ORDER_1);
  assert.deepStrictEqual(Object.keys(items[0]).sort(), ['bookedBy', 'endsAt', 'id', 'instrumentId', 'purpose', 'startsAt']);
  assert.deepStrictEqual([items[0].bookedBy, items[0].purpose], ['r.mendes', 'Live-cell imaging']);
  assert.ok(sameTime(items[0].startsAt, '2026-08-03T08:00:00Z') && sameTime(items[0].endsAt, '2026-08-03T10:30:00Z'));
  const two = itemsOf((await api.get('/api/instruments/2/bookings')).body);
  assert.deepStrictEqual(two.map((b) => b.id), [63, 64, 65]);
  const none = await api.get('/api/instruments/4/bookings');
  assert.strictEqual(none.status, 200);
  assert.deepStrictEqual(itemsOf(none.body), []);
}));

test('AC7 [org:list-envelope] the bookings list uses the collection envelope with a default page of 50', () => withApp(async (api) => {
  const r = await api.get('/api/instruments/1/bookings');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body && !Array.isArray(r.body) && Array.isArray(r.body.items), AG7);
  assert.strictEqual(r.body.total, 62, AG7);
  assert.deepStrictEqual(r.body.items.map((b) => b.id), ORDER_1.slice(0, 50), AG7);
  const empty = await api.get('/api/instruments/4/bookings');
  assert.deepStrictEqual([empty.status, empty.body && empty.body.items, empty.body && empty.body.total], [200, [], 0], AG7);
}));

test('AC8 [org:list-envelope] limit and offset page through the bookings; invalid limits are 422', () => withApp(async (api) => {
  const a = await api.get('/api/instruments/1/bookings?limit=10&offset=55');
  assert.strictEqual(a.status, 200, AG7);
  assert.deepStrictEqual([a.body.items && a.body.items.map((b) => b.id), a.body.total], [ORDER_1.slice(55), 62], AG7);
  const b = await api.get('/api/instruments/1/bookings?limit=5');
  assert.deepStrictEqual([b.body.items && b.body.items.map((x) => x.id), b.body.total], [ORDER_1.slice(0, 5), 62], AG7);
  const c = await api.get('/api/instruments/1/bookings?limit=100');
  assert.strictEqual(c.body.items && c.body.items.length, 62, AG7);
  for (const bad of ['101', 'ten', '-5', '2.5']) {
    const r = await api.get(`/api/instruments/1/bookings?limit=${bad}`);
    assert.strictEqual(r.status, 422, `${AG7} (limit=${bad})`);
    assert.deepStrictEqual([r.body.error && r.body.error.code, r.body.error && r.body.error.fields], ['validation_failed', ['limit']], `${AG7} (limit=${bad})`);
  }
}));

test('AC9 [org:audit-log] creating a booking writes exactly one audit row', () => withApp(async (api, db) => {
  const before = Date.now() - 1000;
  const r = await book(api, 2, '2026-10-20T08:00:00Z', '2026-10-20T12:00:00Z', {}, { 'X-Acme-Actor': 'lab-portal/r.mendes' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  let rows = auditRows(db);
  assert.strictEqual(rows.length, 1, SEC12);
  assert.deepStrictEqual([rows[0].actor, rows[0].action, rows[0].entity, String(rows[0].entity_id)], ['lab-portal/r.mendes', 'create', 'bookings', String(r.body.id)], SEC12);
  assert.ok(typeof rows[0].at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rows[0].at) && Date.parse(rows[0].at) >= before && Date.parse(rows[0].at) <= Date.now() + 1000, SEC12);
  const anon = await book(api, 2, '2026-10-21T08:00:00Z', '2026-10-21T12:00:00Z');
  assert.strictEqual(anon.status, 201);
  rows = auditRows(db);
  assert.strictEqual(rows.length, 2, SEC12);
  assert.deepStrictEqual([rows[1].actor, rows[1].action, rows[1].entity, String(rows[1].entity_id)], ['anonymous', 'create', 'bookings', String(anon.body.id)], SEC12);
}));

test('AC10 [org:audit-log] refused bookings write no audit rows', () => withApp(async (api, db) => {
  const h = { 'X-Acme-Actor': 'lab-portal/k.osei' };
  assert.strictEqual((await book(api, 1, '2026-10-12T10:00:00Z', '2026-10-12T12:00:00Z', {}, h)).status, 409);
  assert.strictEqual((await book(api, 3, '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z', {}, h)).status, 409);
  assert.strictEqual((await book(api, 1, '2026-10-20T10:00:00Z', '2026-10-20T09:00:00Z', {}, h)).status, 422);
  assert.strictEqual((await book(api, 99, '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z', {}, h)).status, 404);
  assert.strictEqual(auditRows(db).length, 0, SEC12);
}));

test('REG1 the legacy instrument list is still a bare array', () => withApp(async (api) => {
  const r = await api.get('/api/instruments');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, [
    { id: 1, name: 'Zeiss LSM 980 confocal', room: 'B2.114', status: 'active' },
    { id: 2, name: 'Bruker Avance NEO 600 NMR', room: 'C0.031', status: 'active' },
    { id: 3, name: 'Leica TCS SP5 confocal', room: 'B2.110', status: 'retired' },
    { id: 4, name: 'Thermo Orbitrap Exploris 480', room: 'C1.207', status: 'active' },
  ]);
}));

test('REG2 instrument and booking detail endpoints are unchanged', () => withApp(async (api) => {
  const i = await api.get('/api/instruments/2');
  assert.deepStrictEqual(i.body, { id: 2, name: 'Bruker Avance NEO 600 NMR', room: 'C0.031', status: 'active' });
  const b = await api.get('/api/bookings/64');
  assert.deepStrictEqual(b.body, { id: 64, instrumentId: 2, bookedBy: 'a.novak', purpose: null, startsAt: '2026-10-06T08:00:00.000Z', endsAt: '2026-10-06T12:00:00.000Z' });
  for (const p of ['/api/instruments/99', '/api/bookings/999']) {
    const r = await api.get(p);
    assert.deepStrictEqual([r.status, r.body.error.code], [404, 'not_found'], p);
  }
}));
