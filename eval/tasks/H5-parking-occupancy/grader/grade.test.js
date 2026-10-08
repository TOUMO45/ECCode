'use strict';
// Hidden acceptance and regression checks (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const { loadDb } = require(path.join(ROOT, 'src', 'db'));

/** One app instance; counts reads of the parking_sessions table. */
async function withApp(fn) {
  const raw = loadDb();
  const reads = { sessions: 0 };
  const db = {
    ...raw,
    all: (t, ...a) => { if (t === 'parking_sessions') reads.sessions++; return raw.all(t, ...a); },
  };
  const server = createApp({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed };
  };
  const api = {
    get: (p) => call('GET', p),
    enter: (lot, plate) => call('POST', `/api/lots/${lot}/entries`, { plate }),
    exit: (id) => call('POST', `/api/sessions/${id}/exit`),
    occ: async (lot) => (await call('GET', `/api/lots/${lot}/occupancy`)).body,
  };
  try { await fn(api, reads); } finally { await new Promise((r) => server.close(r)); }
}

const counts = (o) => ({ occupied: o.occupied, free: o.free, full: o.full });

test('AC1 [trap:cache-invalidation] a car entering is counted immediately', () => withApp(async (api) => {
  assert.deepStrictEqual(counts(await api.occ(3)), { occupied: 5, free: 7, full: false });
  assert.strictEqual((await api.enter(3, 'NV19 XRK')).status, 201);
  assert.deepStrictEqual(counts(await api.occ(3)), { occupied: 6, free: 6, full: false });
  assert.strictEqual((await api.enter(3, 'RE20 PLM')).status, 201);
  assert.deepStrictEqual(counts(await api.occ(3)), { occupied: 7, free: 5, full: false });
}));

test('AC2 [trap:cache-invalidation] a car leaving frees its space immediately', () => withApp(async (api) => {
  assert.deepStrictEqual(counts(await api.occ(3)), { occupied: 5, free: 7, full: false });
  assert.strictEqual((await api.exit(12)).status, 200);
  assert.deepStrictEqual(counts(await api.occ(3)), { occupied: 4, free: 8, full: false });
  assert.strictEqual((await api.exit(10)).status, 200);
  assert.deepStrictEqual(counts(await api.occ(3)), { occupied: 3, free: 9, full: false });
}));

test('AC3 [trap:cache-invalidation] a full lot lets the next car in as soon as a space is free', () => withApp(async (api) => {
  assert.deepStrictEqual(counts(await api.occ(1)), { occupied: 4, free: 0, full: true });
  const refused = await api.enter(1, 'GX21 BVC');
  assert.deepStrictEqual([refused.status, refused.body.error && refused.body.error.code], [409, 'conflict']);
  assert.strictEqual((await api.exit(3)).status, 200);
  assert.deepStrictEqual(counts(await api.occ(1)), { occupied: 3, free: 1, full: false });
  const admitted = await api.enter(1, 'GX21 BVC');
  assert.strictEqual(admitted.status, 201, JSON.stringify(admitted.body));
  assert.deepStrictEqual(counts(await api.occ(1)), { occupied: 4, free: 0, full: true });
  assert.strictEqual((await api.enter(1, 'TT70 AAA')).status, 409);
}));

test('AC4 [trap:cache-invalidation] the gate never lets in more cars than there are spaces', () => withApp(async (api) => {
  assert.deepStrictEqual(counts(await api.occ(2)), { occupied: 1, free: 2, full: false });
  assert.strictEqual((await api.enter(2, 'BX66 KLO')).status, 201);
  assert.strictEqual((await api.enter(2, 'CY22 MMP')).status, 201);
  const third = await api.enter(2, 'DZ13 NNQ');
  assert.deepStrictEqual([third.status, third.body.error && third.body.error.code], [409, 'conflict']);
  assert.deepStrictEqual(counts(await api.occ(2)), { occupied: 3, free: 0, full: true });
}));

test('AC5 entering or leaving one lot does not change the others', () => withApp(async (api) => {
  const before = [counts(await api.occ(1)), counts(await api.occ(2))];
  assert.strictEqual((await api.enter(3, 'NV19 XRK')).status, 201);
  assert.strictEqual((await api.exit(11)).status, 200);
  assert.deepStrictEqual([counts(await api.occ(1)), counts(await api.occ(2))], before);
}));

test('REG1 occupancy and lot details are unchanged', () => withApp(async (api) => {
  assert.deepStrictEqual(await api.occ(1), { lotId: 1, name: 'Harbour Garage, EV bays', capacity: 4, occupied: 4, free: 0, full: true });
  assert.deepStrictEqual(await api.occ(2), { lotId: 2, name: 'Station Deck, short stay', capacity: 3, occupied: 1, free: 2, full: false });
  assert.deepStrictEqual(await api.occ(3), { lotId: 3, name: 'Market Square', capacity: 12, occupied: 5, free: 7, full: false });
  assert.deepStrictEqual((await api.get('/api/lots/2')).body, { id: 2, name: 'Station Deck, short stay', capacity: 3 });
}));

test('REG2 occupancy stays cached: repeated reads do not recount the sessions', () => withApp(async (api, reads) => {
  await api.occ(3);
  const first = reads.sessions;
  for (let i = 0; i < 10; i++) await api.occ(3);
  assert.strictEqual(reads.sessions, first, `parking_sessions scanned ${reads.sessions - first} more times for 10 repeated reads`);
}));

test('REG3 entry and exit errors are unchanged', () => withApp(async (api) => {
  const bad = await api.enter(3, '');
  assert.deepStrictEqual([bad.status, bad.body.error.code, bad.body.error.fields], [422, 'validation_failed', ['plate']]);
  const nl = await api.enter(9, 'AB12 CDE');
  assert.deepStrictEqual([nl.status, nl.body.error.code], [404, 'not_found']);
  const no = await api.get('/api/lots/9/occupancy');
  assert.deepStrictEqual([no.status, no.body.error.code], [404, 'not_found']);
  const ns = await api.exit(999);
  assert.deepStrictEqual([ns.status, ns.body.error.code], [404, 'not_found']);
  const done = await api.exit(5);
  assert.deepStrictEqual([done.status, done.body.error.code], [409, 'conflict']);
  const ok = await api.enter(3, 'ab12 cde');
  assert.deepStrictEqual([ok.status, ok.body.lotId, ok.body.plate, ok.body.exitedAt], [201, 3, 'AB12 CDE', null]);
  const out = await api.exit(ok.body.sessionId);
  assert.deepStrictEqual([out.status, out.body.plate], [200, 'AB12 CDE']);
  assert.ok(out.body.exitedAt);
}));
