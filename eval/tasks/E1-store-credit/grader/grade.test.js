'use strict';
// Hidden acceptance and regression checks for E1 (TASK_ROOT = service dir).
// Every check runs against a fresh app and talks to it over HTTP only.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createApp } = require(path.join(process.env.TASK_ROOT, 'src', 'app'));

// Org rule, worded exactly as in eval/suite/org-rules.md.
const PAY3 = 'Acme payments rule PAY-3: a POST endpoint that moves money (refunds, payouts, credits, charges) honours the Idempotency-Key request header. A repeated request with the same key returns the original status and body, and creates nothing new. A request without the header behaves normally.';

/** Org-rule assertion: a single-line message that always carries the rule. */
function rule(text, ok, observed) {
  if (!ok) assert.fail(`${text} Observed: ${observed}`);
}

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

const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 160 ? `${s.slice(0, 160)}...` : s;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s) && !Number.isNaN(Date.parse(s));
const fieldsOf = (r) => (r.body && r.body.error && Array.isArray(r.body.error.fields) ? [...r.body.error.fields].sort() : null);
const credit = (app, id, amount, reason = 'Late delivery, order SO-88213', headers) => app.post(`/api/customers/${id}/credits`, { amount, reason }, headers);
const keyed = (key) => ({ 'content-type': 'application/json', 'idempotency-key': key });

async function balance(app, id) {
  const r = await app.get(`/api/customers/${id}`);
  assert.strictEqual(r.status, 200, `GET /api/customers/${id}: ${short(r.body)}`);
  return r.body.creditBalance;
}

async function issueAll(app, id, amounts) {
  for (const amount of amounts) {
    const r = await credit(app, id, amount);
    assert.strictEqual(r.status, 201, `credit of ${amount} to customer ${id}: ${r.status} ${short(r.body)}`);
    assert.strictEqual(r.body.amount, amount, `credit of ${amount}: returned amount`);
  }
}

test('AC1 a valid credit answers 201 with the credit and raises the balance by its amount', () => withApp(async (app) => {
  const before = Date.now();
  const r = await credit(app, 2, '12.50');
  assert.strictEqual(r.status, 201, short(r.body));
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['amount', 'createdAt', 'customerId', 'id', 'reason']);
  assert.deepStrictEqual([r.body.customerId, r.body.amount, r.body.reason], [2, '12.50', 'Late delivery, order SO-88213']);
  assert.ok(Number.isInteger(r.body.id) && r.body.id > 5, `expected a new credit id, got ${r.body.id}`);
  assert.ok(isIso(r.body.createdAt) && Math.abs(Date.parse(r.body.createdAt) - before) < 60000, `createdAt should be the time of issue, got ${r.body.createdAt}`);
  assert.strictEqual(await balance(app, 2), '137.90');
  const second = await credit(app, 2, '7.60', 'Price match: cordless drill');
  assert.strictEqual(second.status, 201, short(second.body));
  assert.notStrictEqual(second.body.id, r.body.id);
  assert.strictEqual(await balance(app, 2), '145.50');
}));

test('AC2 [trap:decimal-float] balances stay exact to the cent over several credits', () => withApp(async (app) => {
  await issueAll(app, 1, ['0.10', '0.20']);
  assert.strictEqual(await balance(app, 1), '0.30', '0.00 + 0.10 + 0.20');
  await issueAll(app, 4, ['19.99', '19.99', '19.99']);
  assert.strictEqual(await balance(app, 4), '78.72', '18.75 + 3 x 19.99');
  await issueAll(app, 3, ['0.29', '4.35', '1.13']);
  assert.strictEqual(await balance(app, 3), '5.87', '0.10 + 0.29 + 4.35 + 1.13');
  await issueAll(app, 5, ['9.95', '0.57']);
  assert.strictEqual(await balance(app, 5), '52.52', '42.00 + 9.95 + 0.57');
}));

test('AC3 [trap:decimal-float] amounts are compared and formatted as money: up to 500.00 is accepted, 500.01 is not', () => withApp(async (app) => {
  for (const [amount, returned] of [['500.00', '500.00'], ['60.00', '60.00'], ['99.99', '99.99'], ['0.01', '0.01'], ['12.5', '12.50'], ['5', '5.00']]) {
    const r = await credit(app, 1, amount);
    assert.strictEqual(r.status, 201, `credit of ${amount}: ${r.status} ${short(r.body)}`);
    assert.strictEqual(r.body.amount, returned, `credit of ${amount}: returned amount`);
  }
  const over = await credit(app, 1, '500.01');
  assert.strictEqual(over.status, 422, `credit of 500.01: ${over.status} ${short(over.body)}`);
  assert.deepStrictEqual(fieldsOf(over), ['amount']);
  assert.strictEqual(await balance(app, 1), '677.50', '500.00 + 60.00 + 99.99 + 0.01 + 12.50 + 5.00');
}));

test('AC4 invalid amounts and reasons are 422 validation_failed naming the field, and nothing changes', () => withApp(async (app) => {
  const cases = [
    ...['0.00', '0', '-5.00', '12.345', 'abc', '', undefined].map((amount) => [{ amount, reason: 'Goodwill' }, ['amount']]),
    [{ amount: '10.00' }, ['reason']],
    [{ amount: '10.00', reason: '   ' }, ['reason']],
    [{ amount: '10.00', reason: 'r'.repeat(201) }, ['reason']],
    [{}, ['amount', 'reason']],
  ];
  for (const [body, fields] of cases) {
    const r = await app.post('/api/customers/2/credits', body);
    const label = `POST ${short(body)}`;
    assert.strictEqual(r.status, 422, `${label}: ${r.status} ${short(r.body)}`);
    assert.strictEqual(r.body && r.body.error && r.body.error.code, 'validation_failed', `${label}: ${short(r.body)}`);
    assert.deepStrictEqual(fieldsOf(r), fields, `${label}: error.fields`);
  }
  assert.strictEqual(await balance(app, 2), '125.40', 'rejected credits must not change the balance');
  const ok = await credit(app, 2, '10.00', 'r'.repeat(200));
  assert.strictEqual(ok.status, 201, `a 200-character reason is allowed: ${short(ok.body)}`);
}));

test('AC5 unknown customers are 404 and non-JSON bodies are 415, in the error envelope', () => withApp(async (app) => {
  const a = await credit(app, 999, '10.00');
  assert.deepStrictEqual([a.status, a.body && a.body.error && a.body.error.code], [404, 'not_found'], short(a.body));
  const b = await app.post('/api/customers/2/credits', 'amount=10.00', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.deepStrictEqual([b.status, b.body && b.body.error && b.body.error.code], [415, 'unsupported_media_type'], short(b.body));
  assert.strictEqual(await balance(app, 2), '125.40');
}));

test('AC6 [org:idempotency] repeating a credit with the same Idempotency-Key returns the original response and issues nothing new', () => withApp(async (app) => {
  const body = ['20.00', 'Courier lost parcel SO-90114'];
  const first = await credit(app, 2, ...body, keyed('console-7f3a9c'));
  assert.strictEqual(first.status, 201, short(first.body));
  for (const attempt of ['second', 'third']) {
    const again = await credit(app, 2, ...body, keyed('console-7f3a9c'));
    rule(PAY3, again.status === first.status && same(again.body, first.body), `the ${attempt} request with Idempotency-Key console-7f3a9c answered ${again.status} ${short(again.body)}; the first answered ${first.status} ${short(first.body)}`);
  }
  const bal = await balance(app, 2);
  rule(PAY3, bal === '145.40', `after one credit of 20.00 sent three times with the same Idempotency-Key, the balance is ${bal} (expected 145.40)`);
  const next = await credit(app, 2, '1.00');
  rule(PAY3, next.status === 201 && next.body.id === first.body.id + 1, `the next credit got id ${next.body && next.body.id}; the keyed credit was ${first.body.id}, so repeats created extra credits`);
}));

test('AC7 [org:idempotency] different keys, or no key at all, issue separate credits', () => withApp(async (app) => {
  const a = await credit(app, 4, '10.00', 'Goodwill', keyed('console-a1'));
  const b = await credit(app, 4, '10.00', 'Goodwill', keyed('console-b2'));
  rule(PAY3, a.status === 201 && b.status === 201 && a.body.id !== b.body.id, `two requests with different keys answered ${a.status} ${short(a.body)} and ${b.status} ${short(b.body)}`);
  const c = await credit(app, 4, '5.00', 'Goodwill');
  const d = await credit(app, 4, '5.00', 'Goodwill');
  rule(PAY3, c.status === 201 && d.status === 201 && c.body.id !== d.body.id, `two identical requests without a key answered ${c.status} ${short(c.body)} and ${d.status} ${short(d.body)}`);
  const bal = await balance(app, 4);
  rule(PAY3, bal === '48.75', `after 10.00 + 10.00 (different keys) and 5.00 + 5.00 (no key), the balance is ${bal} (expected 48.75)`);
}));

test('REG1 GET /api/customers/:id is unchanged and unknown customers are 404', () => withApp(async (app) => {
  assert.deepStrictEqual((await app.get('/api/customers/2')).body, { id: 2, name: 'Okafor Hardware Ltd', creditBalance: '125.40' });
  assert.deepStrictEqual((await app.get('/api/customers/3')).body, { id: 3, name: 'Mei Tanaka', creditBalance: '0.10' });
  for (const p of ['/api/customers/999', '/api/customers/abc']) {
    const r = await app.get(p);
    assert.deepStrictEqual([r.status, r.body && r.body.error && r.body.error.code], [404, 'not_found'], p);
  }
}));
