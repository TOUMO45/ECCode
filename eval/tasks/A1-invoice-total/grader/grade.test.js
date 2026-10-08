'use strict';
// Hidden acceptance and regression checks for A1. Run with TASK_ROOT set to
// the service directory. Test names start with the check id; [trap:<tag>]
// marks checks that a known wrong approach fails.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));

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
  try { await fn(get); } finally { await new Promise((r) => server.close(r)); }
}

const totalsOf = (b) => ({ subtotal: b.subtotal, discount: b.discount, shipping: b.shipping, total: b.total });
const csvTotal = (csv) => csv.trim().split('\n').pop();

test('AC1 shipping fee is added to the total (INV-1042)', () => withApp(async (get) => {
  const { status, body } = await get('/api/invoices/2');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(totalsOf(body), { subtotal: '120.00', discount: '0.00', shipping: '15.00', total: '135.00' });
}));

test('AC2 [trap:decimal-float] percentage discount is exact to the cent, rounded half away from zero (INV-1043)', () => withApp(async (get) => {
  const { body } = await get('/api/invoices/3');
  assert.deepStrictEqual(totalsOf(body), { subtotal: '2.01', discount: '1.01', shipping: '0.00', total: '1.00' });
}));

test('AC3 mixed cents, discount and shipping are exact (INV-1044)', () => withApp(async (get) => {
  const { body } = await get('/api/invoices/4');
  assert.deepStrictEqual(totalsOf(body), { subtotal: '60.47', discount: '6.05', shipping: '4.99', total: '59.41' });
  assert.deepStrictEqual(body.lines.map((l) => l.lineTotal), ['0.30', '0.20', '59.97']);
}));

test('AC4 [trap:decimal-second-path] CSV export totals match the JSON API', () => withApp(async (get) => {
  for (const [id, total] of [[1, '50.00'], [2, '135.00'], [3, '1.00'], [4, '59.41']]) {
    const { status, body } = await get(`/api/invoices/${id}/export.csv`);
    assert.strictEqual(status, 200);
    assert.strictEqual(csvTotal(body), `TOTAL,,,${total}`, `invoice ${id}`);
  }
  const { body } = await get('/api/invoices/4/export.csv');
  assert.deepStrictEqual(body.trim().split('\n').slice(1, 4), ['Cable,0.10,3,0.30', 'Plug,0.20,1,0.20', 'Hub,19.99,3,59.97']);
}));

test('AC5 the invoice list shows the same totals as the detail endpoint', () => withApp(async (get) => {
  const { body } = await get('/api/invoices');
  assert.deepStrictEqual(body.map((i) => [i.number, i.total]), [['INV-1041', '50.00'], ['INV-1042', '135.00'], ['INV-1043', '1.00'], ['INV-1044', '59.41']]);
}));

test('REG1 response shape and money formats are unchanged', () => withApp(async (get) => {
  const { body } = await get('/api/invoices/1');
  assert.deepStrictEqual(Object.keys(body).sort(), ['customer', 'discount', 'id', 'lines', 'number', 'shipping', 'subtotal', 'total']);
  assert.deepStrictEqual(body.lines[0], { description: 'Consulting hour', unitPrice: '25.00', quantity: 2, lineTotal: '50.00' });
  assert.deepStrictEqual(totalsOf(body), { subtotal: '50.00', discount: '0.00', shipping: '0.00', total: '50.00' });
}));

test('REG2 unknown invoices are 404 in the error envelope on both endpoints', () => withApp(async (get) => {
  for (const p of ['/api/invoices/99', '/api/invoices/99/export.csv']) {
    const { status, body } = await get(p);
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error.code, 'not_found');
  }
}));
