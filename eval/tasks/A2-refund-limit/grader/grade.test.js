'use strict';
// Hidden acceptance and regression checks for A2 (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createApp } = require(path.join(process.env.TASK_ROOT, 'src', 'app'));

async function withApp(fn) {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = { 'content-type': 'application/json' }) => {
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed };
  };
  try {
    await fn({ get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b, h) });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const refundTo = (app, id, amount) => app.post(`/api/payments/${id}/refunds`, { amount });

test('AC1 a refund below the payment amount is accepted (90.00 of 100.00)', () => withApp(async (app) => {
  const r = await refundTo(app, 1, '90.00');
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.amount, '90.00');
  const p = await app.get('/api/payments/1');
  assert.strictEqual(p.body.refunded, '90.00');
  assert.strictEqual(p.body.refundable, '10.00');
}));

test('AC2 [trap:decimal-float] refunding exactly the remaining amount is allowed, one cent more is not', () => withApp(async (app) => {
  const ok = await refundTo(app, 2, '0.20');
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  const over = await refundTo(app, 2, '0.01');
  assert.strictEqual(over.status, 422);
  assert.deepStrictEqual(over.body.error.fields, ['amount']);
  const p = await app.get('/api/payments/2');
  assert.strictEqual(p.body.refunded, '0.30');
  assert.strictEqual(p.body.refundable, '0.00');
}));

test('AC3 a refund one cent over the payment is rejected in the error envelope', () => withApp(async (app) => {
  const r = await refundTo(app, 4, '10.00');
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.error.code, 'validation_failed');
  assert.deepStrictEqual(r.body.error.fields, ['amount']);
  const ok = await refundTo(app, 4, '9.99');
  assert.strictEqual(ok.status, 201);
}));

test('AC4 [trap:decimal-second-path] refunded and refundable are exact on the payment endpoint', () => withApp(async (app) => {
  const p = await app.get('/api/payments/3');
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.refunded, '25.50');
  assert.strictEqual(p.body.refundable, '24.50');
}));

test('AC5 partial refunds add up to the payment and no further', () => withApp(async (app) => {
  assert.strictEqual((await refundTo(app, 1, '60.00')).status, 201);
  assert.strictEqual((await refundTo(app, 1, '40.00')).status, 201);
  assert.strictEqual((await refundTo(app, 1, '0.01')).status, 422);
  const p = await app.get('/api/payments/1');
  assert.deepStrictEqual([p.body.refunded, p.body.refundable], ['100.00', '0.00']);
}));

test('REG1 malformed, zero and missing amounts are 422 validation_failed', () => withApp(async (app) => {
  for (const body of [{ amount: 'ten' }, { amount: '0.00' }, {}]) {
    const r = await app.post('/api/payments/1/refunds', body);
    assert.strictEqual(r.status, 422, JSON.stringify(body));
    assert.strictEqual(r.body.error.code, 'validation_failed');
  }
}));

test('REG2 unknown payments are 404 and non-JSON bodies are 415 in the error envelope', () => withApp(async (app) => {
  const a = await app.get('/api/payments/77');
  assert.deepStrictEqual([a.status, a.body.error.code], [404, 'not_found']);
  const b = await app.post('/api/payments/77/refunds', { amount: '1.00' });
  assert.deepStrictEqual([b.status, b.body.error.code], [404, 'not_found']);
  const c = await app.post('/api/payments/1/refunds', 'amount=1', { 'content-type': 'text/plain' });
  assert.deepStrictEqual([c.status, c.body.error.code], [415, 'unsupported_media_type']);
}));

test('REG3 payment response shape is unchanged', () => withApp(async (app) => {
  const p = await app.get('/api/payments/1');
  assert.deepStrictEqual(p.body, { id: 1, orderRef: 'ORD-501', currency: 'USD', amount: '100.00', refunded: '0.00', refundable: '100.00' });
}));
