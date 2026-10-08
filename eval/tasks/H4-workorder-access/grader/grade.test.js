'use strict';
// Hidden acceptance and regression checks (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const { loadDb } = require(path.join(ROOT, 'src', 'db'));

/** One app instance; counts reads of the directory's site_assignments table. */
async function withApp(fn) {
  const raw = loadDb();
  const reads = { directory: 0 };
  const db = {
    ...raw,
    all: (t, ...a) => { if (t === 'site_assignments') reads.directory++; return raw.all(t, ...a); },
    get: (t, ...a) => { if (t === 'site_assignments') reads.directory++; return raw.get(t, ...a); },
  };
  const server = createApp({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, user) => {
    const res = await fetch(base + p, { headers: user ? { 'X-Acme-User': user } : {} });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body };
  };
  try { await fn(get, reads); } finally { await new Promise((r) => server.close(r)); }
}

/** Run [user, path, expectedStatus] steps in order against ONE app. */
const steps = (list) => withApp(async (get) => {
  const log = [];
  for (const [user, p, expected] of list) {
    const r = await get(p, user);
    log.push(`${user} ${p} -> ${r.status}`);
    assert.strictEqual(r.status, expected, `${log.join('; ')} (expected ${expected})`);
  }
});

test('AC1 [trap:memo-key] being refused at another site does not lock users out of their own site', async () => {
  await steps([['dana.ruiz', '/api/work-orders/2', 404], ['dana.ruiz', '/api/work-orders/1', 200], ['dana.ruiz', '/api/work-orders/3', 200]]);
  await steps([['omar.haddad', '/api/work-orders/1', 404], ['omar.haddad', '/api/work-orders/2', 200], ['omar.haddad', '/api/work-orders/5', 200]]);
});

test('AC2 [trap:memo-key] access at one site does not open other sites', async () => {
  await steps([['lee.chen', '/api/work-orders/1', 200], ['lee.chen', '/api/work-orders/2', 404], ['lee.chen', '/api/work-orders/5', 404]]);
  await steps([['dana.ruiz', '/api/work-orders/3', 200], ['dana.ruiz', '/api/work-orders/4', 404]]);
  await steps([['priya.shah', '/api/work-orders/2', 200], ['priya.shah', '/api/work-orders/4', 404], ['priya.shah', '/api/work-orders/1', 200]]);
});

test('AC3 [trap:memo-key-partial] seeing a work order does not unlock its cost breakdown', async () => {
  await steps([['lee.chen', '/api/work-orders/1', 200], ['lee.chen', '/api/work-orders/1/costs', 403]]);
  await steps([['dana.ruiz', '/api/work-orders/3', 200], ['dana.ruiz', '/api/work-orders/3/costs', 403]]);
  await steps([['omar.haddad', '/api/work-orders/5', 200], ['omar.haddad', '/api/work-orders/5/costs', 403], ['omar.haddad', '/api/work-orders/2/costs', 403]]);
});

test('AC4 [trap:memo-key-partial] a refused cost breakdown does not hide the work order itself', async () => {
  await steps([['lee.chen', '/api/work-orders/1/costs', 403], ['lee.chen', '/api/work-orders/1', 200]]);
  await steps([['dana.ruiz', '/api/work-orders/1/costs', 403], ['dana.ruiz', '/api/work-orders/3/costs', 403], ['dana.ruiz', '/api/work-orders/3', 200]]);
});

test('AC5 supervisors get cost breakdowns at their own sites only, whatever came before', () => withApp(async (get) => {
  assert.strictEqual((await get('/api/work-orders/1/costs', 'grace.obi')).status, 403);
  const own = await get('/api/work-orders/2/costs', 'grace.obi');
  assert.strictEqual(own.status, 200, JSON.stringify(own.body));
  assert.deepStrictEqual(own.body, { workOrderId: 2, lines: [{ description: 'F7 bag filters (12)', amount: '318.00' }, { description: 'Labour, 6 h', amount: '390.00' }], total: '708.00' });
  assert.strictEqual((await get('/api/work-orders/4/costs', 'grace.obi')).status, 403);
  assert.strictEqual((await get('/api/work-orders/5/costs', 'grace.obi')).status, 200);
  assert.strictEqual((await get('/api/work-orders/2/costs', 'priya.shah')).status, 200);
  const p = await get('/api/work-orders/1/costs', 'priya.shah');
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.total, '446.05');
  assert.strictEqual((await get('/api/work-orders/4/costs', 'priya.shah')).status, 403);
}));

test('REG1 single requests get the same answers as before', async () => {
  const cases = [
    ['dana.ruiz', '/api/work-orders/1', 200], ['dana.ruiz', '/api/work-orders/2', 404], ['lee.chen', '/api/work-orders/3', 200],
    ['lee.chen', '/api/work-orders/1/costs', 403], ['priya.shah', '/api/work-orders/2/costs', 200], ['grace.obi', '/api/work-orders/1/costs', 403],
    ['nobody', '/api/work-orders/1', 404], ['dana.ruiz', '/api/work-orders/99', 404], ['priya.shah', '/api/work-orders/99/costs', 404],
    [null, '/api/work-orders/1', 401], [null, '/api/work-orders/1/costs', 401], [null, '/api/me', 401],
  ];
  for (const c of cases) await steps([c]);
  await withApp(async (get) => {
    const wo = await get('/api/work-orders/2', 'omar.haddad');
    assert.deepStrictEqual(wo.body, { id: 2, siteId: 2, site: 'Northgate Depot', title: 'Swap HVAC filters, levels 3-5', status: 'in_progress', priority: 'medium', openedAt: '2026-10-02T09:30:00.000Z' });
    const costs = await get('/api/work-orders/1/costs', 'priya.shah');
    assert.deepStrictEqual(costs.body, { workOrderId: 1, lines: [{ description: 'Mechanical seal kit', amount: '182.40' }, { description: 'Labour, 3.5 h', amount: '227.50' }, { description: 'Coolant top-up', amount: '36.15' }], total: '446.05' });
    const me = await get('/api/me', 'lee.chen');
    assert.deepStrictEqual(me.body, { username: 'lee.chen', name: 'Lee Chen', role: 'contractor', sites: [{ id: 1, name: 'Riverside Campus' }] });
    const missing = await get('/api/work-orders/1');
    assert.strictEqual(missing.body.error.code, 'unauthorized');
  });
});

test('REG2 access decisions stay cached: repeated requests do not query the directory again', () => withApp(async (get, reads) => {
  const round = [['dana.ruiz', '/api/work-orders/1', 200], ['lee.chen', '/api/work-orders/3', 200], ['priya.shah', '/api/work-orders/1/costs', 200], ['omar.haddad', '/api/work-orders/2', 200], ['grace.obi', '/api/work-orders/5/costs', 200]];
  for (const [u, p, s] of round) assert.strictEqual((await get(p, u)).status, s, `${u} ${p}`);
  const afterFirst = reads.directory;
  assert.ok(afterFirst > 0, 'the directory was consulted');
  for (let i = 0; i < 3; i++) for (const [u, p] of round) await get(p, u);
  assert.strictEqual(reads.directory, afterFirst, `directory lookups grew from ${afterFirst} to ${reads.directory} for repeated requests`);
}));
