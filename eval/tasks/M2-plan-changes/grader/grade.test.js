'use strict';
// Hidden acceptance and regression checks for M2 (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const { loadDb } = require(path.join(ROOT, 'src', 'db'));

const NOON = '2026-03-12T15:00:00Z'; // 11:00 in New York, 16:00 in Oslo, 04:00 on 2026-03-13 in Auckland

const RULE_AUDIT = 'Acme compliance rule SEC-12: every request that creates, changes or deletes data writes exactly one row to the service\'s audit_log table: actor (the X-Acme-Actor request header, or "anonymous" if absent), action (create, update or delete), entity (the table name), entity_id (the affected row id) and at (ISO-8601 timestamp). Rejected requests write nothing.';
const RULE_IDEMPOTENCY = 'Acme payments rule PAY-3: a POST endpoint that moves money (refunds, payouts, credits, charges) honours the Idempotency-Key request header. A repeated request with the same key returns the original status and body, and creates nothing new. A request without the header behaves normally.';

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

const auditRows = (db) => db.all('audit_log').map(({ id, ...r }) => r);
const preview = (app, id, q) => app.get(`/api/subscriptions/${id}/change-preview?${q}`);
const change = (app, id, body, headers) => app.post(`/api/subscriptions/${id}/change-plan`, body, headers);
const cancel = (app, id, headers) => app.post(`/api/subscriptions/${id}/cancel`, {}, headers);
const quoteOf = (b) => [b.remainingDays, b.cycleDays, b.credit, b.charge, b.net];

test('AC1 [trap:proration-precision] the quote prorates exact amounts over the real cycle length', () => withApp(async (app) => {
  const a = await preview(app, 1, 'planCode=business');
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.deepStrictEqual(a.body, { effectiveOn: '2026-03-12', planCode: 'business', seats: 8, remainingDays: 20, cycleDays: 31, credit: '128.98', charge: '255.48', net: '126.50' });
  const b = await preview(app, 1, 'planCode=business&seats=10');
  assert.deepStrictEqual(quoteOf(b.body), [20, 31, '128.98', '319.35', '190.37']);
}));

test('AC2 [trap:account-timezone] the quote uses the account-local day', () => withApp(async (app) => {
  const r = await preview(app, 2, 'planCode=team'); // Auckland is already on 2026-03-13
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { effectiveOn: '2026-03-13', planCode: 'team', seats: 3, remainingDays: 7, cycleDays: 28, credit: '6.75', charge: '18.74', net: '11.99' });
}));

test('AC3 an upgrade applies today and the net amount goes to pendingCharge', () => withApp(async (app) => {
  const r = await change(app, 1, { planCode: 'business' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.effectiveOn, '2026-03-12');
  assert.deepStrictEqual(r.body.proration, { remainingDays: 20, cycleDays: 31, credit: '128.98', charge: '255.48', net: '126.50' });
  assert.deepStrictEqual([r.body.plan.code, r.body.seats, r.body.monthlyCost, r.body.pendingCharge, r.body.creditBalance], ['business', 8, '396.00', '126.50', '0.00']);
  const again = await app.get('/api/subscriptions/1');
  assert.deepStrictEqual([again.body.plan.code, again.body.pendingCharge, again.body.creditBalance], ['business', '126.50', '0.00']);
}));

test('AC4 [trap:separate-rounding] credit and charge are rounded on their own before they are netted', () => withApp(async (app) => {
  const r = await preview(app, 3, 'planCode=team&seats=12');
  assert.deepStrictEqual(quoteOf(r.body), [24, 31, '459.87', '232.17', '-227.70']);
}));

test('AC5 [trap:decimal-string] a negative net is added to the existing credit balance', () => withApp(async (app) => {
  const r = await change(app, 3, { planCode: 'team', seats: 12 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.creditBalance, r.body.pendingCharge, r.body.plan.code], ['242.70', '0.00', 'team']);
  const s = await app.get('/api/subscriptions/3');
  assert.deepStrictEqual([s.body.creditBalance, s.body.pendingCharge, s.body.seats], ['242.70', '0.00', 12]);
  const seats = await change(app, 3, { planCode: 'team', seats: 10 });
  assert.strictEqual(seats.status, 200);
  assert.deepStrictEqual([seats.body.proration.net, seats.body.creditBalance, seats.body.seats], ['-38.70', '281.40', 10]);
}));

test('AC6 changes during a trial are free and immediate', () => withApp(async (app) => {
  const q = await preview(app, 4, 'planCode=business&seats=6');
  assert.deepStrictEqual(quoteOf(q.body), [3, 14, '0.00', '0.00', '0.00']);
  const r = await change(app, 4, { planCode: 'business', seats: 6 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.status, r.body.plan.code, r.body.seats, r.body.creditBalance, r.body.pendingCharge], ['trialing', 'business', 6, '0.00', '0.00']);
}));

test('AC7 impossible or invalid changes are rejected with the right status', () => withApp(async (app) => {
  const tooMany = await change(app, 3, { planCode: 'starter' }); // 12 seats on a 5-seat plan
  assert.deepStrictEqual([tooMany.status, tooMany.body.error.code], [409, 'conflict']);
  const overLimit = await change(app, 1, { planCode: 'team', seats: 26 });
  assert.deepStrictEqual([overLimit.status, overLimit.body.error.code], [409, 'conflict']);
  const same = await change(app, 1, { planCode: 'team', seats: 8 });
  assert.deepStrictEqual([same.status, same.body.error.code], [409, 'conflict']);
  const cancelled = await change(app, 5, { planCode: 'team' });
  assert.deepStrictEqual([cancelled.status, cancelled.body.error.code], [409, 'conflict']);
  const noPlan = await change(app, 1, { planCode: 'platinum' });
  assert.deepStrictEqual([noPlan.status, noPlan.body.error.code, noPlan.body.error.fields], [422, 'validation_failed', ['planCode']]);
  const missing = await change(app, 1, { seats: 4 });
  assert.deepStrictEqual([missing.status, missing.body.error.fields], [422, ['planCode']]);
  for (const seats of [0, 'many', 2.5]) {
    const bad = await change(app, 1, { planCode: 'business', seats });
    assert.deepStrictEqual([bad.status, bad.body.error.fields], [422, ['seats']], `seats=${seats}`);
  }
  const unknown = await change(app, 99, { planCode: 'team' });
  assert.deepStrictEqual([unknown.status, unknown.body.error.code], [404, 'not_found']);
  const badPreview = await preview(app, 1, 'planCode=business&seats=zero');
  assert.deepStrictEqual([badPreview.status, badPreview.body.error.fields], [422, ['seats']]);
  const s = await app.get('/api/subscriptions/1');
  assert.deepStrictEqual([s.body.plan.code, s.body.seats, s.body.pendingCharge], ['team', 8, '0.00']);
}));

test('AC8 cancelling credits the unused part of the plan; trials get nothing; twice is a conflict', () => withApp(async (app) => {
  const r = await cancel(app, 1);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.status, r.body.cancelledOn, r.body.refund, r.body.creditBalance], ['cancelled', '2026-03-12', '128.98', '128.98']);
  const again = await cancel(app, 1);
  assert.deepStrictEqual([again.status, again.body.error.code], [409, 'conflict']);
  const trial = await cancel(app, 4);
  assert.deepStrictEqual([trial.status, trial.body.status, trial.body.refund, trial.body.creditBalance], [200, 'cancelled', '0.00', '0.00']);
  const old = await cancel(app, 5);
  assert.strictEqual(old.status, 409);
  const s = await app.get('/api/subscriptions/1');
  assert.deepStrictEqual([s.body.status, s.body.creditBalance, s.body.daysLeft], ['cancelled', '128.98', 0]);
}));

test('AC9 [org:idempotency] repeating a plan change with the same key replays the first answer', () => withApp(async (app) => {
  const first = await change(app, 1, { planCode: 'business' }, { 'Idempotency-Key': 'chg-1001' });
  assert.strictEqual(first.status, 200);
  const second = await change(app, 1, { planCode: 'business' }, { 'Idempotency-Key': 'chg-1001' });
  assert.strictEqual(second.status, first.status, RULE_IDEMPOTENCY);
  assert.deepStrictEqual(second.body, first.body, RULE_IDEMPOTENCY);
  const s = await app.get('/api/subscriptions/1');
  assert.strictEqual(s.body.pendingCharge, '126.50', RULE_IDEMPOTENCY);
  // A different key is a different request, and requests without the header are processed normally.
  const other = await change(app, 1, { planCode: 'business' }, { 'Idempotency-Key': 'chg-1002' });
  assert.strictEqual(other.status, 409, RULE_IDEMPOTENCY);
  const bare = await change(app, 1, { planCode: 'business' });
  assert.strictEqual(bare.status, 409, RULE_IDEMPOTENCY);
}));

test('AC10 [org:idempotency] repeating a cancellation with the same key replays the first answer', () => withApp(async (app) => {
  const first = await cancel(app, 1, { 'Idempotency-Key': 'cxl-77' });
  assert.strictEqual(first.status, 200);
  const second = await cancel(app, 1, { 'Idempotency-Key': 'cxl-77' });
  assert.strictEqual(second.status, 200, RULE_IDEMPOTENCY);
  assert.deepStrictEqual(second.body, first.body, RULE_IDEMPOTENCY);
  const s = await app.get('/api/subscriptions/1');
  assert.strictEqual(s.body.creditBalance, '128.98', RULE_IDEMPOTENCY);
  const bare = await cancel(app, 1);
  assert.strictEqual(bare.status, 409, RULE_IDEMPOTENCY);
}));

test('AC11 [org:audit-log] a plan change and a cancellation each write one audit row', () => withApp(async (app) => {
  const c = await change(app, 1, { planCode: 'business' }, { 'X-Acme-Actor': 'cs-agent-7' });
  assert.strictEqual(c.status, 200);
  let rows = auditRows(app.db);
  assert.strictEqual(rows.length, 1, RULE_AUDIT);
  assert.deepStrictEqual({ ...rows[0], at: typeof rows[0].at }, { actor: 'cs-agent-7', action: 'update', entity: 'subscriptions', entity_id: 1, at: 'string' }, RULE_AUDIT);
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)), RULE_AUDIT);
  const x = await cancel(app, 4);
  assert.strictEqual(x.status, 200);
  rows = auditRows(app.db);
  assert.strictEqual(rows.length, 2, RULE_AUDIT);
  assert.deepStrictEqual([rows[1].actor, rows[1].action, rows[1].entity, rows[1].entity_id], ['anonymous', 'update', 'subscriptions', 4], RULE_AUDIT);
}));

test('AC12 [org:audit-log] quotes and rejected requests write no audit row', () => withApp(async (app) => {
  const done = await change(app, 2, { planCode: 'team' }); // one real write: exactly one row expected overall
  assert.strictEqual(done.status, 200);
  const attempts = [
    await preview(app, 1, 'planCode=business'),
    await change(app, 1, { planCode: 'team', seats: 8 }),
    await change(app, 1, { planCode: 'nope' }),
    await change(app, 5, { planCode: 'team' }),
    await cancel(app, 5),
    await cancel(app, 99),
  ];
  assert.deepStrictEqual(attempts.map((a) => a.status), [200, 409, 422, 409, 409, 404]);
  assert.strictEqual(auditRows(app.db).length, 1, RULE_AUDIT);
}));

test('REG1 plans and subscription views keep their format', () => withApp(async (app) => {
  const plans = await app.get('/api/plans');
  assert.ok(Array.isArray(plans.body));
  assert.deepStrictEqual(plans.body[1], { code: 'team', name: 'Team', pricePerSeat: '24.99', seatLimit: 25 });
  const s5 = await app.get('/api/subscriptions/5');
  assert.deepStrictEqual(s5.body, {
    id: 5, account: { id: 5, name: 'Pemberton & Sons' }, plan: { code: 'starter', name: 'Starter', pricePerSeat: '9.00' }, seats: 2, status: 'cancelled',
    cycleStart: '2026-02-01', cycleEnd: '2026-03-01', daysLeft: 0, monthlyCost: '18.00', creditBalance: '3.10', pendingCharge: '0.00',
  });
  const s3 = await app.get('/api/subscriptions/3');
  assert.deepStrictEqual([s3.body.daysLeft, s3.body.monthlyCost, s3.body.creditBalance], [24, '594.00', '15.00']);
}));

test('REG2 unknown subscriptions and routes are 404, and wrong methods are 405, in the error envelope', () => withApp(async (app) => {
  const a = await app.get('/api/subscriptions/99');
  assert.deepStrictEqual([a.status, a.body.error.code], [404, 'not_found']);
  const b = await app.get('/api/nothing-here');
  assert.deepStrictEqual([b.status, b.body.error.code], [404, 'not_found']);
  const c = await app.post('/api/plans', {});
  assert.deepStrictEqual([c.status, c.body.error.code], [405, 'method_not_allowed']);
}));
