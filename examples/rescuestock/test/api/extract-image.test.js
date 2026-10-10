// API tests for extraction from a package photo (task d3-extraction-service): RS-02 (a clear photo yields capacity and diameter
// with provenance "image"), RS-03 (an ambiguous photo yields unknown fields plus a clarification question and no invented
// number), SEC-7 (wording read from a photo is stripped of URLs, e-mail addresses and phone numbers). The fake's image map is
// injected here (sha256 of the bytes -> canned reading), so these tests do not depend on the EXT-1 corpus. Simulated: they prove the
// pipeline and the harness, not a model.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { createAiRuntime } from '../../src/services/extraction.js';
import { createFakeProvider } from '../../src/ai/fake.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (label) => Buffer.concat([PNG_SIG, Buffer.from(label)]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const CLEAR = png('clear-label-250ml-90mm');
const BLURRED = png('blurred-label');
const NEVER_SEEN = png('never-seen-before');
const DIRTY = png('label-with-contact-details');
const IMAGE_MAP = {
  [sha(CLEAR)]: {
    fields: { capacityMl: { value: 250, wording: '250 ml' }, diameterMm: { value: 90, wording: 'Ø 90 mm' } },
    language: 'en',
  },
  [sha(BLURRED)]: { fields: { capacityMl: { value: 250, wording: '250 ml' } }, questions: ['diameterMm'], visibleNumbers: [250] },
  [sha(DIRTY)]: {
    fields: {
      diameterMm: { value: 90, wording: 'Ø 90 mm visit http://evil.example/x?a=1 or www.evil.example, boss@evil.example, call +962 7 9123 4567' },
      capacityMl: { value: 250, wording: '250 ml' },
    },
  },
};

async function signIn(h, username) {
  const client = createClient(h.request);
  await client.signIn(username, DEMO_PASSWORD);
  return client;
}

async function newRequest(client, text) {
  const res = await client.post('/api/requests', { text });
  assert.equal(res.status, 201, res.text);
  return res.json.request.id;
}

const upload = (client, id, bytes, type = 'image/png') =>
  client.send({ method: 'POST', path: `/api/requests/${id}/image`, headers: { 'Content-Type': type }, body: bytes });
const extract = (client, id) => client.post(`/api/requests/${id}/extract`, {});

describe('RS-02, RS-03: extraction from a package photo', () => {
  let h;
  let cafe1;
  const seen = [];
  before(async () => {
    h = await startHarness({ seed: true, env: { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' } });
    cafe1 = await signIn(h, 'cafe1');
    // The recording provider wraps the fake so a test can see exactly what the model would have been given.
    const inner = createFakeProvider({ imageMap: IMAGE_MAP, clock: h.clock });
    const recording = {
      ...inner,
      extract: async (input) => {
        seen.push({ text: input.text, image: input.image ? { mime: input.image.mime, sha256: sha(input.image.bytes), bytes: input.image.bytes.length } : null });
        return inner.extract(input);
      },
    };
    h.app.deps.ai = createAiRuntime({ db: h.db, clock: h.clock, config: h.config, provider: recording });
  });
  after(() => h.close());
  // Every upload and extract counts toward 10 per customer per 10 minutes, so each case starts in a fresh window.
  beforeEach(() => h.clock.advance(11 * 60 * 1000));

  test('RS-02: a clear photo yields capacity and diameter with provenance image; the text keeps provenance user_text', async () => {
    const id = await newRequest(cafe1, 'I need 200 cups and 200 lids, budget $120, at most 2 pickups, by 11:00');
    assert.equal((await upload(cafe1, id, CLEAR)).status, 201);
    const res = await extract(cafe1, id);
    assert.equal(res.status, 200, res.text);
    const { fields } = res.json.extraction;
    assert.deepEqual([fields.capacityMl.value, fields.capacityMl.provenance, fields.capacityMl.status], [250, 'image', 'known']);
    assert.deepEqual([fields.diameterMm.value, fields.diameterMm.provenance, fields.diameterMm.status], [90, 'image', 'known']);
    assert.equal(fields.diameterMm.originalWording, 'Ø 90 mm');
    assert.equal(fields.cupQuantity.provenance, 'user_text');
    assert.equal(fields.budgetCents.provenance, 'user_text');
    assert.equal(res.json.extraction.questions.length, 0, 'nothing is unknown that the model was asked about');
    // The provider was handed the stored bytes and the declared type, once.
    const call = seen.at(-1);
    assert.deepEqual(call.image, { mime: 'image/png', sha256: sha(CLEAR), bytes: CLEAR.length });
  });

  test('RS-02: a value stated in the text wins over the photo (the photo only fills what the text left unknown)', async () => {
    const id = await newRequest(cafe1, 'I need 200 cups and 200 lids, 300 ml');
    await upload(cafe1, id, CLEAR);
    const { fields } = (await extract(cafe1, id)).json.extraction;
    assert.deepEqual([fields.capacityMl.value, fields.capacityMl.provenance], [300, 'user_text']);
    assert.deepEqual([fields.diameterMm.value, fields.diameterMm.provenance], [90, 'image']);
  });

  test('RS-03: an ambiguous photo gives unknown for the unreadable field, a clarification question, and no invented number', async () => {
    const text = 'I need paper cups and lids for a wedding';
    const id = await newRequest(cafe1, text);
    await upload(cafe1, id, BLURRED);
    const { extraction } = (await extract(cafe1, id)).json;
    assert.equal(extraction.fields.capacityMl.value, 250);
    assert.equal(extraction.fields.capacityMl.provenance, 'image');
    assert.deepEqual(extraction.fields.diameterMm, { value: null, status: 'unknown', provenance: 'none', originalWording: null });
    assert.ok(extraction.questions.some((q) => q.field === 'diameterMm'), 'a clarification question for the diameter');
    assert.equal(extraction.questions.find((q) => q.field === 'diameterMm').question, 'What diameter are the cups, in millimetres?');
    // Every number in a known field appears in the photo's legible numbers or in the text.
    const legible = new Set([250]);
    for (const f of Object.values(extraction.fields)) if (f.status === 'known' && typeof f.value === 'number') assert.ok(legible.has(f.value), String(f.value));
  });

  test('RS-03: a photo the reader has never seen gives every photo field unknown plus questions, never a measurement', async () => {
    const id = await newRequest(cafe1, 'cups please');
    await upload(cafe1, id, NEVER_SEEN);
    const { extraction } = (await extract(cafe1, id)).json;
    assert.ok(Object.values(extraction.fields).every((f) => f.status === 'unknown' && f.value === null && f.provenance === 'none'));
    const asked = extraction.questions.map((q) => q.field);
    assert.ok(asked.includes('capacityMl') && asked.includes('diameterMm'));
    assert.equal(extraction.degraded, false, 'an unreadable photo is not an outage');
  });

  test('SEC-7: wording read from a photo is stored without URLs, e-mail addresses and phone numbers, at most 80 characters', async () => {
    const id = await newRequest(cafe1, 'cups please');
    await upload(cafe1, id, DIRTY);
    const { extraction } = (await extract(cafe1, id)).json;
    const wording = extraction.fields.diameterMm.originalWording;
    assert.equal(extraction.fields.diameterMm.value, 90);
    assert.match(wording, /90 mm/);
    assert.doesNotMatch(wording, /evil|http|www|@|9123|962/);
    assert.ok(Array.from(wording).length <= 80);
    const stored = h.db.prepare('SELECT fields_json FROM extractions WHERE id = ?').get(extraction.id).fields_json;
    assert.doesNotMatch(stored, /evil|http|www|9123/, 'the raw wording is never persisted');
  });

  test('RS-02: replacing the photo replaces what the next extraction reads (and the old file is gone)', async () => {
    const id = await newRequest(cafe1, 'I need cups and lids');
    const first = await upload(cafe1, id, CLEAR);
    const oldName = h.db.prepare('SELECT file_name FROM images WHERE id = ?').get(first.json.image.id).file_name;
    const second = await upload(cafe1, id, BLURRED);
    assert.equal(second.status, 201);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM images WHERE request_id = ?').get(id).n, 1);
    assert.equal(existsSync(join(h.config.uploadDir, `${oldName}.png`)), false);
    const { fields } = (await extract(cafe1, id)).json.extraction;
    assert.equal(fields.diameterMm.status, 'unknown');
    assert.equal(seen.at(-1).image.sha256, sha(BLURRED));
  });

  test('RS-02: a photo whose file has vanished does not break the extraction; it continues from the text alone', async () => {
    const id = await newRequest(cafe1, 'I need 200 cups and 200 lids');
    await upload(cafe1, id, CLEAR);
    const row = h.db.prepare('SELECT file_name FROM images WHERE request_id = ?').get(id);
    rmSync(join(h.config.uploadDir, `${row.file_name}.png`));
    const res = await extract(cafe1, id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.extraction.fields.capacityMl.status, 'unknown');
    assert.equal(res.json.extraction.fields.cupQuantity.value, 200);
    assert.equal(seen.at(-1).image, null);
  });

  test('RS-02: the request view carries the image summary and the extraction together', async () => {
    const id = await newRequest(cafe1, 'I need 200 cups and 200 lids');
    const up = await upload(cafe1, id, CLEAR);
    await extract(cafe1, id);
    const view = (await cafe1.get(`/api/requests/${id}`)).json;
    assert.deepEqual(view.request.image, { id: up.json.image.id, mime: 'image/png', bytes: CLEAR.length });
    assert.equal(view.extraction.fields.capacityMl.provenance, 'image');
    assert.equal(view.capabilities.deleteRequest, true);
  });
});
