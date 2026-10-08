'use strict';
// Hidden acceptance and regression checks for M1 (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const { loadDb } = require(path.join(ROOT, 'src', 'db'));

const NOON = '2026-03-10T15:00:00Z'; // 10:00 on 2026-03-10 in America/Chicago
const LATE_EVENING = '2026-03-11T03:30:00Z'; // 22:30 on 2026-03-10 in America/Chicago

const RULE_ENVELOPE = 'Acme API guideline AG-7: collection endpoints return {"items": [...], "total": <number of matching records>}. They accept ?limit (default 50, max 100; invalid values are rejected with 422 validation_failed, fields: ["limit"]) and ?offset (default 0). Bare JSON arrays are allowed only on legacy endpoints that already return them.';
const RULE_AUDIT = 'Acme compliance rule SEC-12: every request that creates, changes or deletes data writes exactly one row to the service\'s audit_log table: actor (the X-Acme-Actor request header, or "anonymous" if absent), action (create, update or delete), entity (the table name), entity_id (the affected row id) and at (ISO-8601 timestamp). Rejected requests write nothing.';

async function withApp(fn, { now = NOON } = {}) {
  const db = loadDb();
  const server = createApp({ db, now: () => new Date(now) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const h = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
    const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed };
  };
  try {
    await fn({ db, get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b, h) });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const itemsOf = (body) => (Array.isArray(body) ? body : body.items);
const auditRows = (db) => db.all('audit_log').map(({ id, ...r }) => r);
const checkout = (app, memberId, copyId, headers) => app.post('/api/loans', { memberId, copyId }, headers);

test('AC1 [trap:local-date] loan periods by tier, counted from the branch-local checkout day', () => withApp(async (app) => {
  const adult = await checkout(app, 1, 9);
  assert.strictEqual(adult.status, 201, JSON.stringify(adult.body));
  assert.deepStrictEqual([adult.body.checkedOutOn, adult.body.dueOn], ['2026-03-10', '2026-03-31']);
  const junior = await checkout(app, 2, 13);
  assert.deepStrictEqual([junior.body.checkedOutOn, junior.body.dueOn], ['2026-03-10', '2026-03-24']);
  const senior = await checkout(app, 3, 11);
  assert.deepStrictEqual([senior.body.checkedOutOn, senior.body.dueOn], ['2026-03-10', '2026-04-07']);
}));

test('AC2 [trap:local-date] a checkout late in the evening is dated with the branch-local day', () => withApp(async (app) => {
  const r = await checkout(app, 1, 9);
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual([r.body.checkedOutOn, r.body.dueOn], ['2026-03-10', '2026-03-31']);
}, { now: LATE_EVENING }));

test('AC3 [trap:decimal-string] unpaid fines of $5.00 or more block checkout; paid fines do not count', () => withApp(async (app) => {
  const blocked = await checkout(app, 4, 12); // 2.50 + 2.50 unpaid (and a paid 20.00)
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual(blocked.body.error.code, 'conflict');
  const ok = await checkout(app, 5, 12); // 2.50 + 2.25 unpaid, plus a paid 12.00
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
}));

test('AC4 a renewal adds a loan period to the current due date and counts the renewal', () => withApp(async (app) => {
  const adult = await app.post('/api/loans/1/renew', {});
  assert.strictEqual(adult.status, 200, JSON.stringify(adult.body));
  assert.strictEqual(adult.body.id, 1);
  assert.deepStrictEqual([adult.body.dueOn, adult.body.renewals], ['2026-04-07', 1]);
  const senior = await app.post('/api/loans/2/renew'); // due today, one renewal so far, a cancelled hold exists
  assert.strictEqual(senior.status, 200, JSON.stringify(senior.body));
  assert.deepStrictEqual([senior.body.dueOn, senior.body.renewals], ['2026-04-07', 2]);
  const again = await app.post('/api/loans/2/renew');
  assert.strictEqual(again.status, 409);
}));

test('AC5 [trap:hold-status] renewals are refused for the renewal limit, overdue loans, waiting holds and returned loans', () => withApp(async (app) => {
  for (const [id, why] of [[3, 'two renewals already'], [6, 'overdue'], [4, 'another member is waiting'], [8, 'already returned']]) {
    const r = await app.post(`/api/loans/${id}/renew`);
    assert.strictEqual(r.status, 409, `loan ${id}: ${why}`);
    assert.strictEqual(r.body.error.code, 'conflict');
  }
  const missing = await app.post('/api/loans/99/renew');
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.body.error.code, 'not_found');
}));

test('AC6 [trap:local-date] a loan due today is still renewable in the evening, branch time', () => withApp(async (app) => {
  const r = await app.post('/api/loans/2/renew');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.dueOn, '2026-04-07');
}, { now: LATE_EVENING }));

test('AC7 [trap:closed-days] returns count overdue days without closure days, and nothing is due on time', () => withApp(async (app) => {
  const late = await app.post('/api/loans/6/return'); // adult, book, due 2026-02-26
  assert.strictEqual(late.status, 200, JSON.stringify(late.body));
  assert.deepStrictEqual([late.body.status, late.body.returnedOn, late.body.overdueDays, late.body.fine], ['returned', '2026-03-10', 11, '2.75']);
  const dvd = await app.post('/api/loans/5/return'); // adult DVD, 25 open days = 25.00, capped at the 24.00 replacement price
  assert.deepStrictEqual([dvd.body.overdueDays, dvd.body.fine], [25, '24.00']);
  const dueToday = await app.post('/api/loans/2/return');
  assert.deepStrictEqual([dueToday.body.overdueDays, dueToday.body.fine], [0, '0.00']);
  const early = await app.post('/api/loans/7/return');
  assert.deepStrictEqual([early.body.overdueDays, early.body.fine], [0, '0.00']);
  const twice = await app.post('/api/loans/6/return');
  assert.strictEqual(twice.status, 409);
  assert.strictEqual(twice.body.error.code, 'conflict');
}));

test('AC8 [trap:junior-discount] juniors pay half of the capped fine, rounded half up at the end', () => withApp(async (app) => {
  const odd = await app.post('/api/loans/15/return'); // 11 days x 0.25 = 2.75 -> 1.375 -> 1.38
  assert.deepStrictEqual([odd.body.overdueDays, odd.body.fine], [11, '1.38']);
  const capped = await app.post('/api/loans/16/return'); // 26 days x 1.00, cap 12.00, then half = 6.00
  assert.deepStrictEqual([capped.body.overdueDays, capped.body.fine], [26, '6.00']);
  const view = await app.get('/api/members/2/loans?status=returned');
  assert.deepStrictEqual(itemsOf(view.body).map((l) => [l.id, l.fine]), [[15, '1.38'], [16, '6.00']]);
}));

test('AC9 [org:list-envelope] the loan history is an envelope with total, limit and offset', () => withApp(async (app) => {
  const all = await app.get('/api/members/1/loans');
  assert.strictEqual(all.status, 200);
  assert.deepStrictEqual(Object.keys(all.body).sort(), ['items', 'total'], RULE_ENVELOPE);
  assert.deepStrictEqual(all.body.items.map((l) => l.id), [1, 5, 8], RULE_ENVELOPE);
  assert.strictEqual(all.body.total, 3, RULE_ENVELOPE);
  const page = await app.get('/api/members/1/loans?limit=1&offset=1');
  assert.deepStrictEqual(page.body.items.map((l) => l.id), [5], RULE_ENVELOPE);
  assert.strictEqual(page.body.total, 3, RULE_ENVELOPE);
  for (const bad of ['abc', '101', '-1']) {
    const r = await app.get(`/api/members/1/loans?limit=${bad}`);
    assert.strictEqual(r.status, 422, `${RULE_ENVELOPE} (limit=${bad})`);
    assert.strictEqual(r.body.error && r.body.error.code, 'validation_failed', RULE_ENVELOPE);
    assert.deepStrictEqual(r.body.error && r.body.error.fields, ['limit'], RULE_ENVELOPE);
  }
}));

test('AC10 the loan history filters by status and shows the fine an overdue loan would carry today', () => withApp(async (app) => {
  const overdue = await app.get('/api/members/1/loans?status=overdue');
  assert.deepStrictEqual(itemsOf(overdue.body).map((l) => [l.id, l.status, l.overdueDays, l.fine, l.title]), [[5, 'overdue', 25, '24.00', 'Spirited Away']]);
  const open = await app.get('/api/members/1/loans?status=open');
  assert.deepStrictEqual(itemsOf(open.body).map((l) => [l.id, l.status, l.fine]), [[1, 'open', '0.00'], [5, 'overdue', '24.00']]);
  const returned = await app.get('/api/members/1/loans?status=returned');
  assert.deepStrictEqual(itemsOf(returned.body).map((l) => [l.id, l.returnedOn, l.fine]), [[8, '2025-12-20', '0.00']]);
  const bad = await app.get('/api/members/1/loans?status=lost');
  assert.strictEqual(bad.status, 422);
  assert.deepStrictEqual(bad.body.error.fields, ['status']);
  const none = await app.get('/api/members/99/loans');
  assert.strictEqual(none.status, 404);
}));

test('AC11 [org:audit-log] checkout, renewal and return each write exactly one audit row', () => withApp(async (app) => {
  const c = await checkout(app, 1, 9, { 'X-Acme-Actor': 'desk-3' });
  assert.strictEqual(c.status, 201);
  let rows = auditRows(app.db);
  assert.strictEqual(rows.length, 1, RULE_AUDIT);
  assert.deepStrictEqual({ ...rows[0], at: typeof rows[0].at }, { actor: 'desk-3', action: 'create', entity: 'loans', entity_id: c.body.id, at: 'string' }, RULE_AUDIT);
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)), RULE_AUDIT);
  await app.post('/api/loans/1/renew', {}, { 'X-Acme-Actor': 'desk-3' });
  rows = auditRows(app.db);
  assert.strictEqual(rows.length, 2, RULE_AUDIT);
  assert.deepStrictEqual([rows[1].actor, rows[1].action, rows[1].entity, rows[1].entity_id], ['desk-3', 'update', 'loans', 1], RULE_AUDIT);
  await app.post('/api/loans/6/return');
  rows = auditRows(app.db);
  assert.strictEqual(rows.length, 3, RULE_AUDIT);
  assert.deepStrictEqual([rows[2].actor, rows[2].action, rows[2].entity, rows[2].entity_id], ['anonymous', 'update', 'loans', 6], RULE_AUDIT);
}));

test('AC12 [org:audit-log] rejected requests write no audit row', () => withApp(async (app) => {
  const done = await app.post('/api/loans/1/renew'); // one successful write, so exactly one row is expected overall
  assert.strictEqual(done.status, 200);
  const attempts = [
    await checkout(app, 4, 12), // unpaid fines
    await checkout(app, 1, 1), // copy already out
    await checkout(app, 1, 'x'), // invalid
    await app.post('/api/loans/3/renew'), // renewal limit
    await app.post('/api/loans/8/return'), // already returned
    await app.post('/api/loans/99/return'), // unknown
  ];
  assert.deepStrictEqual(attempts.map((a) => a.status >= 400), [true, true, true, true, true, true]);
  assert.strictEqual(auditRows(app.db).length, 1, RULE_AUDIT);
}));

test('REG1 the catalogue, book and member lookups keep their format, copy availability and 404s', () => withApp(async (app) => {
  const r = await app.get('/api/books');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.deepStrictEqual(r.body.map((b) => [b.id, b.copies, b.available]), [[1, 2, 0], [2, 3, 2], [3, 2, 1], [4, 2, 0], [5, 2, 1], [6, 2, 0]]);
  assert.deepStrictEqual(Object.keys(r.body[0]).sort(), ['author', 'available', 'copies', 'id', 'media', 'title']);
  const m = await app.get('/api/members/4');
  assert.deepStrictEqual(m.body, { id: 4, name: 'Ingrid Solheim', cardNo: 'L-1004', tier: 'adult', openLoans: 2 });
  const b = await app.get('/api/books/3');
  assert.deepStrictEqual(b.body, { id: 3, title: 'Spirited Away', author: 'Hayao Miyazaki', media: 'dvd', copies: 2, available: 1 });
  for (const p of ['/api/members/99', '/api/books/99']) {
    const miss = await app.get(p);
    assert.deepStrictEqual([miss.status, miss.body.error.code], [404, 'not_found']);
  }
}));

test('REG2 checkout keeps its validation, conflict and response shape', () => withApp(async (app) => {
  const ok = await checkout(app, 1, 9);
  assert.strictEqual(ok.status, 201);
  for (const k of ['id', 'memberId', 'copyId', 'bookId', 'checkedOutOn', 'dueOn', 'returnedOn', 'renewals']) assert.ok(k in ok.body, k);
  assert.strictEqual(ok.body.bookId, 2);
  const taken = await checkout(app, 3, 9);
  assert.strictEqual(taken.status, 409);
  assert.strictEqual(taken.body.error.code, 'conflict');
  const invalid = await app.post('/api/loans', { copyId: 11 });
  assert.strictEqual(invalid.status, 422);
  assert.deepStrictEqual(invalid.body.error.fields, ['memberId']);
  const unknown = await checkout(app, 1, 99);
  assert.deepStrictEqual([unknown.status, unknown.body.error.code], [404, 'not_found']);
}));
