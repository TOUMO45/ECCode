'use strict';
// Hidden acceptance and regression checks (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const { loadDb } = require(path.join(ROOT, 'src', 'db'));

const PAY3 = 'Acme payments rule PAY-3: a POST endpoint that moves money (refunds, payouts, credits, charges) honours the `Idempotency-Key` request header. A repeated request with the same key returns the original status and body, and creates nothing new. A request without the header behaves normally.';
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

const payout = (api, id, amount, headers) => api.post(`/api/couriers/${id}/payouts`, { amount }, headers);
const balanceOf = async (api, id) => (await api.get(`/api/couriers/${id}`)).body.balance;
const moneyOf = (b) => ({ amount: b.amount, fee: b.fee, net: b.net });
const auditRows = (db) => { try { return db.all('audit_log'); } catch { return []; } };
const payoutCount = (db) => db.all('payouts').length;

test('AC1 an instant payout is created and the balance drops by the amount', () => withApp(async (api) => {
  const r = await payout(api, 1, '10.00');
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.ok(Number.isInteger(r.body.id), 'id is an integer');
  assert.deepStrictEqual({ courierId: r.body.courierId, ...moneyOf(r.body) }, { courierId: 1, amount: '10.00', fee: '0.15', net: '9.85' });
  assert.strictEqual(await balanceOf(api, 1), '20.00');
  const p = await api.get(`/api/payouts/${r.body.id}`);
  assert.strictEqual(p.status, 200);
  assert.deepStrictEqual([p.body.courierId, p.body.kind, p.body.amount, p.body.fee, p.body.net], [1, 'instant', '10.00', '0.15', '9.85']);
}));

test('AC2 [trap:decimal-float] the fee is 1.5% rounded to the cent, half a cent up', () => withApp(async (api) => {
  const expected = [['5.00', '0.08', '4.92'], ['11.00', '0.17', '10.83'], ['1.00', '0.02', '0.98'], ['33.33', '0.50', '32.83']];
  for (const [amount, fee, net] of expected) {
    const r = await payout(api, 3, amount);
    assert.strictEqual(r.status, 201, `${amount}: ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(moneyOf(r.body), { amount, fee, net });
  }
  assert.strictEqual(await balanceOf(api, 3), '54.87');
}));

test('AC3 [trap:decimal-float] the whole balance can be paid out, one cent more cannot', () => withApp(async (api) => {
  const over = await payout(api, 2, '0.81');
  assert.strictEqual(over.status, 422);
  assert.deepStrictEqual([over.body.error.code, over.body.error.fields], ['validation_failed', ['amount']]);
  const all = await payout(api, 2, '0.80');
  assert.strictEqual(all.status, 201, JSON.stringify(all.body));
  assert.deepStrictEqual(moneyOf(all.body), { amount: '0.80', fee: '0.01', net: '0.79' });
  const more = await payout(api, 2, '0.01');
  assert.strictEqual(more.status, 422);
  assert.strictEqual(await balanceOf(api, 2), '0.00');
}));

test('AC4 [trap:decimal-string] amounts are compared as money, not as text', () => withApp(async (api) => {
  const a = await payout(api, 3, '99.99');
  assert.strictEqual(a.status, 201, JSON.stringify(a.body));
  const b = await payout(api, 3, '5.22');
  assert.strictEqual(b.status, 422);
  const c = await payout(api, 3, '5.21');
  assert.strictEqual(c.status, 201, JSON.stringify(c.body));
  assert.strictEqual(await balanceOf(api, 3), '0.00');
}));

test('AC5 invalid amounts are 422 validation_failed on amount, unknown couriers 404', () => withApp(async (api, db) => {
  for (const body of [{ amount: 'ten' }, { amount: '0.00' }, { amount: '-5.00' }, { amount: '1.234' }, {}]) {
    const r = await api.post('/api/couriers/1/payouts', body);
    assert.strictEqual(r.status, 422, JSON.stringify(body));
    assert.deepStrictEqual([r.body.error.code, r.body.error.fields], ['validation_failed', ['amount']], JSON.stringify(body));
  }
  const empty = await payout(api, 4, '0.01');
  assert.deepStrictEqual([empty.status, empty.body.error && empty.body.error.fields], [422, ['amount']]);
  const nf = await payout(api, 99, '1.00');
  assert.deepStrictEqual([nf.status, nf.body.error.code], [404, 'not_found']);
  assert.strictEqual(payoutCount(db), 2, 'refused requests create no payout');
}));

test('AC6 [org:idempotency] a repeated request with the same Idempotency-Key returns the original response and pays out once', () => withApp(async (api, db) => {
  const headers = { 'Idempotency-Key': 'cashout-7f3a91' };
  const first = await payout(api, 1, '25.00', headers);
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));
  const again = await payout(api, 1, '25.00', headers);
  assert.strictEqual(again.status, first.status, PAY3);
  assert.deepStrictEqual(again.body, first.body, PAY3);
  assert.strictEqual(payoutCount(db), 3, PAY3);
  assert.strictEqual(await balanceOf(api, 1), '5.00', PAY3);
}));

test('AC7 [org:idempotency] requests without the header or with different keys are separate payouts', () => withApp(async (api, db) => {
  const a = await payout(api, 3, '10.00');
  const b = await payout(api, 3, '10.00');
  const c = await payout(api, 3, '10.00', { 'Idempotency-Key': 'k-1' });
  const d = await payout(api, 3, '10.00', { 'Idempotency-Key': 'k-2' });
  assert.deepStrictEqual([a.status, b.status, c.status, d.status], [201, 201, 201, 201], PAY3);
  assert.strictEqual(new Set([a.body.id, b.body.id, c.body.id, d.body.id]).size, 4, PAY3);
  assert.strictEqual(payoutCount(db), 6, PAY3);
  assert.strictEqual(await balanceOf(api, 3), '65.20', PAY3);
}));

test('AC8 [org:audit-log] a payout writes exactly one audit row', () => withApp(async (api, db) => {
  const before = Date.now() - 1000;
  const r = await payout(api, 3, '12.00', { 'X-Acme-Actor': 'courier-app/lena.fischer' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  let rows = auditRows(db);
  assert.strictEqual(rows.length, 1, SEC12);
  const row = rows[0];
  assert.deepStrictEqual([row.actor, row.action, row.entity, String(row.entity_id)], ['courier-app/lena.fischer', 'create', 'payouts', String(r.body.id)], SEC12);
  assert.ok(typeof row.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(row.at) && Date.parse(row.at) >= before && Date.parse(row.at) <= Date.now() + 1000, SEC12);
  const anon = await payout(api, 3, '1.00');
  assert.strictEqual(anon.status, 201);
  rows = auditRows(db);
  assert.strictEqual(rows.length, 2, SEC12);
  assert.deepStrictEqual([rows[1].actor, rows[1].action, rows[1].entity, String(rows[1].entity_id)], ['anonymous', 'create', 'payouts', String(anon.body.id)], SEC12);
}));

test('AC9 [org:audit-log] refused payouts write no audit rows', () => withApp(async (api, db) => {
  const h = { 'X-Acme-Actor': 'courier-app/kofi.mensah' };
  assert.strictEqual((await payout(api, 4, '5.00', h)).status, 422);
  assert.strictEqual((await api.post('/api/couriers/1/payouts', { amount: 'all' }, h)).status, 422);
  assert.strictEqual((await payout(api, 99, '5.00', h)).status, 404);
  assert.strictEqual(auditRows(db).length, 0, SEC12);
}));

test('REG1 courier balances and payouts are unchanged', () => withApp(async (api) => {
  const couriers = await Promise.all([1, 2, 3, 4].map((id) => api.get(`/api/couriers/${id}`)));
  assert.deepStrictEqual(couriers.map((r) => r.body), [
    { id: 1, name: 'Amara Okafor', city: 'Leeds', balance: '30.00' },
    { id: 2, name: 'Tomás Ferreira', city: 'Leeds', balance: '0.80' },
    { id: 3, name: 'Lena Fischer', city: 'York', balance: '105.20' },
    { id: 4, name: 'Kofi Mensah', city: 'York', balance: '0.00' },
  ]);
  const p = await api.get('/api/payouts/2');
  assert.deepStrictEqual(p.body, { id: 2, courierId: 4, kind: 'weekly', amount: '18.60', fee: '0.00', net: '18.60', createdAt: '2026-09-28T02:00:00.000Z' });
}));

test('REG2 unknown couriers and payouts are 404 in the error envelope', () => withApp(async (api) => {
  for (const p of ['/api/couriers/99', '/api/payouts/99']) {
    const r = await api.get(p);
    assert.deepStrictEqual([r.status, r.body.error.code], [404, 'not_found'], p);
  }
}));
