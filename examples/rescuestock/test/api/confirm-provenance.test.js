// API tests for provenance at confirmation (task d3-extraction-service), SEC-8: the client sends values only. The server keeps
// an extracted field's provenance and original wording only when the submitted value equals the extracted value of the LATEST
// extraction; everything else is `manual` with no wording. A client-sent provenance or wording is never read.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEMO_DATE, DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { createClient } from '../helpers/fixtures.js';
import { createAiRuntime } from '../../src/services/extraction.js';

const EN = 'I need 200 cups and 200 lids, 250 ml, 90 mm, by 11:00, budget $120, at most 2 pickups.';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PHOTO = Buffer.concat([PNG_SIG, Buffer.from('label-90mm')]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const IMAGE_MAP = { [sha(PHOTO)]: { fields: { diameterMm: { value: 90, wording: 'Ø 90 mm' } } } };

const VALUES = Object.freeze({
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90, material: null,
  deadline: `${DEMO_DATE}T11:00`, budgetCents: 12000, maxPickups: 2,
});

let h;
let cafe1;

before(async () => {
  h = await startHarness({ seed: true });
  h.app.deps.ai = createAiRuntime({ db: h.db, clock: h.clock, config: h.config, imageMap: IMAGE_MAP });
  cafe1 = createClient(h.request);
  await cafe1.signIn('cafe1', DEMO_PASSWORD);
});
after(() => h.close());
beforeEach(() => h.clock.advance(11 * 60 * 1000));

async function extractedRequest(text = EN, { photo = false } = {}) {
  const created = await cafe1.post('/api/requests', { text });
  assert.equal(created.status, 201, created.text);
  const id = created.json.request.id;
  if (photo) {
    const up = await cafe1.send({ method: 'POST', path: `/api/requests/${id}/image`, headers: { 'Content-Type': 'image/png' }, body: PHOTO });
    assert.equal(up.status, 201, up.text);
  }
  const res = await cafe1.post(`/api/requests/${id}/extract`, {});
  assert.equal(res.status, 200, res.text);
  return { id, extraction: res.json.extraction };
}

const confirm = (id, fields, extra = {}) => cafe1.post(`/api/requests/${id}/confirm`, { fields, ...extra });
const provenanceOf = (res) => Object.fromEntries(Object.entries(res.json.requirements.fields).map(([n, f]) => [n, f.provenance]));

describe('SEC-8: provenance is derived by the server at confirmation', () => {
  test('SEC-8: values equal to the extracted ones keep their provenance and original wording', async () => {
    const { id, extraction } = await extractedRequest();
    const res = await confirm(id, VALUES);
    assert.equal(res.status, 201, res.text);
    const fields = res.json.requirements.fields;
    for (const name of ['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'deadline', 'budgetCents', 'maxPickups']) {
      assert.equal(fields[name].provenance, 'user_text', name);
      assert.equal(fields[name].status, 'known', name);
      assert.equal(fields[name].originalWording, extraction.fields[name].originalWording, name);
      assert.ok(EN.includes(fields[name].originalWording), name);
    }
    assert.deepEqual(fields.material, { value: null, status: 'unknown', provenance: 'none', originalWording: null });
  });

  test('SEC-8: an edited value becomes manual with no wording; the other fields keep their provenance', async () => {
    const { id } = await extractedRequest();
    const res = await confirm(id, { ...VALUES, capacityMl: 300, material: 'paper' });
    assert.equal(res.status, 201, res.text);
    const fields = res.json.requirements.fields;
    assert.deepEqual([fields.capacityMl.value, fields.capacityMl.provenance, fields.capacityMl.originalWording], [300, 'manual', null]);
    assert.deepEqual([fields.material.value, fields.material.provenance, fields.material.originalWording], ['paper', 'manual', null], 'a field the extraction left unknown');
    assert.equal(fields.cupQuantity.provenance, 'user_text');
    assert.equal(fields.diameterMm.provenance, 'user_text');
  });

  test('SEC-8: a value read from the photo keeps provenance image and its (stripped) wording when the buyer confirms it unchanged', async () => {
    const { id } = await extractedRequest('I need 200 cups and 200 lids, 250 ml, by 11:00, budget $120, at most 2 pickups.', { photo: true });
    const res = await confirm(id, VALUES);
    assert.equal(res.status, 201, res.text);
    assert.deepEqual([res.json.requirements.fields.diameterMm.provenance, res.json.requirements.fields.diameterMm.originalWording], ['image', 'Ø 90 mm']);
    assert.equal(res.json.requirements.fields.capacityMl.provenance, 'user_text');
    const changed = await confirm(id, { ...VALUES, diameterMm: 95 });
    assert.deepEqual(
      [changed.json.requirements.fields.diameterMm.provenance, changed.json.requirements.fields.diameterMm.originalWording],
      ['manual', null],
    );
  });

  test('SEC-8: a provenance or wording sent by the client is ignored, wherever it is put', async () => {
    const { id } = await extractedRequest();
    const lie = { cupQuantity: 'image', capacityMl: 'user_text', diameterMm: 'image', budgetCents: 'image' };
    const res = await confirm(
      id,
      {
        ...VALUES, capacityMl: 300, diameterMm: 80,
        provenance: lie, originalWording: { capacityMl: '<script>alert(1)</script>' }, status: 'known',
      },
      { provenance: lie, originalWording: { diameterMm: 'a photo said so' } },
    );
    assert.equal(res.status, 201, res.text);
    const fields = res.json.requirements.fields;
    assert.deepEqual([fields.capacityMl.provenance, fields.capacityMl.originalWording], ['manual', null]);
    assert.deepEqual([fields.diameterMm.provenance, fields.diameterMm.originalWording], ['manual', null]);
    assert.equal(fields.cupQuantity.provenance, 'user_text', 'the server says user_text, not what the client claimed');
    assert.doesNotMatch(res.text, /script|a photo said so/);
    assert.doesNotMatch(JSON.stringify(h.db.prepare('SELECT fields_json FROM requirements WHERE request_id = ?').get(id)), /script|a photo said so/);
  });

  test('SEC-8: a field sent as an object {value, provenance} is not a value: 422 and nothing is stored', async () => {
    const { id } = await extractedRequest();
    const res = await confirm(id, { ...VALUES, cupQuantity: { value: 200, provenance: 'image' } });
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'VALIDATION_FAILED');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM requirements WHERE request_id = ?').get(id).n, 0);
  });

  test('SEC-8: with no extraction every confirmed value is manual', async () => {
    const created = await cafe1.post('/api/requests', { text: EN });
    const res = await confirm(created.json.request.id, VALUES);
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(
      Object.values(provenanceOf(res)).sort(),
      ['manual', 'manual', 'manual', 'manual', 'manual', 'manual', 'manual', 'manual', 'none'],
    );
  });

  test('SEC-8: when the latest extraction is degraded, nothing is taken from an earlier one: every value is manual (RS-03)', async () => {
    const { id } = await extractedRequest();
    h.db.prepare("INSERT OR REPLACE INTO fault_flags (name, value, remaining, created_at) VALUES ('fake_model:error', '', 1, '2026-10-20T06:00:00.000Z')").run();
    const again = await cafe1.post(`/api/requests/${id}/extract`, {});
    assert.equal(again.json.extraction.degraded, true);
    const res = await confirm(id, VALUES);
    assert.equal(res.status, 201, res.text);
    for (const [name, provenance] of Object.entries(provenanceOf(res))) assert.equal(provenance, name === 'material' ? 'none' : 'manual', name);
  });

  test('SEC-8: the latest extraction decides: a fresh extraction after a text change is what the next confirmation compares with', async () => {
    const { id } = await extractedRequest();
    const first = await confirm(id, VALUES);
    assert.equal(first.json.requirements.fields.cupQuantity.provenance, 'user_text');
    // A second extraction (same text, same values) is the latest row; confirming the same values keeps the provenance.
    await cafe1.post(`/api/requests/${id}/extract`, {});
    const second = await confirm(id, { ...VALUES, cupQuantity: 250, lidQuantity: 250 });
    assert.equal(second.status, 201, second.text);
    assert.equal(second.json.requirements.version, 2);
    assert.deepEqual(
      [second.json.requirements.fields.cupQuantity.provenance, second.json.requirements.fields.capacityMl.provenance],
      ['manual', 'user_text'],
    );
  });

  test('SEC-8: the stored requirements row and the response agree, and the planner reads only the confirmed columns', async () => {
    const { id } = await extractedRequest();
    const res = await confirm(id, VALUES);
    const row = h.db.prepare('SELECT * FROM requirements WHERE request_id = ?').get(id);
    assert.deepEqual(JSON.parse(row.fields_json), res.json.requirements.fields);
    assert.deepEqual([row.cups, row.lids, row.capacity_ml, row.diameter_mm, row.budget_cents, row.max_pickups], [200, 200, 250, 90, 12000, 2]);
    const planned = await cafe1.post(`/api/requests/${id}/plan`, {});
    assert.equal(planned.status, 201, planned.text);
    assert.ok(planned.json.plan);
  });
});
