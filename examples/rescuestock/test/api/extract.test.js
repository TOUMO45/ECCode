// API tests for POST /api/requests/:id/extract through the deterministic fake provider (task d3-extraction-service).
// Case names start with the id of the criterion they prove: RS-01 (equivalent Arabic and English requests), SEC-7 (the
// post-validation rules downgrade a field and never trust the model), RS-27 (isolation), RS-34 (labels), and the
// addressedToAssistant contract delta. The fake is simulated: these tests prove the pipeline, not the quality of a model.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PASSWORD, startHarness } from '../helpers/app-harness.js';
import { compareShape } from '../helpers/contract-shape.js';
import { createClient } from '../helpers/fixtures.js';
import { readFileSync } from 'node:fs';
import { createAiRuntime, normaliseExtraction } from '../../src/services/extraction.js';
import { unknownExtraction } from '../../src/ai/schema.js';

const loadFixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}`, import.meta.url), 'utf8'));

// RS-FIX-1 wordings: the same request in English and in Arabic (Arabic-Indic digits, dual form for 2 pickups).
const EN = 'I need 200 cups and 200 lids, 250 ml, 90 mm, by 11:00, budget $120, at most 2 pickups.';
const AR = 'أحتاج ٢٠٠ كوب و٢٠٠ غطاء، ٢٥٠ مل، ٩٠ مم، قبل الساعة ١١:٠٠، الميزانية ١٢٠ دولار، وبحد أقصى نقطتي استلام.';
const CORE = ['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'deadline', 'budgetCents', 'maxPickups'];
const RS_FIX_1 = {
  productType: 'cups_and_lids', cupQuantity: 200, lidQuantity: 200, capacityMl: 250, diameterMm: 90, deadline: '2026-10-20T11:00',
  budgetCents: 12000, maxPickups: 2,
};
const NINE = ['productType', 'cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'material', 'deadline', 'budgetCents', 'maxPickups'];

const valuesOf = (extraction) => Object.fromEntries(CORE.map((n) => [n, extraction.fields[n].value]));

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

const extract = (client, id) => client.post(`/api/requests/${id}/extract`, {});

describe('RS-01: equivalent Arabic and English requests', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('RS-01: the RS-FIX-1 request in English and in Arabic yields identical core fields, all from the text', async () => {
    const enId = await newRequest(cafe1, EN);
    const arId = await newRequest(cafe1, AR);
    const en = await extract(cafe1, enId);
    const ar = await extract(cafe1, arId);
    assert.equal(en.status, 200, en.text);
    assert.equal(ar.status, 200, ar.text);
    assert.deepEqual(valuesOf(en.json.extraction), RS_FIX_1);
    assert.deepEqual(valuesOf(ar.json.extraction), valuesOf(en.json.extraction));
    for (const extraction of [en.json.extraction, ar.json.extraction]) {
      for (const name of CORE) {
        assert.equal(extraction.fields[name].status, 'known', name);
        assert.equal(extraction.fields[name].provenance, 'user_text', name);
      }
      assert.deepEqual(extraction.fields.material, { value: null, status: 'unknown', provenance: 'none', originalWording: null });
    }
    assert.deepEqual(en.json.extraction.questions, ar.json.extraction.questions);
  });

  test('RS-01: every original wording is an exact quote of the request text, at most 80 characters', async () => {
    for (const text of [EN, AR]) {
      const id = await newRequest(cafe1, text);
      const { extraction } = (await extract(cafe1, id)).json;
      const quotes = Object.values(extraction.fields).filter((f) => f.provenance === 'user_text').map((f) => f.originalWording);
      assert.ok(quotes.length >= 8);
      for (const quote of quotes) {
        assert.ok(text.includes(quote), quote);
        assert.ok(Array.from(quote).length <= 80);
      }
    }
  });

  test('RS-01: the response has the shape of the contract fixture, with addressedToAssistant (additive delta)', async () => {
    const id = await newRequest(cafe1, EN);
    const res = await extract(cafe1, id);
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.requestId, 'string');
    assert.deepEqual(Object.keys(res.json.extraction).sort(), [
      'addressedToAssistant', 'createdAt', 'degraded', 'errorCode', 'fields', 'id', 'model', 'provider', 'questions', 'schemaOk', 'simulated',
    ]);
    assert.deepEqual(Object.keys(res.json.extraction.fields), NINE);
    assert.equal(res.json.extraction.addressedToAssistant, false);
    assert.deepEqual(compareShape(loadFixture('request-extract.json').response, res.json), []);
  });

  test('RS-34: the extraction says it is simulated and names the provider', async () => {
    const id = await newRequest(cafe1, EN);
    const { extraction } = (await extract(cafe1, id)).json;
    assert.equal(extraction.provider, 'fake');
    assert.equal(extraction.simulated, true);
    assert.equal(extraction.degraded, false);
    assert.equal(extraction.schemaOk, true);
    assert.equal(extraction.errorCode, null);
    const view = (await cafe1.get(`/api/requests/${id}`)).json;
    assert.equal(view.labels.simulatedExtraction, true);
    assert.deepEqual(view.extraction, extraction);
  });

  test('RS-01: a missing budget and deadline stay unknown with the server-template questions (never guessed)', async () => {
    const id = await newRequest(cafe1, 'I need 200 cups and 200 lids, 250 ml, 90 mm, at most 2 pickups, by 11');
    const { extraction } = (await extract(cafe1, id)).json;
    assert.equal(extraction.fields.budgetCents.status, 'unknown');
    assert.equal(extraction.fields.deadline.status, 'unknown');
    assert.deepEqual(extraction.questions.map((q) => q.field), ['deadline', 'budgetCents']);
    assert.equal(extraction.questions[0].question, 'By when do you need them? Please give a date and a time.');
    assert.equal(extraction.questions[1].question, 'What is your maximum budget, in US dollars?');
  });

  test('RS-01: the extraction is stored as data (one row, fields_json) and moves the intake status to extracted', async () => {
    const id = await newRequest(cafe1, EN);
    assert.equal(h.db.prepare('SELECT intake_status FROM rescue_requests WHERE id = ?').get(id).intake_status, 'draft');
    const { extraction } = (await extract(cafe1, id)).json;
    const row = h.db.prepare('SELECT * FROM extractions WHERE request_id = ?').get(id);
    assert.equal(row.id, extraction.id);
    assert.equal(row.schema_ok, 1);
    assert.equal(row.degraded, 0);
    assert.equal(row.error_code, null);
    assert.equal(row.provider, 'fake');
    assert.equal(row.prompt_version, 'x1');
    assert.equal(h.db.prepare('SELECT intake_status FROM rescue_requests WHERE id = ?').get(id).intake_status, 'extracted');
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'extraction.run' AND entity_id = ?").get(id).n, 1);
  });

  test('RS-27: a foreign request id is 404 on extract; the provider is not called and nothing is written', async () => {
    const cafe2 = await signIn(h, 'cafe2');
    const id = await newRequest(cafe1, EN);
    const before = {
      spend: h.db.prepare('SELECT COUNT(*) AS n FROM model_spend').get().n,
      rows: h.db.prepare('SELECT COUNT(*) AS n FROM extractions').get().n,
      rate: h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'extract_or_upload'").get().n,
    };
    const res = await extract(cafe2, id);
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
    assert.deepEqual(
      {
        spend: h.db.prepare('SELECT COUNT(*) AS n FROM model_spend').get().n,
        rows: h.db.prepare('SELECT COUNT(*) AS n FROM extractions').get().n,
        rate: h.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE kind = 'extract_or_upload'").get().n,
      },
      before,
    );
    assert.equal((await h.request({ method: 'POST', path: `/api/requests/${id}/extract`, jsonBody: {} })).status, 401);
  });

  test('RS-01: a body that is not JSON is 400 INVALID_JSON and a bad id is 400 BAD_REQUEST, never a 500', async () => {
    const id = await newRequest(cafe1, EN);
    const bad = await cafe1.send({ method: 'POST', path: `/api/requests/${id}/extract`, headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'INVALID_JSON');
    const weird = await cafe1.post('/api/requests/abc/extract', {});
    assert.equal(weird.status, 400);
    assert.equal(weird.json.error.code, 'BAD_REQUEST');
  });
});

describe('SEC-7: post-validation normalisation never trusts the model', () => {
  const field = (value, provenance, originalWording) => ({ value, provenance, originalWording });
  const none = () => field(null, 'none', null);
  const output = (fields, questions = []) => ({
    language: 'en',
    fields: { ...unknownExtraction().fields, ...fields },
    questions,
    addressedToAssistant: false,
  });
  const run = (out, text = EN, hasImage = false) => normaliseExtraction(out, { text, requestDay: '2026-10-20', hasImage });

  test('SEC-7: values outside the plausible ranges become unknown and are asked about', () => {
    const n = run(output({
      cupQuantity: field(100001, 'user_text', '200 cups'), lidQuantity: field(0, 'user_text', '200 lids'), capacityMl: field(29, 'user_text', '250 ml'),
      diameterMm: field(151, 'user_text', '90 mm'), maxPickups: field(6, 'user_text', '2 pickups'),
    }));
    for (const name of ['cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'maxPickups']) assert.equal(n.fields[name].status, 'unknown', name);
    assert.deepEqual(n.questions.map((q) => q.field), ['cupQuantity', 'lidQuantity', 'capacityMl', 'diameterMm', 'maxPickups']);
  });

  test('SEC-7: the range edges are accepted (30 and 2000 ml, 40 and 150 mm, 1 and 5 pickups, 1 and 1,000,000 dollars)', () => {
    const STORED = { capacityMl: 'capacityMl', diameterMm: 'diameterMm', maxPickups: 'maxPickups', budgetUsd: 'budgetCents' };
    // The wording is the whole request text here, so grounding holds and only the range decides.
    const edge = (name, value, wording) => run(output({ [name]: field(value, 'user_text', wording) }), wording).fields[STORED[name]];
    assert.equal(edge('capacityMl', 30, '30 ml').value, 30);
    assert.equal(edge('capacityMl', 2000, '2000 ml').value, 2000);
    assert.equal(edge('diameterMm', 40, '40 mm').value, 40);
    assert.equal(edge('diameterMm', 150, '150 mm').value, 150);
    assert.equal(edge('maxPickups', 1, '1 pickup').value, 1);
    assert.equal(edge('maxPickups', 5, '5 pickups').value, 5);
    assert.equal(edge('budgetUsd', 1, '$1').value, 100);
    assert.equal(edge('budgetUsd', 1000000, '$1000000').value, 100000000);
    assert.equal(edge('budgetUsd', 1000000.01, '$1000000.01').status, 'unknown', 'above 1,000,000 USD');
    assert.equal(edge('budgetUsd', 0.99, '$0.99').status, 'unknown', 'below 1 USD');
  });

  test('SEC-7: a user_text value whose quote is not in the request text is downgraded (grounding), digits of either script count', () => {
    const n = run(output({
      capacityMl: field(250, 'user_text', '250 ml'),
      diameterMm: field(90, 'user_text', '90 millimetres of pure invention'),
      cupQuantity: field(300, 'user_text', '200 cups'),
    }));
    assert.equal(n.fields.capacityMl.value, 250);
    assert.equal(n.fields.diameterMm.status, 'unknown', 'the quote is not in the text');
    assert.equal(n.fields.cupQuantity.status, 'unknown', 'the quote does not contain the number');
    assert.deepEqual(run(output({ capacityMl: field(250, 'user_text', '٢٥٠ مل') }), 'أريد ٢٥٠ مل').fields.capacityMl.value, 250);
    assert.equal(run(output({ capacityMl: field(250, 'user_text', '250 مل') }), 'أريد ٢٥٠ مل').fields.capacityMl.value, 250, 'Arabic-Indic digits fold to ASCII');
    assert.equal(run(output({ capacityMl: field(250, 'user_text', '  250   ml ') }), 'need 250 ml please').fields.capacityMl.value, 250, 'whitespace is collapsed');
  });

  test('SEC-7: image provenance without an image is downgraded', () => {
    const out = output({ capacityMl: field(250, 'image', '250 ml') });
    assert.equal(run(out, EN, false).fields.capacityMl.status, 'unknown');
    assert.equal(run(out, EN, true).fields.capacityMl.provenance, 'image');
  });

  test('SEC-7: image wording loses URLs, e-mail addresses and phone runs and is cut to 80 characters', () => {
    const dirty = 'Ø 90 mm visit http://evil.example/x?a=1 or www.evil.example mail boss@evil.example call +962 7 9123 4567 now';
    const n = run(output({ diameterMm: field(90, 'image', dirty) }), EN, true);
    const wording = n.fields.diameterMm.originalWording;
    assert.equal(n.fields.diameterMm.value, 90);
    assert.match(wording, /90 mm/);
    assert.doesNotMatch(wording, /evil|http|www|@|9123|962/);
    const cut = run(output({ capacityMl: field(250, 'image', `250 ml ${'x'.repeat(300)}`) }), EN, true).fields.capacityMl.originalWording;
    assert.ok(Array.from(cut).length <= 80);
    const nothing = run(output({ capacityMl: field(250, 'image', 'http://only.example/link +962 7 9123 4567') }), EN, true).fields.capacityMl;
    assert.equal(nothing.value, 250);
    assert.equal(nothing.originalWording, null, 'nothing meaningful remains');
  });

  test('SEC-7: a currency other than USD in the wording makes the budget unknown and asks for US dollars', () => {
    for (const wording of ['budget 50 JOD', 'Budget 50 دينار', '€50', '50 EUR']) {
      const n = run(output({ budgetUsd: field(50, 'user_text', wording) }), `please ${wording}`);
      assert.equal(n.fields.budgetCents.status, 'unknown', wording);
      assert.deepEqual(n.questions.map((q) => q.field), ['budgetCents']);
      assert.equal(n.questions[0].question, 'What is your maximum budget, in US dollars?');
    }
    assert.equal(run(output({ budgetUsd: field(50, 'user_text', 'budget $50') }), 'budget $50').fields.budgetCents.value, 5000);
  });

  test('SEC-7: a bare time gets the request day in Asia/Amman; an impossible local time is unknown', () => {
    assert.equal(run(output({ deadline: field('11:00', 'user_text', 'by 11:00') })).fields.deadline.value, '2026-10-20T11:00');
    assert.equal(run(output({ deadline: field('2026-10-21T09:30', 'user_text', 'by 11:00') }), 'by 11:00').fields.deadline.value, '2026-10-21T09:30');
    assert.equal(run(output({ deadline: field('2026-02-30T09:30', 'user_text', 'by 11:00') }), 'by 11:00').fields.deadline.status, 'unknown');
  });

  test('SEC-7: questions come only from server templates and only for fields that are still unknown', () => {
    const n = run(output({ capacityMl: field(250, 'user_text', '250 ml') }, ['capacityMl', 'material']));
    assert.deepEqual(n.questions.map((q) => q.field), ['material']);
    assert.equal(n.questions[0].question, 'Should the cups be paper or plastic?');
  });
});

describe('RS-01: the route uses the normalisation on a provider that does not validate', () => {
  let h;
  let cafe1;
  before(async () => {
    h = await startHarness({ seed: true });
    cafe1 = await signIn(h, 'cafe1');
  });
  after(() => h.close());

  test('SEC-7: an ungrounded answer from a provider is stored with the field unknown, and the whole call still succeeds', async () => {
    const wrong = {
      id: 'fake', simulated: true, model: 'liar',
      extract: async () => ({
        output: {
          language: 'en', addressedToAssistant: false, questions: [],
          fields: {
            ...unknownExtraction().fields,
            capacityMl: { value: 250, provenance: 'user_text', originalWording: '250 ml' },
            diameterMm: { value: 90, provenance: 'user_text', originalWording: 'a diameter nobody wrote' },
          },
        },
        usage: { model: 'liar', costUsd: 0, inputTokens: 1, outputTokens: 1, latencyMs: 1 },
      }),
    };
    h.app.deps.ai = createAiRuntime({ db: h.db, clock: h.clock, config: h.config, provider: wrong });
    const id = await newRequest(cafe1, 'I want 250 ml cups');
    const res = await extract(cafe1, id);
    assert.equal(res.status, 200, res.text);
    const { extraction } = res.json;
    assert.equal(extraction.fields.capacityMl.value, 250);
    assert.equal(extraction.fields.diameterMm.status, 'unknown');
    assert.equal(extraction.model, 'liar');
    assert.ok(extraction.questions.some((q) => q.field === 'diameterMm'));
  });
});
