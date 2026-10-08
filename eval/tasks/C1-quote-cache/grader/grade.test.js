'use strict';
// Hidden acceptance and regression checks for C1 (TASK_ROOT = service dir).
// Quotes are checked over HTTP; the pricing engine's own call counter
// (src/pricing/engine.js stats(), a pricing-team client the task must not
// change) measures upstream calls. Each check uses a fresh app (fresh cache)
// and resets the counter.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const engine = require(path.join(ROOT, 'src', 'pricing', 'engine'));

async function withApp(fn) {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  };
  engine.resetStats();
  try {
    await fn({ get });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// [sku, qty, unitPrice, total] from the sandbox price book.
async function expectQuotes(app, sequence, label) {
  for (const [i, [sku, qty, unitPrice, total]] of sequence.entries()) {
    const r = await app.get(`/api/quote?sku=${sku}&qty=${qty}`);
    const before = sequence.slice(0, i).map(([s, q]) => `${s} x${q}`).join(', ') || 'nothing';
    assert.strictEqual(r.status, 200, `${sku} x${qty}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(r.body, { sku, qty, unitPrice, total }, `${label}: quote for ${sku} x${qty} after quoting ${before}`);
  }
}

test('AC1 quotes for one SKU use the tier of the requested quantity, whatever was quoted before', () => withApp(async (app) => {
  await expectQuotes(app, [
    ['CBL-1', 1, '4.20', '4.20'],
    ['CBL-1', 10, '3.80', '38.00'],
    ['CBL-1', 1, '4.20', '4.20'],
    ['CBL-1', 50, '3.10', '155.00'],
    ['CBL-1', 9, '4.20', '37.80'],
    ['CBL-1', 10, '3.80', '38.00'],
    ['CBL-1', 49, '3.80', '186.20'],
  ], 'CBL-1 sequence');
}));

test('AC2 [trap:memo-key] a volume quote followed by smaller quantities, across SKUs, gets each quantity its own price', () => withApp(async (app) => {
  await expectQuotes(app, [
    ['CBL-12', 10, '16.90', '169.00'],
    ['CBL-12', 1, '18.50', '18.50'],
    ['SW-24', 5, '172.50', '862.50'],
    ['SW-24', 1, '189.00', '189.00'],
    ['CBL-12', 50, '14.75', '737.50'],
    ['SW-24', 6, '172.50', '1035.00'],
    ['RJ45-100', 20, '9.49', '189.80'],
    ['RJ45-100', 19, '11.99', '227.81'],
    ['CBL-3', 2, '6.40', '12.80'],
    ['CBL-3', 12, '5.90', '70.80'],
  ], 'mixed sequence');
}));

test('AC3 [trap:memo-key-collision] SKUs whose codes extend each other get their own prices (CBL-1 x23 vs CBL-12 x3)', async () => {
  await withApp((app) => expectQuotes(app, [
    ['CBL-1', 23, '3.80', '87.40'],
    ['CBL-12', 3, '18.50', '55.50'],
    ['CBL-1', 25, '3.80', '95.00'],
    ['CBL-12', 5, '18.50', '92.50'],
  ], 'CBL-1 first'));
  await withApp((app) => expectQuotes(app, [
    ['CBL-12', 3, '18.50', '55.50'],
    ['CBL-1', 23, '3.80', '87.40'],
    ['CBL-12', 5, '18.50', '92.50'],
    ['CBL-1', 25, '3.80', '95.00'],
  ], 'CBL-12 first'));
});

test('AC4 [trap:memo-removed] repeated quotes call the pricing engine at most once per SKU and quantity, and stay correct', () => withApp(async (app) => {
  const sequence = [
    ['CBL-1', 10, '3.80', '38.00'],
    ['CBL-1', 10, '3.80', '38.00'],
    ['CBL-1', 1, '4.20', '4.20'],
    ['CBL-12', 3, '18.50', '55.50'],
    ['CBL-1', 10, '3.80', '38.00'],
    ['CBL-1', 1, '4.20', '4.20'],
    ['CBL-12', 3, '18.50', '55.50'],
    ['CBL-1', 23, '3.80', '87.40'],
    ['CBL-1', 23, '3.80', '87.40'],
  ];
  await expectQuotes(app, sequence, 'repeated quotes');
  const distinct = new Set(sequence.map(([s, q]) => `${s} ${q}`)).size;
  const { calls } = engine.stats();
  assert.ok(calls <= distinct, `the pricing engine was called ${calls} times for ${sequence.length} quotes of ${distinct} distinct SKU/quantity pairs; the README allows at most one call per SKU and quantity per minute`);
}));

test('REG1 unknown SKUs are 404 and invalid quote requests are 422 with the invalid fields', () => withApp(async (app) => {
  for (const q of ['sku=CBL-99&qty=1', 'sku=NOPE&qty=10']) {
    const r = await app.get(`/api/quote?${q}`);
    assert.deepStrictEqual([r.status, r.body && r.body.error && r.body.error.code], [404, 'not_found'], q);
  }
  for (const [q, fields] of [['sku=CBL-1&qty=0', ['qty']], ['sku=CBL-1&qty=-1', ['qty']], ['sku=CBL-1&qty=abc', ['qty']], ['sku=CBL-1&qty=1.5', ['qty']], ['sku=CBL-1&qty=10001', ['qty']], ['sku=CBL-1', ['qty']], ['qty=1', ['sku']], ['sku=cbl-1&qty=1', ['sku']]]) {
    const r = await app.get(`/api/quote?${q}`);
    assert.strictEqual(r.status, 422, `${q}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error.code, 'validation_failed', q);
    assert.deepStrictEqual(r.body.error.fields, fields, q);
  }
}));

test('REG2 quote and product responses keep their shape', () => withApp(async (app) => {
  assert.deepStrictEqual((await app.get('/api/quote?sku=SW-24&qty=2')).body, { sku: 'SW-24', qty: 2, unitPrice: '189.00', total: '378.00' });
  assert.deepStrictEqual((await app.get('/api/quote?sku=CBL-1&qty=10000')).body, { sku: 'CBL-1', qty: 10000, unitPrice: '3.10', total: '31000.00' });
  assert.deepStrictEqual((await app.get('/api/products/CBL-12')).body, { sku: 'CBL-12', name: 'Cat6 patch cable, 12 m' });
  const missing = await app.get('/api/products/CBL-99');
  assert.deepStrictEqual([missing.status, missing.body.error.code], [404, 'not_found']);
}));
