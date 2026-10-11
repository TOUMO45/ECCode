// API tests for image uploads, request deletion and the retention sweep (task d3-extraction-service): RS-39 (magic bytes, 5 MB
// cap, random 128-bit names, owner only, DELETE with 409 PAYMENT_IN_PROGRESS / tombstone, the 7-day sweep with a pinned clock and
// an audit event), PB-3 / FU-2 (the upload deadline while streaming), SEC-C-3 / FU-20 (expired rate rows are purged by the sweep),
// T12 and T23. Nothing here calls a model: the extraction in the deletion cases is the simulated fake.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_DATE, DEMO_PASSWORD, FIXED_NOW_MS, startHarness, testEnv } from '../helpers/app-harness.js';
import { compareShape } from '../helpers/contract-shape.js';
import { createClient } from '../helpers/fixtures.js';
import { approvedPlan, canonicalFields, idempotencyKey, reserve } from '../helpers/plan-flow.js';
import { fixedClock } from '../../src/clock.js';
import { openDb } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createLogger } from '../../src/log.js';
import { startApp } from '../../src/main.js';
import { UPLOAD_REQUEST_TIMEOUT_MS } from '../../src/http/server.js';
import { createAiRuntime, saveImage } from '../../src/services/extraction.js';
import { DAY_MS, runRetentionSweep } from '../../src/services/retention.js';

const EN = 'I need 200 cups and 200 lids, 250 ml, 90 mm, by 11:00, budget $120, at most 2 pickups.';
const MAX = 5242880;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const png = (label = 'x', size = 0) => Buffer.concat([PNG_SIG, Buffer.from(label), Buffer.alloc(size)]);
const jpeg = (label = 'x') => Buffer.concat([JPEG_SIG, Buffer.from(label)]);
const webp = (label = 'x') => Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(label)]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const HEX32 = /^[0-9a-f]{32}$/;

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

async function newRequest(client, text = EN) {
  const res = await client.post('/api/requests', { text });
  assert.equal(res.status, 201, res.text);
  return res.json.request.id;
}

const upload = (client, id, bytes, type = 'image/png') =>
  client.send({ method: 'POST', path: `/api/requests/${id}/image`, headers: { 'Content-Type': type }, body: bytes });
const count = (h, sql, ...args) => h.db.prepare(sql).get(...args).n;
const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')) : []);
const tmpFiles = (h) => (existsSync(join(h.config.uploadDir, '.tmp')) ? readdirSync(join(h.config.uploadDir, '.tmp')) : []);
const iso = (ms) => new Date(ms).toISOString();
// A test file makes more requests than the production allowance of 10 per customer per day.
const MANY_REQUESTS = { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' };

// ------------------------------------------------------------------------------------------------ uploads

describe('RS-39: uploads are checked by magic bytes, size and owner', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: MANY_REQUESTS });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());
  // The 10-per-10-minutes allowance is shared by uploads and extracts; every case starts in a fresh window.
  beforeEach(() => h.clock.advance(11 * 60 * 1000));

  test('RS-39: PNG, JPEG and WebP are accepted; the response has {id, mime, bytes, sha256} and the file is stored with a random 128-bit name, mode 0600', async () => {
    const names = [];
    for (const [bytes, mime, ext] of [[png('a'), 'image/png', 'png'], [jpeg('b'), 'image/jpeg', 'jpg'], [webp('c'), 'image/webp', 'webp']]) {
      const id = await newRequest(cafe1);
      const res = await upload(cafe1, id, bytes, mime);
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(Object.keys(res.json.image), ['id', 'mime', 'bytes', 'sha256']);
      assert.deepEqual(compareShape(JSON.parse(readFileSync(new URL('../fixtures/contracts/request-image-upload.json', import.meta.url), 'utf8')).response, res.json), []);
      assert.deepEqual([res.json.image.mime, res.json.image.bytes, res.json.image.sha256], [mime, bytes.length, sha(bytes)]);
      assert.equal(typeof res.json.requestId, 'string');
      const row = h.db.prepare('SELECT * FROM images WHERE id = ?').get(res.json.image.id);
      assert.match(row.file_name, HEX32);
      assert.equal(row.mime_detected, mime);
      const path = join(h.config.uploadDir, `${row.file_name}.${ext}`);
      assert.ok(readFileSync(path).equals(bytes));
      assert.equal(statSync(path).mode & 0o777, 0o600, 'owner read/write only (SEC-14)');
      names.push(row.file_name);
    }
    assert.equal(new Set(names).size, 3, 'names are random, not derived from the content or the request');
    assert.equal(statSync(h.config.uploadDir).mode & 0o077, 0, 'the upload directory is not open to group or others');
    assert.deepEqual(tmpFiles(h), [], 'the write went through .tmp and was renamed: nothing is left there');
  });

  test('RS-39: a body declared image/png but carrying other bytes is 415, and no file or row is written', async () => {
    const id = await newRequest(cafe1);
    const before = { files: filesIn(h.config.uploadDir).length, rows: count(h, 'SELECT COUNT(*) AS n FROM images') };
    const bad = [
      [jpeg(), 'image/png'], [png(), 'image/jpeg'], [png(), 'image/webp'], [Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'],
      [Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVEfmt ')]), 'image/webp'],
      [Buffer.from('GIF89a......'), 'image/gif'], [png(), 'text/plain'], [png(), 'application/octet-stream'],
      [PNG_SIG.subarray(0, 7), 'image/png'], [Buffer.alloc(0), 'image/png'],
    ];
    for (const [bytes, type] of bad) {
      const res = await upload(cafe1, id, bytes, type);
      assert.equal(res.status, 415, `${type} ${bytes.length} bytes: ${res.text}`);
      assert.equal(res.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    }
    const missing = await cafe1.send({ method: 'POST', path: `/api/requests/${id}/image`, body: png() });
    assert.equal(missing.status, 415, 'no Content-Type');
    assert.deepEqual({ files: filesIn(h.config.uploadDir).length, rows: count(h, 'SELECT COUNT(*) AS n FROM images') }, before);
    assert.deepEqual(tmpFiles(h), []);
  });

  test('RS-39: a Content-Type with parameters and any case is read by its media type', async () => {
    const id = await newRequest(cafe1);
    const res = await upload(cafe1, id, png('params'), 'Image/PNG; charset=binary');
    assert.equal(res.status, 201, res.text);
  });

  test('RS-39: at most 5 MB: exactly 5,242,880 bytes is accepted, one byte more is 413 PAYLOAD_TOO_LARGE with nothing written', async () => {
    const id = await newRequest(cafe1);
    const exact = png('big', MAX - PNG_SIG.length - 3);
    assert.equal(exact.length, MAX);
    const ok = await upload(cafe1, id, exact);
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.image.bytes, MAX);
    const files = filesIn(h.config.uploadDir).length;
    const over = await upload(cafe1, id, png('big', MAX - PNG_SIG.length - 3 + 1));
    assert.equal(over.status, 413, over.text);
    assert.equal(over.json.error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(filesIn(h.config.uploadDir).length, files, 'the refused upload wrote nothing and the accepted image is still the only one');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE request_id = ?', id), 1);
    assert.deepEqual(tmpFiles(h), []);
  });

  test('RS-39: a declared Content-Length above the cap is refused before a byte is read (413)', async () => {
    const id = await newRequest(cafe1);
    const text = await rawExchange(h, cafe1, `POST /api/requests/${id}/image`, { 'Content-Type': 'image/png', 'Content-Length': '999999999' }, []);
    assert.match(text, /^HTTP\/1\.1 413 /);
    assert.match(text, /PAYLOAD_TOO_LARGE/);
    assert.deepEqual(tmpFiles(h), []);
  });

  test('RS-39: Content-Length is required: a chunked body is 400 BAD_REQUEST and nothing is written', async () => {
    const id = await newRequest(cafe1);
    const res = await new Promise((resolve, reject) => {
      const cookie = Object.entries(cafe1.cookies()).map(([k, v]) => `${k}=${v}`).join('; ');
      const req = httpRequest({
        host: '127.0.0.1', port: h.port, method: 'POST', path: `/api/requests/${id}/image`, agent: false,
        headers: { Cookie: cookie, 'X-CSRF-Token': cafe1.csrfToken, 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.write(png());
      req.end();
    });
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /BAD_REQUEST/);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE request_id = ?', id), 0);
  });

  test('RS-39: a client-supplied file name or path never reaches the file system; only the random name is used', async () => {
    const id = await newRequest(cafe1);
    const res = await cafe1.send({
      method: 'POST', path: `/api/requests/${id}/image`, body: png('evil'),
      headers: { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="../../../etc/passwd"', 'X-File-Name': '../../evil.png' },
    });
    assert.equal(res.status, 201, res.text);
    const row = h.db.prepare('SELECT file_name FROM images WHERE id = ?').get(res.json.image.id);
    assert.match(row.file_name, HEX32);
    assert.ok(readdirSync(h.config.uploadDir).every((n) => n.startsWith('.') || /^[0-9a-f]{32}\.(png|jpg|webp)$/.test(n)));
    assert.equal(existsSync(join(h.dir, 'evil.png')), false);
  });

  test('RS-39: the image is served back with the detected type, nosniff, CSP sandbox and no caching; a polyglot stays an image', async () => {
    const id = await newRequest(cafe1);
    const polyglot = Buffer.concat([png('poly'), Buffer.from('<script>alert(1)</script>')]);
    assert.equal((await upload(cafe1, id, polyglot)).status, 201);
    const res = await cafe1.get(`/api/requests/${id}/image`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-security-policy'], 'sandbox');
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.headers['content-disposition'], 'inline; filename="image"');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.text, polyglot.toString('utf8'));
    const none = await newRequest(cafe1);
    assert.equal((await cafe1.get(`/api/requests/${none}/image`)).status, 404);
  });

  test('RS-39: a second upload replaces the first and the old file is deleted', async () => {
    const id = await newRequest(cafe1);
    const first = await upload(cafe1, id, png('one'));
    const oldName = h.db.prepare('SELECT file_name FROM images WHERE id = ?').get(first.json.image.id).file_name;
    const second = await upload(cafe1, id, jpeg('two'), 'image/jpeg');
    assert.equal(second.status, 201);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE request_id = ?', id), 1);
    assert.equal(existsSync(join(h.config.uploadDir, `${oldName}.png`)), false);
    const view = (await cafe1.get(`/api/requests/${id}`)).json;
    assert.deepEqual(view.request.image, { id: second.json.image.id, mime: 'image/jpeg', bytes: jpeg('two').length });
  });

  test('RS-39: customer Y uploading to customer X\'s request gets 404 before the body is read; no file is written and nothing is counted', async () => {
    const h2 = await startHarness({ seed: true, env: MANY_REQUESTS });
    try {
      const x = await signIn(h2, 'cafe1');
      const y = await signIn(h2, 'cafe2');
      const id = await newRequest(x);
      const before = {
        rate: count(h2, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'extract_or_upload'"),
        images: count(h2, 'SELECT COUNT(*) AS n FROM images'),
        audit: count(h2, 'SELECT COUNT(*) AS n FROM audit_events'),
      };
      // A valid image, a wrong type and an oversize body all get the same 404: ownership is decided first.
      for (const [bytes, type] of [[png('y'), 'image/png'], [Buffer.from('not an image'), 'text/plain'], [png('big', MAX), 'image/png']]) {
        const res = await upload(y, id, bytes, type);
        assert.equal(res.status, 404, `${type}: ${res.text}`);
        assert.equal(res.json.error.code, 'NOT_FOUND');
      }
      assert.equal(existsSync(h2.config.uploadDir), false, 'not even the upload directory was created');
      assert.deepEqual(
        {
          rate: count(h2, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'extract_or_upload'"),
          images: count(h2, 'SELECT COUNT(*) AS n FROM images'),
          audit: count(h2, 'SELECT COUNT(*) AS n FROM audit_events'),
        },
        before,
      );
      assert.equal((await y.get(`/api/requests/${id}/image`)).status, 404);
      // The owner can still upload, and Y cannot read the image.
      assert.equal((await upload(x, id, png('mine'))).status, 201);
      assert.equal((await y.get(`/api/requests/${id}/image`)).status, 404);
      assert.equal((await y.send({ method: 'DELETE', path: `/api/requests/${id}` })).status, 404);
    } finally {
      await h2.close();
    }
  });

  test('RS-39: anonymous callers are 401 and a supplier is 403 on every image route', async () => {
    const id = await newRequest(cafe1);
    const anon = await h.request({ method: 'POST', path: `/api/requests/${id}/image`, headers: { 'Content-Type': 'image/png' }, body: png() });
    assert.equal(anon.status, 401);
    const supplier = await signIn(h, 'supplier-a');
    assert.equal((await upload(supplier, id, png())).status, 403);
    assert.equal((await supplier.get(`/api/requests/${id}/image`)).status, 403);
    assert.equal((await supplier.send({ method: 'DELETE', path: `/api/requests/${id}` })).status, 403);
  });

  test('RS-39: a failed database write removes the file again (no orphan)', async () => {
    const id = await newRequest(cafe1);
    const user = { id: cafe1.user.id, role: 'customer' };
    const before = filesIn(h.config.uploadDir).length;
    const ctx = { ...h.app.deps, requestId: 'req-test-0001' };
    h.db.prepare('DELETE FROM rescue_requests WHERE id = ?').run(id); // the request vanishes between the check and the write
    await assert.rejects(() => saveImage(ctx, user, id, { mime: 'image/png', bytes: png('late') }), (err) => err.status === 404);
    assert.equal(filesIn(h.config.uploadDir).length, before);
    assert.deepEqual(tmpFiles(h), []);
  });
});

// Sends a request over a raw socket: head lines and header map, then each chunk after `gapMs`. Resolves with all the text
// received when the server closes the connection, or when `maxMs` have passed.
function rawExchange(h, client, requestLine, headers, chunks, { gapMs = 0, maxMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(h.port, '127.0.0.1');
    let received = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(received);
    };
    socket.setEncoding('utf8');
    socket.on('data', (c) => {
      received += c;
    });
    socket.on('close', finish);
    socket.on('error', () => {});
    const cookie = Object.entries(client.cookies()).map(([k, v]) => `${k}=${v}`).join('; ');
    const head = [`${requestLine} HTTP/1.1`, `Host: 127.0.0.1:${h.port}`, `Cookie: ${cookie}`, `X-CSRF-Token: ${client.csrfToken}`]
      .concat(Object.entries(headers).map(([k, v]) => `${k}: ${v}`));
    socket.write(`${head.join('\r\n')}\r\n\r\n`);
    (async () => {
      for (const chunk of chunks) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        if (!done) socket.write(chunk);
      }
    })();
    setTimeout(finish, maxMs).unref();
  });
}

// ------------------------------------------------------------------------------------------------ the deadline (FU-2)

describe('PB-3: the upload route enforces its own deadline while the body streams (FU-2)', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true, env: MANY_REQUESTS });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('PB-3: the default deadline is the spec\'s 60 s (UPLOAD_REQUEST_TIMEOUT_MS), longer than the 30 s of every other request', () => {
    assert.equal(UPLOAD_REQUEST_TIMEOUT_MS, 60000);
    assert.equal(h.app.deps.uploadDeadlineMs, 60000);
  });

  test('PB-3: a body that is not complete by the deadline ends as 400 BAD_REQUEST (UPLOAD_TIMEOUT), the connection is closed and no file is left in uploads or .tmp', async () => {
    h.app.deps.uploadDeadlineMs = 250; // shortened for the test only
    const id = await newRequest(cafe1);
    const started = Date.now();
    const text = await rawExchange(h, cafe1, `POST /api/requests/${id}/image`, { 'Content-Type': 'image/png', 'Content-Length': '100000' }, [png('slow', 2000)], { maxMs: 5000 });
    const took = Date.now() - started;
    assert.match(text, /^HTTP\/1\.1 400 /, text);
    assert.match(text, /UPLOAD_TIMEOUT/);
    assert.match(text, /connection: close/i);
    assert.ok(took >= 200 && took < 3000, `answered after ${took} ms`);
    assert.deepEqual(filesIn(h.config.uploadDir), []);
    assert.deepEqual(tmpFiles(h), []);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE request_id = ?', id), 0);
  });

  test('PB-3: a body that trickles in but finishes inside the deadline is accepted', async () => {
    h.app.deps.uploadDeadlineMs = 2000;
    const id = await newRequest(cafe1);
    const body = png('trickle');
    const half = Math.floor(body.length / 2);
    const text = await rawExchange(h, cafe1, `POST /api/requests/${id}/image`, { 'Content-Type': 'image/png', 'Content-Length': String(body.length), 'Connection': 'close' }, [body.subarray(0, half), body.subarray(half)], { gapMs: 100 });
    assert.match(text, /^HTTP\/1\.1 201 /, text);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE request_id = ?', id), 1);
  });
});

// ------------------------------------------------------------------------------------------------ deletion

describe('RS-39, T23: DELETE /api/requests/:id', () => {
  let h;
  let cafe1;
  let cafe2;
  const sealed = ['approved', 'authorization_pending', 'authorized', 'capture_pending', 'refund_requested', 'refund_pending', 'unknown'];
  before(async () => {
    h = await startHarness({ seed: true, env: MANY_REQUESTS });
    cafe1 = await signIn(h, 'cafe1');
    cafe2 = await signIn(h, 'cafe2');
  });
  after(() => h.close());
  beforeEach(() => h.clock.advance(11 * 60 * 1000));

  // A request with an image, an extraction (wording kept as user_text) and confirmed requirements; planned, approved and reserved
  // when `reserveStock` is true. Returns the ids.
  async function fullRequest(client, { reserveStock = false } = {}) {
    const id = await newRequest(client);
    const up = await upload(client, id, png(`photo-${id}`));
    assert.equal(up.status, 201, up.text);
    const ex = await client.post(`/api/requests/${id}/extract`, {});
    assert.equal(ex.status, 200, ex.text);
    const conf = await client.post(`/api/requests/${id}/confirm`, { fields: canonicalFields(DEMO_DATE) });
    assert.equal(conf.status, 201, conf.text);
    assert.equal(conf.json.requirements.fields.cupQuantity.provenance, 'user_text');
    const planned = await client.post(`/api/requests/${id}/plan`, {});
    const plan = planned.json.plan;
    assert.equal((await client.post(`/api/plans/${plan.id}/approve`, { expectedTotalCents: plan.body.totalCents, planHash: plan.planHash })).status, 200);
    let reservation = null;
    if (reserveStock) {
      reservation = await reserve(client, plan.id, idempotencyKey(id));
      assert.equal(reservation.status, 201, reservation.text);
    }
    const image = h.db.prepare('SELECT file_name FROM images WHERE request_id = ?').get(id);
    return { id, planId: plan.id, fileName: image.file_name, reservation };
  }

  test('RS-39: no supplier order existed: a hard delete removes the request, raw text, image file and row, extraction text, requirements and plans', async () => {
    const r = await fullRequest(cafe1);
    const file = join(h.config.uploadDir, `${r.fileName}.png`);
    assert.ok(existsSync(file));
    const res = await cafe1.send({ method: 'DELETE', path: `/api/requests/${r.id}` });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.deleted, 'hard');
    assert.equal(typeof res.json.requestId, 'string');
    assert.equal(existsSync(file), false, 'the image file is unlinked');
    for (const table of ['rescue_requests WHERE id', 'images WHERE request_id', 'extractions WHERE request_id', 'requirements WHERE request_id', 'planning_runs WHERE request_id', 'plan_versions WHERE request_id']) {
      assert.equal(count(h, `SELECT COUNT(*) AS n FROM ${table} = ?`, r.id), 0, table);
    }
    assert.equal((await cafe1.get(`/api/requests/${r.id}`)).status, 404);
    assert.equal((await cafe1.send({ method: 'DELETE', path: `/api/requests/${r.id}` })).status, 404, 'a second delete is 404');
    const audit = h.db.prepare("SELECT outcome, actor_role, detail_json FROM audit_events WHERE action = 'request.delete' AND entity_id = ?").get(r.id);
    assert.deepEqual({ ...audit, detail_json: JSON.parse(audit.detail_json) }, { outcome: 'ok', actor_role: 'customer', detail_json: { mode: 'hard', images: 1 } });
    assert.doesNotMatch(JSON.stringify(audit), /cups/, 'the audit event holds no request text');
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'request_create' AND user_key = ?", `u:${cafe1.user.id}`) > 0, true, 'the daily request count survives a delete (SEC-2)');
  });

  test('RS-39: a request with a reservation is tombstoned: the void rule ends it (REQUEST_DELETED), stock returns, text, image and extraction are gone, wording is scrubbed, financial rows stay', async () => {
    const r = await fullRequest(cafe1, { reserveStock: true });
    const stockBefore = h.db.prepare('SELECT SUM(reserved) AS n FROM inventory').get().n;
    assert.ok(stockBefore > 0, 'stock was reserved');
    const ordersBefore = h.db.prepare('SELECT id, plan_version_id, total_cents FROM supplier_orders WHERE plan_version_id = ?').all(r.planId).map((o) => ({ ...o }));
    assert.ok(ordersBefore.length >= 1);

    const res = await cafe1.send({ method: 'DELETE', path: `/api/requests/${r.id}` });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.deleted, 'tombstoned');

    const row = h.db.prepare('SELECT raw_text, deleted_at FROM rescue_requests WHERE id = ?').get(r.id);
    assert.equal(row.raw_text, null);
    assert.equal(typeof row.deleted_at, 'string');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE request_id = ?', r.id), 0);
    assert.equal(existsSync(join(h.config.uploadDir, `${r.fileName}.png`)), false);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM extractions WHERE request_id = ?', r.id), 0);
    for (const req of h.db.prepare('SELECT fields_json FROM requirements WHERE request_id = ?').all(r.id)) {
      const fields = JSON.parse(req.fields_json);
      assert.ok(Object.values(fields).every((f) => f.originalWording === null));
      assert.equal(fields.cupQuantity.value, 200, 'values stay; only the customer\'s wording goes');
    }
    const plan = h.db.prepare('SELECT status, non_executable_reason FROM plan_versions WHERE id = ?').get(r.planId);
    assert.deepEqual({ ...plan }, { status: 'non_executable', non_executable_reason: 'REQUEST_DELETED' });
    assert.equal(h.db.prepare('SELECT status FROM reservations WHERE plan_version_id = ?').get(r.planId).status, 'released');
    assert.equal(h.db.prepare('SELECT SUM(reserved) AS n FROM inventory').get().n, 0, 'the void rule gave the stock back');
    assert.deepEqual(h.db.prepare('SELECT id, plan_version_id, total_cents FROM supplier_orders WHERE plan_version_id = ?').all(r.planId).map((o) => ({ ...o })), ordersBefore);
    assert.ok(count(h, 'SELECT COUNT(*) AS n FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id WHERE so.plan_version_id = ?', r.planId) >= 1);
    assert.equal((await cafe1.get(`/api/requests/${r.id}`)).status, 404);
    assert.ok(!(await cafe1.get('/api/requests')).json.requests.some((x) => x.id === r.id));
    // Newest first: request ids are reused after a hard delete of the highest id (INTEGER PRIMARY KEY without AUTOINCREMENT).
    const audit = h.db.prepare("SELECT detail_json FROM audit_events WHERE action = 'request.delete' AND entity_id = ? ORDER BY id DESC").get(r.id);
    assert.equal(JSON.parse(audit.detail_json).mode, 'tombstoned');
    // The freed stock can be reserved by another customer.
    const other = await approvedPlan(cafe2, DEMO_DATE);
    assert.equal((await reserve(cafe2, other.plan.id, idempotencyKey(other.plan.id + 5000))).status, 201);
    await cafe2.send({ method: 'DELETE', path: `/api/requests/${other.requestId}` });
  });

  for (const status of sealed) {
    test(`RS-39: 409 PAYMENT_IN_PROGRESS while a payment operation is ${status}; nothing changes`, async () => {
      const r = await fullRequest(cafe1, { reserveStock: true });
      const saved = h.db.prepare('SELECT po.id, po.status, po.prev_status, po.unknown_since FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id WHERE so.plan_version_id = ?').all(r.planId).map((o) => ({ ...o }));
      for (const op of saved) {
        h.db.prepare('UPDATE payment_operations SET status = ?, prev_status = ?, unknown_since = ? WHERE id = ?')
          .run(status, status === 'unknown' ? 'created' : null, status === 'unknown' ? iso(h.clock.now()) : null, op.id);
      }
      const res = await cafe1.send({ method: 'DELETE', path: `/api/requests/${r.id}` });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.error.code, 'PAYMENT_IN_PROGRESS');
      assert.equal(res.json.error.details.planVersionId, r.planId);
      assert.notEqual(h.db.prepare('SELECT raw_text FROM rescue_requests WHERE id = ?').get(r.id).raw_text, null);
      assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE request_id = ?', r.id), 1);
      assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(r.planId).status, 'approved');
      assert.equal(h.db.prepare('SELECT status FROM reservations WHERE plan_version_id = ?').get(r.planId).status, 'active');
      assert.equal(count(h, "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'request.delete' AND entity_id = ?", r.id), 0);
      // Put the operations back and release the request so the stock is free for the next case.
      for (const op of saved) h.db.prepare('UPDATE payment_operations SET status = ?, prev_status = ?, unknown_since = ? WHERE id = ?').run(op.status, op.prev_status, op.unknown_since, op.id);
      assert.equal((await cafe1.send({ method: 'DELETE', path: `/api/requests/${r.id}` })).status, 200);
    });
  }

  test('RS-39: 409 PAYMENT_IN_PROGRESS for an executing plan version and for a reconciling reservation', async () => {
    const r = await fullRequest(cafe1, { reserveStock: true });
    h.db.prepare("UPDATE plan_versions SET status = 'executing' WHERE id = ?").run(r.planId);
    assert.equal((await cafe1.send({ method: 'DELETE', path: `/api/requests/${r.id}` })).status, 409);
    h.db.prepare("UPDATE plan_versions SET status = 'approved' WHERE id = ?").run(r.planId);
    h.db.prepare("UPDATE reservations SET status = 'reconciling' WHERE plan_version_id = ?").run(r.planId);
    const res = await cafe1.send({ method: 'DELETE', path: `/api/requests/${r.id}` });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'PAYMENT_IN_PROGRESS');
    h.db.prepare("UPDATE reservations SET status = 'active' WHERE plan_version_id = ?").run(r.planId);
    assert.equal((await cafe1.send({ method: 'DELETE', path: `/api/requests/${r.id}` })).status, 200);
  });

  test('RS-39: with settled payments (captured) the request is tombstoned and the payment rows keep their ids and amounts', async () => {
    const r = await fullRequest(cafe1, { reserveStock: true });
    h.db.prepare("UPDATE plan_versions SET status = 'executed' WHERE id = ?").run(r.planId);
    h.db.prepare("UPDATE reservations SET status = 'consumed' WHERE plan_version_id = ?").run(r.planId);
    h.db.prepare("UPDATE payment_operations SET status = 'captured' WHERE supplier_order_id IN (SELECT id FROM supplier_orders WHERE plan_version_id = ?)").run(r.planId);
    const ops = h.db.prepare('SELECT po.id, po.amount_cents, po.status FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id WHERE so.plan_version_id = ? ORDER BY po.id').all(r.planId).map((o) => ({ ...o }));
    const res = await cafe1.send({ method: 'DELETE', path: `/api/requests/${r.id}` });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.deleted, 'tombstoned');
    assert.deepEqual(h.db.prepare('SELECT po.id, po.amount_cents, po.status FROM payment_operations po JOIN supplier_orders so ON so.id = po.supplier_order_id WHERE so.plan_version_id = ? ORDER BY po.id').all(r.planId).map((o) => ({ ...o })), ops);
    assert.equal(h.db.prepare('SELECT status FROM plan_versions WHERE id = ?').get(r.planId).status, 'executed', 'an executed plan is not touched');
    assert.equal(h.db.prepare('SELECT raw_text FROM rescue_requests WHERE id = ?').get(r.id).raw_text, null);
    // Clean up so the stock invariant of the next cases is unaffected.
    h.db.prepare("UPDATE reservations SET status = 'released' WHERE plan_version_id = ?").run(r.planId);
    h.db.prepare("UPDATE inventory SET reserved = 0").run();
  });

  test('RS-39: the owner only: a foreign id is 404 and changes nothing', async () => {
    const id = await newRequest(cafe1);
    await upload(cafe1, id, png('mine'));
    cafe2 = await signIn(h, 'cafe2'); // the earlier session idled out in pinned time
    const res = await cafe2.send({ method: 'DELETE', path: `/api/requests/${id}` });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM rescue_requests WHERE id = ?', id), 1);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE request_id = ?', id), 1);
    assert.equal((await cafe1.send({ method: 'DELETE', path: '/api/requests/abc' })).status, 400);
  });

  test('RS-39: the request view advertises the capability the UI needs to show "Delete request"', async () => {
    const id = await newRequest(cafe1);
    const view = (await cafe1.get(`/api/requests/${id}`)).json;
    assert.deepEqual(view.capabilities, { deleteRequest: true });
  });
});

// ------------------------------------------------------------------------------------------------ retention

describe('RS-39: the retention sweep, with a pinned clock', () => {
  let h;
  let cafe1;
  let T0;
  before(async () => {
    h = await startHarness({ seed: true, env: MANY_REQUESTS });
    cafe1 = await signIn(h, 'cafe1');
    T0 = h.clock.now();
  });
  after(() => h.close());

  // Moves the pinned clock and signs in again: a session does not outlive 12 hours of pinned time.
  const at = async (ms) => {
    h.clock.set(ms);
    cafe1 = await signIn(h, 'cafe1');
  };
  const sweep = (extra = {}) => runRetentionSweep({ db: h.db, clock: h.clock, config: h.config, log: h.app.deps.log, ...extra });
  const auditOf = (action) => h.db.prepare('SELECT * FROM audit_events WHERE action = ? ORDER BY id').all(action);

  test('RS-39: an image is kept at 6 days 23 hours, deleted at 7 days + 1 minute (row, file and an audit event)', async () => {
    const id = await newRequest(cafe1);
    const up = await upload(cafe1, id, png('retained'));
    assert.equal(up.status, 201);
    const row = h.db.prepare('SELECT * FROM images WHERE id = ?').get(up.json.image.id);
    const file = join(h.config.uploadDir, `${row.file_name}.png`);
    assert.equal(row.created_at, iso(T0));

    h.clock.set(T0 + 6 * DAY_MS + 23 * 3600 * 1000);
    const kept = await sweep();
    assert.equal(kept.images, 0);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE id = ?', row.id), 1);
    assert.ok(existsSync(file));
    assert.equal(auditOf('image.retention_delete').length, 0);

    h.clock.set(T0 + 7 * DAY_MS + 60 * 1000);
    const swept = await sweep();
    assert.equal(swept.images, 1);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE id = ?', row.id), 0);
    assert.equal(existsSync(file), false);
    const events = auditOf('image.retention_delete');
    assert.equal(events.length, 1);
    assert.deepEqual(
      { entity_type: events[0].entity_type, entity_id: events[0].entity_id, outcome: events[0].outcome, actor_role: events[0].actor_role, actor_user_id: events[0].actor_user_id, at: events[0].at },
      { entity_type: 'image', entity_id: row.id, outcome: 'ok', actor_role: 'system', actor_user_id: null, at: iso(T0 + 7 * DAY_MS + 60 * 1000) },
    );
    assert.deepEqual(JSON.parse(events[0].detail_json), { requestId: id, days: 7 });
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM rescue_requests WHERE id = ?', id), 1, 'only the image goes; the request stays');
    assert.equal((await sweep()).images, 0, 'a second pass finds nothing');
    assert.equal(auditOf('image.retention_delete').length, 1);
  });

  test('RS-39: the boundary is "created at or before now - 7 days": exactly 7 days is deleted, one millisecond younger is kept', async () => {
    await at(T0);
    const a = await newRequest(cafe1);
    const first = await upload(cafe1, a, png('edge-a'));
    h.clock.advance(1);
    const b = await newRequest(cafe1);
    const second = await upload(cafe1, b, png('edge-b'));
    h.clock.set(T0 + 7 * DAY_MS);
    await sweep();
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE id = ?', first.json.image.id), 0);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE id = ?', second.json.image.id), 1);
  });

  test('RS-39: an expired image whose file is already gone still loses its row and gets its audit event', async () => {
    await at(T0 + 30 * DAY_MS);
    const id = await newRequest(cafe1);
    const up = await upload(cafe1, id, png('vanished'));
    const row = h.db.prepare('SELECT file_name FROM images WHERE id = ?').get(up.json.image.id);
    rmSync(join(h.config.uploadDir, `${row.file_name}.png`));
    h.clock.advance(8 * DAY_MS);
    const result = await sweep();
    assert.ok(result.images >= 1);
    assert.deepEqual(result.failed, []);
    assert.equal(count(h, 'SELECT COUNT(*) AS n FROM images WHERE id = ?', up.json.image.id), 0);
    assert.equal(auditOf('image.retention_delete').filter((e) => e.entity_id === up.json.image.id).length, 1);
  });

  test('RS-39: orphan files older than a day are removed with an audit event; fresh files, known images and foreign names are left alone', async () => {
    await at(T0 + 60 * DAY_MS);
    const now = h.clock.now();
    const root = h.config.uploadDir;
    mkdirSync(join(root, '.tmp'), { recursive: true });
    const stamp = (path, ms) => utimesSync(path, new Date(ms), new Date(ms));
    const make = (path, ms) => {
      writeFileSync(path, 'x');
      stamp(path, ms);
    };
    const id = await newRequest(cafe1);
    const up = await upload(cafe1, id, png('known'));
    const known = join(root, `${h.db.prepare('SELECT file_name FROM images WHERE id = ?').get(up.json.image.id).file_name}.png`);
    stamp(known, now - 3 * DAY_MS);
    const orphanOld = join(root, `${'a'.repeat(32)}.png`);
    const orphanFresh = join(root, `${'b'.repeat(32)}.jpg`);
    const stranger = join(root, 'notes.txt');
    const tmpOld = join(root, '.tmp', 'c'.repeat(32));
    const tmpStranger = join(root, '.tmp', 'readme.txt');
    make(orphanOld, now - 2 * DAY_MS);
    make(orphanFresh, now - 3600 * 1000);
    make(stranger, now - 9 * DAY_MS);
    make(tmpOld, now - 2 * DAY_MS);
    make(tmpStranger, now - 9 * DAY_MS);
    const before = auditOf('image.orphan_delete').length;
    const result = await sweep();
    assert.equal(result.orphans, 2);
    assert.equal(existsSync(orphanOld), false);
    assert.equal(existsSync(tmpOld), false);
    for (const kept of [orphanFresh, stranger, tmpStranger, known]) assert.ok(existsSync(kept), kept);
    assert.equal(auditOf('image.orphan_delete').length, before + 2);
  });

  test('SEC-C-3: the sweep purges rate rows older than 24 h (the u:<id> rows of every signed-in call included) and keeps request_create 48 h (FU-20)', async () => {
    h.clock.set(T0 + 90 * DAY_MS);
    const now = h.clock.now();
    const hour = 3600 * 1000;
    const put = (key, kind, ageHours) => h.db.prepare('INSERT INTO rate_events (user_key, kind, at) VALUES (?, ?, ?)').run(key, kind, iso(now - ageHours * hour));
    put('u:901', 'general', 25);
    put('u:901', 'general', 23);
    put('u:902', 'extract_or_upload', 25);
    put('u:902', 'extract_or_upload', 1);
    put('u:903', 'request_create', 47);
    put('u:903', 'request_create', 49);
    put('ip:1.2.3.4', 'register', 30);
    const result = await sweep();
    assert.equal(result.rateEvents >= 4, true);
    const left = h.db.prepare("SELECT user_key, kind, at FROM rate_events WHERE user_key IN ('u:901','u:902','u:903','ip:1.2.3.4') ORDER BY user_key, at").all();
    assert.deepEqual(
      left.map((r) => [r.user_key, r.kind, Math.round((now - Date.parse(r.at)) / hour)]),
      [['u:901', 'general', 23], ['u:902', 'extract_or_upload', 1], ['u:903', 'request_create', 47]],
    );
  });

  test('NFR6: the sweep settles a model reservation that has been in flight for more than twice the model timeout (a crashed call must not block its customer)', async () => {
    h.clock.set(T0 + 100 * DAY_MS);
    const user = h.db.prepare("SELECT id FROM users WHERE username = 'cafe1'").get();
    const gate = createAiRuntime({ db: h.db, clock: h.clock, config: h.config }).gate;
    const insert = (ageMs) => h.db.prepare("INSERT INTO model_spend (day, customer_id, request_id, purpose, reserved_micro_usd, status, created_at) VALUES ('2026-01-01', ?, NULL, 'extract', 50000, 'reserved', ?)").run(user.id, iso(h.clock.now() - ageMs)).lastInsertRowid;
    const stale = Number(insert(2 * h.config.modelTimeoutMs + 1000));
    const young = Number(insert(1000));
    const result = await sweep({ gate });
    assert.equal(result.staleSpend, 1);
    assert.deepEqual({ ...h.db.prepare('SELECT status, actual_micro_usd FROM model_spend WHERE id = ?').get(stale) }, { status: 'settled', actual_micro_usd: 50000 });
    assert.equal(h.db.prepare('SELECT status FROM model_spend WHERE id = ?').get(young).status, 'reserved');
    h.db.prepare('DELETE FROM model_spend WHERE id = ?').run(young);
  });

  test('RS-39: the retention window follows RS_IMAGE_RETENTION_DAYS', async () => {
    const h3 = await startHarness({ seed: true, env: { RS_IMAGE_RETENTION_DAYS: '1' } });
    try {
      const c = await signIn(h3, 'cafe1');
      const id = await newRequest(c);
      const up = await upload(c, id, png('one-day'));
      const t0 = h3.clock.now();
      h3.clock.set(t0 + DAY_MS - 60000);
      assert.equal((await runRetentionSweep({ db: h3.db, clock: h3.clock, config: h3.config })).images, 0);
      h3.clock.set(t0 + DAY_MS + 60000);
      assert.equal((await runRetentionSweep({ db: h3.db, clock: h3.clock, config: h3.config })).images, 1);
      assert.equal(count(h3, 'SELECT COUNT(*) AS n FROM images WHERE id = ?', up.json.image.id), 0);
    } finally {
      await h3.close();
    }
  });
});

describe('RS-39: the process starts the sweep at startup and then on a timer', () => {
  test('RS-39: startApp removes an expired image at startup and another one on the next tick (RS_RETENTION_INTERVAL_MS)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-retention-'));
    const env = { ...testEnv(dir, { RS_RETENTION_INTERVAL_MS: '30', RS_MODEL_PROVIDER: 'fake' }), RS_ADMIN_PASSWORD: undefined };
    const clock = fixedClock(FIXED_NOW_MS);
    const uploads = join(dir, 'uploads');
    mkdirSync(uploads, { recursive: true });
    const seed = openDb(join(dir, 'app.db'));
    migrate(seed, { clock });
    const userId = Number(seed.prepare("INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ('startup-test', 'x', 'customer', 'T', ?)").run(iso(FIXED_NOW_MS)).lastInsertRowid);
    const requestId = Number(seed.prepare("INSERT INTO rescue_requests (customer_id, raw_text, language, intake_status, created_at) VALUES (?, 'text', 'en', 'draft', ?)").run(userId, iso(FIXED_NOW_MS - 9 * DAY_MS)).lastInsertRowid);
    const addImage = (db, name, createdAt, rid) => {
      writeFileSync(join(uploads, `${name}.png`), png(name));
      return Number(db.prepare("INSERT INTO images (request_id, file_name, mime_detected, bytes, sha256, created_at) VALUES (?, ?, 'image/png', 10, ?, ?)").run(rid, name, sha(png(name)), createdAt).lastInsertRowid);
    };
    const firstName = '1'.repeat(32);
    const firstId = addImage(seed, firstName, iso(FIXED_NOW_MS - 8 * DAY_MS), requestId);
    seed.close();

    const lines = [];
    const running = await startApp({ env: { ...env }, log: createLogger({ write: (l) => lines.push(l), clock }), clock });
    try {
      await running.retention.started;
      assert.equal(running.db.prepare('SELECT COUNT(*) AS n FROM images WHERE id = ?').get(firstId).n, 0, 'removed by the startup pass');
      assert.equal(existsSync(join(uploads, `${firstName}.png`)), false);
      assert.equal(running.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'image.retention_delete' AND entity_id = ?").get(firstId).n, 1);

      const secondName = '2'.repeat(32);
      const secondRequest = Number(running.db.prepare("INSERT INTO rescue_requests (customer_id, raw_text, language, intake_status, created_at) VALUES (?, 'text', 'en', 'draft', ?)").run(userId, iso(FIXED_NOW_MS - 9 * DAY_MS)).lastInsertRowid);
      const secondId = addImage(running.db, secondName, iso(FIXED_NOW_MS - 8 * DAY_MS), secondRequest);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && running.db.prepare('SELECT COUNT(*) AS n FROM images WHERE id = ?').get(secondId).n > 0) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(running.db.prepare('SELECT COUNT(*) AS n FROM images WHERE id = ?').get(secondId).n, 0, 'removed by a later tick of the timer');
      assert.equal(existsSync(join(uploads, `${secondName}.png`)), false);
      assert.ok(lines.some((l) => JSON.parse(l).msg === 'retention.sweep'));
      assert.doesNotMatch(lines.join(''), /startup-test|"text"/, 'log lines carry counts, never request text');
    } finally {
      await running.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TR-D-9: shutdown closes the provider', () => {
  const stubProvider = (extra = {}) => ({
    id: 'fake', simulated: true, model: 'stub', extract: async () => { throw new Error('not called'); }, ...extra,
  });
  const boot = async (provider) => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-close-'));
    const clock = fixedClock(FIXED_NOW_MS);
    const lines = [];
    const running = await startApp({
      env: { ...testEnv(dir), RS_ADMIN_PASSWORD: undefined }, log: createLogger({ write: (l) => lines.push(l), clock }), clock, provider,
    });
    return { running, dir, lines };
  };

  test('TR-D-9: close() awaits provider.close() once, before the listener is closed', async () => {
    const order = [];
    let calls = 0;
    const { running, dir } = await boot(stubProvider({
      close: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        order.push('provider.close');
      },
    }));
    try {
      const appClose = running.app.close.bind(running.app);
      running.app.close = async () => { order.push('app.close'); return appClose(); };
      await running.close();
      assert.equal(calls, 1);
      assert.deepEqual(order, ['provider.close', 'app.close'], 'the in-flight children are killed first, and the wait finishes before the listener closes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('TR-D-9: a provider without close() (the fake, the API adapter) shuts down cleanly', async () => {
    const { running, dir } = await boot(stubProvider());
    try {
      await running.close();
      assert.equal(running.ai.provider.close, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('TR-D-9: a provider.close() that throws is logged by code and never blocks the shutdown', async () => {
    const { running, dir, lines } = await boot(stubProvider({ close: () => { throw Object.assign(new Error('secret-detail sk-leak'), { code: 'EBOOM' }); } }));
    try {
      await running.close();
      const warn = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'extraction.close_failed');
      assert.ok(warn, 'a warning is logged');
      assert.doesNotMatch(lines.join(''), /secret-detail|sk-leak/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
