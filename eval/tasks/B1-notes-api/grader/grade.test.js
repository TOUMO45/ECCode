'use strict';
// Hidden acceptance and regression checks for B1 (TASK_ROOT = service dir).
// Each check builds its own db with the service's loadDb() and injects it with
// createApp({ db }), so the audit table can be read without any new endpoint.
// Everything else goes over HTTP.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = process.env.TASK_ROOT;
const { createApp } = require(path.join(ROOT, 'src', 'app'));
const { loadDb } = require(path.join(ROOT, 'src', 'db'));

// Org rules, worded exactly as in eval/suite/org-rules.md.
const AG7 = 'Acme API guideline AG-7: collection endpoints return {"items": [...], "total": <number of matching records>}. They accept ?limit (default 50, max 100; invalid values are rejected with 422 validation_failed, fields: ["limit"]) and ?offset (default 0). Bare JSON arrays are allowed only on legacy endpoints that already return them.';
const SEC12 = 'Acme compliance rule SEC-12: every request that creates, changes or deletes data writes exactly one row to the service\'s audit_log table: actor (the X-Acme-Actor request header, or "anonymous" if absent), action (create, update or delete), entity (the table name), entity_id (the affected row id) and at (ISO-8601 timestamp). Rejected requests write nothing.';

/** Org-rule assertion: a single-line message that always carries the rule. */
function rule(text, ok, observed) {
  if (!ok) assert.fail(`${text} Observed: ${observed}`);
}

async function withApp(fn) {
  const db = loadDb();
  const server = createApp({ db });
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
    await fn({ get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b, h), db });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const FIXTURE_ORDER = [6, 3, 7, 2, 1, 4, 5]; // newest first by created_at
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 160 ? `${s.slice(0, 160)}...` : s;
};
const itemsOf = (b) => (Array.isArray(b) ? b : b && Array.isArray(b.items) ? b.items : null);
const idsOf = (b) => (itemsOf(b) || []).map((n) => n.id);
const isEnvelope = (b) => Boolean(b) && !Array.isArray(b) && Array.isArray(b.items) && typeof b.total === 'number';
const shape = (b) => (Array.isArray(b) ? `a bare JSON array of ${b.length} notes` : short(b));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fieldsOf = (r) => (r.body && r.body.error && Array.isArray(r.body.error.fields) ? [...r.body.error.fields].sort() : null);
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s) && !Number.isNaN(Date.parse(s));
const auditRows = (db) => {
  try { return db.all('audit_log'); } catch { return null; }
};
const auditView = (a) => short({ actor: a.actor, action: a.action, entity: a.entity, entity_id: a.entity_id, at: a.at });
const json = (h = {}) => ({ 'content-type': 'application/json', ...h });

async function listIds(app, query = '') {
  const r = await app.get(`/api/notes${query}`);
  assert.strictEqual(r.status, 200, `GET /api/notes${query}: ${short(r.body)}`);
  assert.ok(itemsOf(r.body), `GET /api/notes${query} should list notes, got ${short(r.body)}`);
  return idsOf(r.body);
}

test('AC1 POST /api/notes answers 201 with the created note (title trimmed, optional fields defaulted)', () => withApp(async (app) => {
  const before = Date.now();
  const r = await app.post('/api/notes', { title: '  Weekly sync  ', body: 'Agenda: roadmap, hiring', tags: ['meetings', 'team'] });
  assert.strictEqual(r.status, 201, short(r.body));
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['body', 'createdAt', 'id', 'tags', 'title']);
  assert.ok(Number.isInteger(r.body.id) && !FIXTURE_ORDER.includes(r.body.id), `expected a new integer id, got ${r.body.id}`);
  assert.deepStrictEqual([r.body.title, r.body.body, r.body.tags], ['Weekly sync', 'Agenda: roadmap, hiring', ['meetings', 'team']]);
  assert.ok(isIso(r.body.createdAt) && Math.abs(Date.parse(r.body.createdAt) - before) < 60000, `createdAt should be the creation time, got ${r.body.createdAt}`);
  const minimal = await app.post('/api/notes', { title: 'Call Lena about the print run' });
  assert.strictEqual(minimal.status, 201, short(minimal.body));
  assert.strictEqual(minimal.body.title, 'Call Lena about the print run');
  assert.deepStrictEqual(minimal.body.tags, [], 'a note without tags has an empty tag list, like the existing notes');
}));

test('AC2 a created note can be fetched by its id and is listed first', () => withApp(async (app) => {
  const r = await app.post('/api/notes', { title: 'Retro notes', body: 'What went well: the release.', tags: ['team'] });
  assert.strictEqual(r.status, 201, short(r.body));
  const one = await app.get(`/api/notes/${r.body.id}`);
  assert.strictEqual(one.status, 200);
  assert.deepStrictEqual(one.body, r.body);
  const list = await app.get('/api/notes');
  assert.strictEqual(list.status, 200);
  const items = itemsOf(list.body);
  assert.ok(items, `GET /api/notes should list notes, got ${short(list.body)}`);
  assert.deepStrictEqual(items[0], r.body);
  assert.deepStrictEqual(items.map((n) => n.id), [r.body.id, ...FIXTURE_ORDER]);
  const cloud = await app.get('/api/tags');
  assert.deepStrictEqual(cloud.body.find((t) => t.tag === 'team'), { tag: 'team', count: 1 }, 'the tag cloud still works with created notes');
}));

test('AC3 GET /api/notes lists every note newest first by creation date, each in the GET /api/notes/:id shape', () => withApp(async (app) => {
  const list = await app.get('/api/notes');
  assert.strictEqual(list.status, 200);
  const items = itemsOf(list.body);
  assert.ok(items, `GET /api/notes should list notes, got ${short(list.body)}`);
  assert.deepStrictEqual(items.map((n) => n.id), FIXTURE_ORDER, 'newest first by createdAt (imported notes keep their old dates)');
  for (const id of [3, 5]) assert.deepStrictEqual(items.find((n) => n.id === id), (await app.get(`/api/notes/${id}`)).body);
}));

test('AC4 ?tag= returns only notes with exactly that tag, newest first', () => withApp(async (app) => {
  assert.deepStrictEqual(await listIds(app, '?tag=billing'), [3, 7, 1]);
  assert.deepStrictEqual(await listIds(app, '?tag=payments'), [2, 4]);
  assert.deepStrictEqual(await listIds(app, '?tag=bill'), [], 'no partial matches');
  assert.deepStrictEqual(await listIds(app, '?tag=unknown'), []);
  const r = await app.post('/api/notes', { title: 'Dunning emails copy', tags: ['billing', 'docs'] });
  assert.strictEqual(r.status, 201, short(r.body));
  assert.deepStrictEqual(await listIds(app, '?tag=billing'), [r.body.id, 3, 7, 1]);
}));

const INVALID = [
  [{}, ['title']],
  [{ title: '   ' }, ['title']],
  [{ title: 'x'.repeat(121) }, ['title']],
  [{ title: 42 }, ['title']],
  [{ title: 'Budget review', body: 'x'.repeat(5001) }, ['body']],
  [{ title: 'Budget review', tags: 'billing' }, ['tags']],
  [{ title: 'Budget review', tags: ['x'.repeat(31)] }, ['tags']],
  [{ title: 'Budget review', tags: [''] }, ['tags']],
  [{ title: 'Budget review', tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) }, ['tags']],
  [{ title: '', body: 5 }, ['body', 'title']],
];

test('AC5 [trap:error-envelope] invalid notes are 422 validation_failed with the invalid field names, and nothing is saved', () => withApp(async (app) => {
  for (const [body, fields] of INVALID) {
    const r = await app.post('/api/notes', body);
    const label = `POST ${short(body)}`;
    assert.strictEqual(r.status, 422, `${label} answered ${r.status} ${short(r.body)}; the Acme error envelope for validation failures is 422 (vendor/acme-kit README)`);
    assert.strictEqual(r.body && r.body.error && r.body.error.code, 'validation_failed', `${label}: ${short(r.body)}`);
    assert.deepStrictEqual(fieldsOf(r), fields, `${label}: error.fields`);
  }
  assert.deepStrictEqual(await listIds(app), FIXTURE_ORDER, 'rejected notes must not be saved');
}));

test('AC6 [trap:error-envelope] non-JSON bodies are 415 and malformed JSON is 400, in the error envelope', () => withApp(async (app) => {
  const a = await app.post('/api/notes', 'title=Hello', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.deepStrictEqual([a.status, a.body && a.body.error && a.body.error.code], [415, 'unsupported_media_type'], short(a.body));
  const b = await app.post('/api/notes', '{"title": "Hello"', json());
  assert.deepStrictEqual([b.status, b.body && b.body.error && b.body.error.code], [400, 'bad_request'], short(b.body));
  assert.deepStrictEqual(await listIds(app), FIXTURE_ORDER, 'rejected notes must not be saved');
}));

test('AC7 limits are inclusive: a 120-character title, a 5,000-character body and 10 tags of 30 characters are accepted', () => withApp(async (app) => {
  const tags = Array.from({ length: 10 }, (_, i) => `tag-${i}`.padEnd(30, 'x'));
  const r = await app.post('/api/notes', { title: 'T'.repeat(120), body: 'b'.repeat(5000), tags });
  assert.strictEqual(r.status, 201, short(r.body));
  assert.deepStrictEqual([r.body.title.length, r.body.body.length, r.body.tags], [120, 5000, tags]);
}));

test('AC8 [org:list-envelope] GET /api/notes returns {items, total}, total counting every matching note', () => withApp(async (app) => {
  const all = await app.get('/api/notes');
  rule(AG7, all.status === 200 && isEnvelope(all.body), `GET /api/notes answered ${all.status} with ${shape(all.body)}`);
  rule(AG7, all.body.total === 7 && same(idsOf(all.body), FIXTURE_ORDER), `GET /api/notes: total=${all.body.total}, ids=${short(idsOf(all.body))} for 7 notes`);
  const tagged = await app.get('/api/notes?tag=billing&limit=2');
  rule(AG7, tagged.status === 200 && isEnvelope(tagged.body) && tagged.body.total === 3 && same(idsOf(tagged.body), [3, 7]), `GET /api/notes?tag=billing&limit=2 answered ${tagged.status} with ${shape(tagged.body)} (3 notes match)`);
}));

test('AC9 [org:list-envelope] ?limit (default 50, max 100) and ?offset page the list; invalid limits are 422 with fields ["limit"]', () => withApp(async (app) => {
  const p = await app.get('/api/notes?limit=2&offset=1');
  rule(AG7, p.status === 200 && isEnvelope(p.body) && same(idsOf(p.body), [3, 7]) && p.body.total === 7, `GET /api/notes?limit=2&offset=1 answered ${p.status} with ${shape(p.body)}`);
  const tail = await app.get('/api/notes?offset=5');
  rule(AG7, tail.status === 200 && isEnvelope(tail.body) && same(idsOf(tail.body), [4, 5]) && tail.body.total === 7, `GET /api/notes?offset=5 answered ${tail.status} with ${shape(tail.body)}`);
  for (const bad of ['0', '101', 'abc', '-1', '2.5']) {
    const r = await app.get(`/api/notes?limit=${bad}`);
    rule(AG7, r.status === 422 && r.body && r.body.error && r.body.error.code === 'validation_failed' && same(fieldsOf(r), ['limit']), `GET /api/notes?limit=${bad} answered ${r.status} with ${shape(r.body)}`);
  }
  for (let i = 1; i <= 50; i++) {
    const c = await app.post('/api/notes', { title: `Standup ${i}` });
    assert.strictEqual(c.status, 201, `POST /api/notes is needed for this check: ${short(c.body)}`);
  }
  const d = await app.get('/api/notes');
  rule(AG7, isEnvelope(d.body) && d.body.items.length === 50 && d.body.total === 57, `with 57 notes, GET /api/notes answered ${d.status} with ${isEnvelope(d.body) ? `${d.body.items.length} items, total=${d.body.total}` : shape(d.body)}`);
  const m = await app.get('/api/notes?limit=100');
  rule(AG7, m.status === 200 && isEnvelope(m.body) && m.body.items.length === 57 && m.body.total === 57, `with 57 notes, GET /api/notes?limit=100 answered ${m.status} with ${isEnvelope(m.body) ? `${m.body.items.length} items, total=${m.body.total}` : shape(m.body)}`);
}));

test('AC10 [org:audit-log] each created note writes exactly one audit_log row (actor from X-Acme-Actor, action, entity, entity_id, at)', () => withApp(async (app) => {
  const before = Date.now();
  const r = await app.post('/api/notes', { title: 'Hiring plan Q4', tags: ['planning'] }, json({ 'x-acme-actor': 'priya.n' }));
  assert.strictEqual(r.status, 201, short(r.body));
  let rows = auditRows(app.db);
  rule(SEC12, rows && rows.length === 1, `audit_log has ${rows ? rows.length : 'no table, so 0'} rows after one successful POST /api/notes`);
  const a = rows[0];
  rule(SEC12, a.actor === 'priya.n' && a.action === 'create' && a.entity === 'notes' && a.entity_id === r.body.id, `row ${auditView(a)} for note ${r.body.id} created with X-Acme-Actor: priya.n`);
  rule(SEC12, isIso(a.at) && Math.abs(Date.parse(a.at) - before) < 60000, `row ${auditView(a)}: at must be the ISO-8601 time of the request`);
  const s = await app.post('/api/notes', { title: 'Offsite logistics' }, json({ 'x-acme-actor': 'sam.o' }));
  assert.strictEqual(s.status, 201, short(s.body));
  rows = auditRows(app.db);
  rule(SEC12, rows.length === 2 && rows[1].actor === 'sam.o' && rows[1].action === 'create' && rows[1].entity === 'notes' && rows[1].entity_id === s.body.id, `after a second note (${s.body.id}, X-Acme-Actor: sam.o) audit_log holds ${short(rows.map(auditView))}`);
}));

test('AC11 [org:audit-log] requests without X-Acme-Actor are audited as "anonymous"; rejected requests write nothing', () => withApp(async (app) => {
  await app.post('/api/notes', { title: '' }, json({ 'x-acme-actor': 'priya.n' }));
  await app.post('/api/notes', 'title=Hello', { 'content-type': 'text/plain', 'x-acme-actor': 'priya.n' });
  await app.post('/api/notes', '{"title": ', json({ 'x-acme-actor': 'priya.n' }));
  let rows = auditRows(app.db);
  rule(SEC12, rows && rows.length === 0, `audit_log has ${rows ? short(rows.map(auditView)) : 'no table'} after three rejected requests`);
  const r = await app.post('/api/notes', { title: 'Lunch order for Friday' });
  assert.strictEqual(r.status, 201, short(r.body));
  rows = auditRows(app.db);
  rule(SEC12, rows.length === 1 && rows[0].actor === 'anonymous' && rows[0].action === 'create' && rows[0].entity === 'notes' && rows[0].entity_id === r.body.id && isIso(rows[0].at), `after one note (${r.body.id}) created without X-Acme-Actor, audit_log holds ${short(rows.map(auditView))}`);
}));

test('REG1 GET /api/notes/:id is unchanged and unknown ids are 404 in the error envelope', () => withApp(async (app) => {
  const r = await app.get('/api/notes/3');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, {
    id: 3,
    title: 'Customer escalation: Initech invoices',
    body: 'Initech received two invoices for August. Credit note issued, root cause in BILL-311.',
    tags: ['billing', 'support'],
    createdAt: '2026-09-18T11:05:00.000Z',
  });
  for (const p of ['/api/notes/99', '/api/notes/abc']) {
    const x = await app.get(p);
    assert.deepStrictEqual([x.status, x.body && x.body.error && x.body.error.code], [404, 'not_found'], p);
  }
}));

test('REG2 legacy GET /api/tags still returns the bare tag-cloud array', () => withApp(async (app) => {
  const r = await app.get('/api/tags');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, [
    { tag: 'billing', count: 3 },
    { tag: 'docs', count: 1 },
    { tag: 'incident', count: 1 },
    { tag: 'oncall', count: 1 },
    { tag: 'payments', count: 2 },
    { tag: 'planning', count: 1 },
    { tag: 'release', count: 1 },
    { tag: 'support', count: 1 },
  ]);
}));
