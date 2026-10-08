'use strict';
// Hidden acceptance and regression checks for M4 (TASK_ROOT = service dir).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const { loadDb } = require(path.join(ROOT, 'src', 'db'));

const NOON = '2026-03-10T15:00:00Z';

const RULE_AUDIT = 'Acme compliance rule SEC-12: every request that creates, changes or deletes data writes exactly one row to the service\'s audit_log table: actor (the X-Acme-Actor request header, or "anonymous" if absent), action (create, update or delete), entity (the table name), entity_id (the affected row id) and at (ISO-8601 timestamp). Rejected requests write nothing.';
const RULE_IDEMPOTENCY = 'Acme payments rule PAY-3: a POST endpoint that moves money (refunds, payouts, credits, charges) honours the Idempotency-Key request header. A repeated request with the same key returns the original status and body, and creates nothing new. A request without the header behaves normally.';
const RULE_CSV = 'Acme accounting interface spec ACC-2: CSV files for accounting use CRLF (\\r\\n) line endings, start with a header row, wrap every text field in double quotes (doubling embedded quotes), and write amounts as plain decimals with two digits.';

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
    return { status: res.status, headers: res.headers, text, body: parsed };
  };
  try {
    await fn({ db, get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b, h) });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

/** Minimal RFC 4180 parser that keeps the raw text of each field. Accepts CRLF or LF. */
function parseCsv(input) {
  const records = [];
  let rec = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    let raw = '';
    let value = '';
    let quoted = false;
    if (input[i] === '"') {
      quoted = true;
      raw += '"';
      i++;
      while (i < n) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') { value += '"'; raw += '""'; i += 2; continue; }
          raw += '"';
          i++;
          break;
        }
        value += input[i];
        raw += input[i];
        i++;
      }
    } else {
      while (i < n && input[i] !== ',' && input[i] !== '\r' && input[i] !== '\n') { value += input[i]; raw += input[i]; i++; }
    }
    rec.push({ raw, value, quoted });
    if (input[i] === ',') { i++; continue; }
    if (input[i] === '\r' && input[i + 1] === '\n') { i += 2; records.push(rec); rec = []; continue; }
    if (input[i] === '\n' || input[i] === '\r') { i++; records.push(rec); rec = []; continue; }
  }
  if (rec.length) records.push(rec);
  return records;
}

const HEADER = ['donation_id', 'date', 'donor', 'email', 'amount', 'fee', 'charged', 'matched'];
const give = (app, cid, body, headers) => app.post(`/api/campaigns/${cid}/donations`, body, headers);
const auditRows = (db) => db.all('audit_log').map(({ id, ...r }) => r);
const receipts = (app, cid, year) => app.get(`/api/campaigns/${cid}/receipts.csv?year=${year}`);
const money = (d) => [d.amount, d.fee, d.covered, d.charged, d.credited, d.matched];
/** Values that do not depend on how text fields are quoted: id and date up front, the four amounts at the end. */
const receiptValues = (rec) => [rec[0].value, rec[1].value, ...rec.slice(-4).map((f) => f.value)];

test('AC1 [trap:match-cap] the sponsor match is capped by what is left in the pool, and later gifts get none', () => withApp(async (app) => {
  const a = await give(app, 1, { donorId: 5, amount: '50.00' });
  assert.strictEqual(a.status, 201, JSON.stringify(a.body));
  assert.deepStrictEqual(money(a.body), ['50.00', '1.75', false, '50.00', '48.25', '22.65']);
  assert.deepStrictEqual([a.body.id, a.body.campaignId, a.body.donorId, a.body.anonymous, a.body.createdAt], [11, 1, 5, false, '2026-03-10T15:00:00.000Z']);
  const b = await give(app, 1, { donorId: 3, amount: '10.00' });
  assert.deepStrictEqual(money(b.body), ['10.00', '0.59', false, '10.00', '9.41', '0.00']);
}));

test('AC2 [trap:decimal-float] the fee is 2.9% + 0.30 rounded half up; covering it changes what is charged, not what is received', () => withApp(async (app) => {
  const covered = await give(app, 1, { donorId: 5, amount: '15.00', coverFees: true, anonymous: true }); // 0.435 + 0.30
  assert.strictEqual(covered.status, 201, JSON.stringify(covered.body));
  assert.deepStrictEqual(money(covered.body), ['15.00', '0.74', true, '15.74', '15.00', '15.00']);
  assert.strictEqual(covered.body.anonymous, true);
  const plain = await give(app, 1, { donorId: 5, amount: '55.00' }); // 1.595 + 0.30
  assert.deepStrictEqual(money(plain.body), ['55.00', '1.90', false, '55.00', '53.10', '7.65']);
}));

test('AC3 [trap:end-inclusive] only live campaigns inside their dates take donations, the last day included', () => withApp(async (app) => {
  const lastDay = await give(app, 2, { donorId: 5, amount: '20.00' }); // library-roof ends today
  assert.strictEqual(lastDay.status, 201, JSON.stringify(lastDay.body));
  for (const id of [3, 4, 5]) {
    const r = await give(app, id, { donorId: 5, amount: '20.00' }); // closed, draft, not started yet
    assert.deepStrictEqual([r.status, r.body.error && r.body.error.code], [409, 'conflict'], `campaign ${id}`);
  }
  const unknown = await give(app, 99, { donorId: 5, amount: '20.00' });
  assert.deepStrictEqual([unknown.status, unknown.body.error.code], [404, 'not_found']);
  await withApp(async (a2) => {
    const r = await give(a2, 5, { donorId: 5, amount: '20.00' });
    assert.strictEqual(r.status, 201, 'a campaign takes donations on its first day');
  }, { now: '2026-03-11T00:00:00Z' });
  await withApp(async (a3) => {
    const r = await give(a3, 2, { donorId: 5, amount: '20.00' });
    assert.strictEqual(r.status, 409, 'the day after the end date is too late');
  }, { now: '2026-03-11T00:00:00Z' });
}));

test('AC4 amounts and ids are validated: 422 with the offending field', () => withApp(async (app) => {
  for (const amount of ['4.99', '10000.01', '12.345', 'ten', '', undefined]) {
    const r = await give(app, 2, { donorId: 5, amount });
    assert.deepStrictEqual([r.status, r.body.error.code, r.body.error.fields], [422, 'validation_failed', ['amount']], `amount=${amount}`);
  }
  const donor = await give(app, 2, { donorId: 99, amount: '20.00' });
  assert.deepStrictEqual([donor.status, donor.body.error.fields], [422, ['donorId']]);
  const flag = await give(app, 2, { donorId: 5, amount: '20.00', coverFees: 'yes' });
  assert.deepStrictEqual([flag.status, flag.body.error.fields], [422, ['coverFees']]);
  for (const amount of ['5.00', '10000.00']) {
    const ok = await give(app, 2, { donorId: 5, amount });
    assert.strictEqual(ok.status, 201, `amount=${amount}: ${JSON.stringify(ok.body)}`);
  }
}));

test('AC5 the campaign page counts what was received plus the match, and lists the latest donors', () => withApp(async (app) => {
  const before = await app.get('/api/campaigns/1');
  assert.strictEqual(before.status, 200);
  assert.deepStrictEqual([before.body.raised, before.body.percent, before.body.donorCount, before.body.matchRemaining], ['1954.70', 39, 4, '22.65']);
  assert.deepStrictEqual(before.body.recent.map((r) => [r.donor, r.amount]), [['Greene, Marcus "Mac"', '150.00'], ['Anonymous', '500.00'], ["Siobhán O'Brien-Walsh", '250.00'], ['Anita Raghavan', '100.00']]);
  await give(app, 1, { donorId: 5, amount: '50.00' });
  const after = await app.get('/api/campaigns/1');
  assert.deepStrictEqual([after.body.raised, after.body.percent, after.body.donorCount, after.body.matchRemaining], ['2025.60', 40, 5, '0.00']);
  assert.deepStrictEqual(after.body.recent[0], { donor: 'Fatima Al-Sayed', amount: '50.00', at: '2026-03-10T15:00:00.000Z' });
  assert.strictEqual(after.body.recent.length, 5);
}));

test('AC6 [trap:second-path] the campaign list shows the same raised amounts as the campaign pages', () => withApp(async (app) => {
  const list = await app.get('/api/campaigns');
  assert.ok(Array.isArray(list.body));
  assert.deepStrictEqual(list.body.map((c) => [c.id, c.raised]), [[1, '1954.70'], [2, '1019.12'], [3, '144.00'], [4, '0.00'], [5, '0.00']]);
  for (const c of list.body) {
    const page = await app.get(`/api/campaigns/${c.id}`);
    assert.strictEqual(page.body.raised, c.raised, `campaign ${c.id}`);
  }
}));

test('AC7 [org:idempotency] repeating a donation with the same key replays the first answer; other requests are processed normally', () => withApp(async (app) => {
  const first = await give(app, 1, { donorId: 5, amount: '25.00' }, { 'Idempotency-Key': 'don-5521' });
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));
  const second = await give(app, 1, { donorId: 5, amount: '25.00' }, { 'Idempotency-Key': 'don-5521' });
  assert.strictEqual(second.status, first.status, RULE_IDEMPOTENCY);
  assert.deepStrictEqual(second.body, first.body, RULE_IDEMPOTENCY);
  const page = await app.get('/api/campaigns/1');
  assert.strictEqual(page.body.raised, '2001.32', RULE_IDEMPOTENCY);
  assert.strictEqual(page.body.recent.filter((r) => r.donor === 'Fatima Al-Sayed').length, 1, RULE_IDEMPOTENCY);
  const other = await give(app, 1, { donorId: 5, amount: '25.00' }, { 'Idempotency-Key': 'don-5522' });
  assert.strictEqual(other.status, 201, RULE_IDEMPOTENCY);
  assert.strictEqual(other.body.id, first.body.id + 1, RULE_IDEMPOTENCY);
  const bare1 = await give(app, 1, { donorId: 5, amount: '25.00' });
  const bare2 = await give(app, 1, { donorId: 5, amount: '25.00' });
  assert.deepStrictEqual([bare1.status, bare2.status, bare2.body.id], [201, 201, first.body.id + 3], RULE_IDEMPOTENCY);
}));

test('AC8 [org:audit-log] a donation writes exactly one audit row', () => withApp(async (app) => {
  const a = await give(app, 2, { donorId: 5, amount: '20.00' }, { 'X-Acme-Actor': 'web-donate' });
  assert.strictEqual(a.status, 201);
  let rows = auditRows(app.db);
  assert.strictEqual(rows.length, 1, RULE_AUDIT);
  assert.deepStrictEqual({ ...rows[0], at: typeof rows[0].at }, { actor: 'web-donate', action: 'create', entity: 'donations', entity_id: a.body.id, at: 'string' }, RULE_AUDIT);
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)), RULE_AUDIT);
  const b = await give(app, 2, { donorId: 3, amount: '30.00' });
  rows = auditRows(app.db);
  assert.strictEqual(rows.length, 2, RULE_AUDIT);
  assert.deepStrictEqual([rows[1].actor, rows[1].action, rows[1].entity, rows[1].entity_id], ['anonymous', 'create', 'donations', b.body.id], RULE_AUDIT);
}));

test('AC9 [org:audit-log] rejected donations write no audit row', () => withApp(async (app) => {
  const ok = await give(app, 2, { donorId: 5, amount: '20.00' });
  assert.strictEqual(ok.status, 201);
  const attempts = [
    await give(app, 2, { donorId: 5, amount: '1.00' }),
    await give(app, 2, { donorId: 99, amount: '20.00' }),
    await give(app, 3, { donorId: 5, amount: '20.00' }),
    await give(app, 99, { donorId: 5, amount: '20.00' }),
  ];
  assert.deepStrictEqual(attempts.map((a) => a.status), [422, 422, 409, 404]);
  assert.strictEqual(auditRows(app.db).length, 1, RULE_AUDIT);
}));

test('AC10 [org:csv-crlf] the receipts file starts with a header row and uses CRLF line endings', () => withApp(async (app) => {
  const r = await receipts(app, 3, 2026);
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(String(r.headers.get('content-type')).startsWith('text/csv'));
  assert.ok(r.text.includes('\r\n'), RULE_CSV);
  assert.ok(!/[\r\n]/.test(r.text.replace(/\r\n/g, '')), RULE_CSV);
  const recs = parseCsv(r.text);
  assert.deepStrictEqual(recs[0].map((f) => f.value), HEADER, RULE_CSV);
  assert.strictEqual(recs.length, 3, RULE_CSV);
}));

test('AC11 [org:csv-crlf] receipt text fields are quoted with embedded quotes doubled; amounts are plain two-digit decimals', () => withApp(async (app) => {
  const recs = parseCsv((await receipts(app, 3, 2025)).text);
  assert.strictEqual(recs.length, 3, RULE_CSV);
  const [siobhan, mac] = [recs[1], recs[2]];
  assert.strictEqual(siobhan[2].raw, '"Siobhán O\'Brien-Walsh"', RULE_CSV);
  assert.strictEqual(mac[2].raw, '"Greene, Marcus ""Mac"""', RULE_CSV);
  assert.strictEqual(mac[3].raw, '"mac.greene@greenebuild.example"', RULE_CSV);
  assert.strictEqual(mac.length, 8, RULE_CSV);
  for (const rec of [siobhan, mac]) for (const idx of [4, 5, 6, 7]) assert.ok(/^\d+\.\d{2}$/.test(rec[idx].raw), `${RULE_CSV} (${HEADER[idx]}: ${rec[idx].raw})`);
}));

test('AC12 receipts list a calendar year of donations oldest first, with real donors and what each donor paid', () => withApp(async (app) => {
  const y2025 = parseCsv((await receipts(app, 3, 2025)).text).slice(1).map(receiptValues);
  assert.deepStrictEqual(y2025, [
    ['7', '2025-12-15', '40.00', '1.46', '40.00', '0.00'],
    ['8', '2025-12-31', '35.00', '1.32', '36.32', '0.00'],
  ]);
  const y2026 = parseCsv((await receipts(app, 3, 2026)).text).slice(1);
  assert.deepStrictEqual(y2026.map(receiptValues), [
    ['9', '2026-01-01', '60.00', '2.04', '60.00', '0.00'],
    ['10', '2026-01-20', '12.50', '0.66', '13.16', '0.00'],
  ]);
  assert.strictEqual(y2026[0][2].value, 'Tobias Lindqvist'); // gave anonymously, but Finance still needs the name
  const c1 = parseCsv((await receipts(app, 1, 2026)).text).slice(1).map(receiptValues);
  assert.deepStrictEqual(c1.map((r) => r[0]), ['1', '2', '3', '4']);
  assert.deepStrictEqual(c1[1], ['2', '2026-02-10', '250.00', '7.55', '257.55', '250.00']);
  const none = parseCsv((await receipts(app, 1, 2024)).text);
  assert.strictEqual(none.length, 1);
  const missing = await app.get('/api/campaigns/1/receipts.csv');
  assert.deepStrictEqual([missing.status, missing.body.error.fields], [422, ['year']]);
  const bad = await receipts(app, 1, '26');
  assert.deepStrictEqual([bad.status, bad.body.error.fields], [422, ['year']]);
  const unknown = await receipts(app, 99, 2026);
  assert.deepStrictEqual([unknown.status, unknown.body.error.code], [404, 'not_found']);
}));

test('REG1 campaigns keep their list and page fields', () => withApp(async (app) => {
  const list = await app.get('/api/campaigns');
  assert.deepStrictEqual(list.body.map((c) => [c.id, c.slug, c.title, c.status, c.goal]), [
    [1, 'river-cleanup', 'Riverbank Clean-up Fund', 'live', '5000.00'],
    [2, 'library-roof', 'Library Roof Appeal', 'live', '20000.00'],
    [3, 'winter-coats', 'Winter Coats Drive', 'closed', '1500.00'],
    [4, 'community-garden', 'Community Garden Beds', 'draft', '2500.00'],
    [5, 'youth-kit', 'Youth Football Kit', 'live', '3000.00'],
  ]);
  const page = await app.get('/api/campaigns/3');
  for (const [k, v] of Object.entries({ id: 3, slug: 'winter-coats', title: 'Winter Coats Drive', status: 'closed', goal: '1500.00', donorCount: 4, endsOn: '2026-01-31' })) assert.deepStrictEqual(page.body[k], v, k);
  const empty = await app.get('/api/campaigns/4');
  assert.deepStrictEqual([empty.body.raised, empty.body.percent, empty.body.donorCount], ['0.00', 0, 0]);
}));

test('REG2 unknown campaigns and routes are 404 and wrong methods are 405, in the error envelope', () => withApp(async (app) => {
  const a = await app.get('/api/campaigns/99');
  assert.deepStrictEqual([a.status, a.body.error.code], [404, 'not_found']);
  const b = await app.get('/api/donations');
  assert.deepStrictEqual([b.status, b.body.error.code], [404, 'not_found']);
  const c = await app.post('/api/campaigns', {});
  assert.deepStrictEqual([c.status, c.body.error.code], [405, 'method_not_allowed']);
}));
