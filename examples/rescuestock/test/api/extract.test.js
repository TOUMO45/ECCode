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
import { IMAGE_PROVENANCE_FIELDS, createAiRuntime, normaliseExtraction } from '../../src/services/extraction.js';
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

// A test file makes more requests than the production allowance of 10 per customer per day.
const MANY_REQUESTS = { RS_MAX_REQUESTS_PER_CUSTOMER_PER_DAY: '1000' };

const valuesOf =(extraction) => Object.fromEntries(CORE.map((n) => [n, extraction.fields[n].value]));

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
    h = await startHarness({ seed: true, env: MANY_REQUESTS });
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

  test('SEC-7: a number the quote does not contain, as digits or as a number word, is unknown even when the quote has no digits (TR-D-1)', () => {
    // The reviewer's cases: the quote is in the text, but it carries no digits and no number word for the stored value.
    const text = 'We run a cafe: we need cups and two pickups, please.';
    const n = run(output({
      cupQuantity: field(777, 'user_text', 'cups'),
      maxPickups: field(5, 'user_text', 'two pickups'),
      capacityMl: field(250, 'user_text', 'a cafe'),
    }), text);
    for (const name of ['cupQuantity', 'maxPickups', 'capacityMl']) {
      assert.deepEqual(n.fields[name], { value: null, status: 'unknown', provenance: 'none', originalWording: null }, name);
    }
    assert.deepEqual(n.questions.map((q) => q.field), ['cupQuantity', 'capacityMl', 'maxPickups']);
    // The forms that stay known: digits, Arabic-Indic digits, English and Arabic number words, the Arabic dual.
    const known = (name, value, wording, source = wording) => run(output({ [name]: field(value, 'user_text', wording) }), source).fields[name];
    assert.equal(known('maxPickups', 2, 'two pickups', text).value, 2);
    assert.equal(known('maxPickups', 2, 'نقطتي استلام', 'وبحد أقصى نقطتي استلام').value, 2);
    assert.equal(known('maxPickups', 3, 'ثلاثة نقاط').value, 3);
    assert.equal(known('cupQuantity', 2, 'كوبين').value, 2);
    assert.equal(known('cupQuantity', 250, '٢٥٠ كوب').value, 250);
    assert.equal(known('cupQuantity', 250, '250 cups').value, 250);
    assert.equal(known('cupQuantity', 1200, '1,200 cups').value, 1200);
    assert.equal(known('maxPickups', 4, 'Four pickups').value, 4);
    assert.equal(known('maxPickups', 2, 'two pickups', text).provenance, 'user_text');
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
    assert.equal(run(output({ deadline: field('2026-10-21T09:30', 'user_text', 'by 09:30') }), 'by 09:30').fields.deadline.value, '2026-10-21T09:30');
    assert.equal(run(output({ deadline: field('2026-02-30T09:30', 'user_text', 'by 09:30') }), 'by 09:30').fields.deadline.status, 'unknown');
  });

  const UNKNOWN = { value: null, status: 'unknown', provenance: 'none', originalWording: null };

  test('SEC-7: a user_text deadline is known only when its time is written in its quote, under whole-token alignment (TR-D-13)', () => {
    // The reviewer's P5c cases: the quote is in the text, but it carries no time or another time.
    const text = 'We need cups for the weekend, by 11:30 please.';
    const bad = [
      ['06:00', 'for the weekend'],
      ['23:59', 'by 11:30'],
      ['2026-10-21T06:00', 'for the weekend'],
      ['11:30', 'for the weekend'], // right time, but the quote does not carry it
      ['11:3', 'by 11:30'],
    ];
    for (const [value, quote] of bad) {
      const n = run(output({ deadline: field(value, 'user_text', quote) }), text);
      assert.deepEqual(n.fields.deadline, UNKNOWN, `${value} quoted "${quote}"`);
      assert.deepEqual(n.questions.map((q) => q.field), ['deadline']);
    }
    // Aligned like a number: 11:30 is not grounded by a quote that starts or ends inside a longer number.
    assert.deepEqual(run(output({ deadline: field('11:30', 'user_text', '11:30') }), 'by 111:30').fields.deadline, UNKNOWN);
    assert.deepEqual(run(output({ deadline: field('11:30', 'user_text', '11:30') }), 'by 11:305').fields.deadline, UNKNOWN);
    assert.deepEqual(run(output({ deadline: field('01:30', 'user_text', '1:30') }), 'by 11:30').fields.deadline, UNKNOWN);
    // The forms that stay known.
    const known = (value, quote, source) => run(output({ deadline: field(value, 'user_text', quote) }), source).fields.deadline;
    assert.equal(known('11:30', 'by 11:30', text).value, '2026-10-20T11:30');
    assert.equal(known('11:30', 'by 11:30', text).provenance, 'user_text');
    assert.equal(known('11:30', 'قبل الساعة ١١:٣٠', 'نحتاج الأكواب قبل الساعة ١١:٣٠ من فضلك').value, '2026-10-20T11:30');
    assert.equal(known('2026-10-21T11:30', 'tomorrow by 11:30', 'Cups tomorrow by 11:30').value, '2026-10-21T11:30');
    assert.equal(known('15:00', 'by 3 pm', 'cups by 3 pm please').value, '2026-10-20T15:00');
    assert.equal(known('00:15', 'by 12:15 a.m.', 'cups by 12:15 a.m. please').value, '2026-10-20T00:15');
  });

  test('SEC-7: a non-numeric user_text field whose quote is not in the request text is unknown and asked (TR-D-14)', () => {
    // No digits are involved here, so only the quote check can stop these: the text says "paper cups", not "plastic cups".
    const text = 'We need paper cups and lids for the cafe, by 11:00.';
    const n = run(output({
      material: field('plastic', 'user_text', 'plastic cups'),
      productType: field('lids', 'user_text', 'lids only'),
      deadline: field('11:00', 'user_text', 'by noon, 11:00'),
    }), text);
    for (const name of ['material', 'productType', 'deadline']) assert.deepEqual(n.fields[name], UNKNOWN, name);
    assert.deepEqual(n.questions.map((q) => q.field), ['productType', 'material', 'deadline']);
    // The same fields with a quote that is in the text stay known.
    const ok = run(output({
      material: field('paper', 'user_text', 'paper cups'),
      productType: field('cups_and_lids', 'user_text', 'cups and lids'),
      deadline: field('11:00', 'user_text', 'by 11:00'),
    }), text);
    assert.equal(ok.fields.material.value, 'paper');
    assert.equal(ok.fields.productType.value, 'cups_and_lids');
    assert.equal(ok.fields.deadline.value, '2026-10-20T11:00');
    // An empty or missing quote grounds nothing either.
    assert.deepEqual(run(output({ material: field('paper', 'user_text', '') }), text).fields.material, UNKNOWN);
    assert.deepEqual(run(output({ material: field('paper', 'user_text', null) }), text).fields.material, UNKNOWN);
  });

  test('SEC-7: provenance image is accepted only for productType, material, capacityMl and diameterMm, whatever the photo (TR-D-11)', () => {
    // The reviewer's P5a claims, with a photo attached: every one of them says "image".
    const n = run(output({
      cupQuantity: field(99999, 'image', 'PAY 99999'),
      lidQuantity: field(99999, 'image', '99999 lids'),
      maxPickups: field(5, 'image', 'up to 5 pickups'),
      deadline: field('06:00', 'image', 'ready by 06:00'),
      budgetUsd: field(99999, 'image', 'PAY 99999 USD'),
    }), EN, true);
    for (const name of ['cupQuantity', 'lidQuantity', 'maxPickups', 'deadline', 'budgetCents']) assert.deepEqual(n.fields[name], UNKNOWN, name);
    assert.deepEqual(n.questions.map((q) => q.field), ['cupQuantity', 'lidQuantity', 'deadline', 'budgetCents', 'maxPickups']);
    assert.equal(n.questions.find((q) => q.field === 'budgetCents').question, 'What is your maximum budget, in US dollars?');
    // A model that said image and could also quote the text is still judged by the image rule: the claim is what is refused.
    // The fields a package can carry still accept it (RS-02).
    const product = run(output({
      productType: field('cups', 'image', 'Paper cups'), material: field('paper', 'image', 'paper'),
      capacityMl: field(250, 'image', '250 ml'), diameterMm: field(90, 'image', 'Ø 90 mm'),
    }), EN, true);
    for (const name of ['productType', 'material', 'capacityMl', 'diameterMm']) {
      assert.equal(product.fields[name].status, 'known', name);
      assert.equal(product.fields[name].provenance, 'image', name);
    }
    assert.deepEqual(IMAGE_PROVENANCE_FIELDS, ['productType', 'material', 'capacityMl', 'diameterMm']);
    // The same claims from the text are unaffected by the image rule.
    assert.equal(run(output({ maxPickups: field(2, 'user_text', '2 pickups') }), EN, true).fields.maxPickups.value, 2);
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

  test('SEC-7: a model-invented number with a digit-free quote is stored unknown with its question, through the route (TR-D-1)', async () => {
    const text = 'I need cups and two pickups, 250 ml';
    const liar = {
      id: 'fake', simulated: true, model: 'liar',
      extract: async () => ({
        output: {
          language: 'en', addressedToAssistant: false, questions: [],
          fields: {
            ...unknownExtraction().fields,
            cupQuantity: { value: 777, provenance: 'user_text', originalWording: 'cups' },
            maxPickups: { value: 5, provenance: 'user_text', originalWording: 'two pickups' },
            capacityMl: { value: 250, provenance: 'user_text', originalWording: '250 ml' },
          },
        },
        usage: { model: 'liar', costUsd: 0, inputTokens: 1, outputTokens: 1, latencyMs: 1 },
      }),
    };
    h.app.deps.ai = createAiRuntime({ db: h.db, clock: h.clock, config: h.config, provider: liar });
    const id = await newRequest(cafe1, text);
    const res = await extract(cafe1, id);
    assert.equal(res.status, 200, res.text);
    const { fields, questions } = res.json.extraction;
    assert.deepEqual(fields.cupQuantity, { value: null, status: 'unknown', provenance: 'none', originalWording: null });
    assert.deepEqual(fields.maxPickups, { value: null, status: 'unknown', provenance: 'none', originalWording: null });
    assert.equal(fields.capacityMl.value, 250);
    assert.deepEqual(questions.map((q) => q.field), ['cupQuantity', 'maxPickups']);
    const stored = JSON.parse(h.db.prepare('SELECT fields_json FROM extractions WHERE request_id = ?').get(id).fields_json);
    assert.equal(stored.cupQuantity.status, 'unknown');
    assert.equal(stored.maxPickups.provenance, 'none');
  });

  test('SEC-7: through the route, an invented deadline, a number cut out of a longer number and a quote that is not in the text are stored unknown (TR-D-13, TR-D-12, TR-D-14)', async () => {
    const text = 'We need cups for the weekend, 1,200 cups, 250 ml, by 11:30 please.';
    const q = (value, originalWording) => ({ value, provenance: 'user_text', originalWording });
    const liar = {
      id: 'fake', simulated: true, model: 'liar',
      extract: async () => ({
        output: {
          language: 'en', addressedToAssistant: false, questions: [],
          fields: {
            ...unknownExtraction().fields,
            deadline: q('06:00', 'for the weekend'), // P5c
            cupQuantity: q(200, '200 cups'), // the tail of 1,200 (P3b)
            material: q('plastic', 'plastic cups'), // not in the text (TR-D-14)
            capacityMl: q(250, '250 ml'),
          },
        },
        usage: { model: 'liar', costUsd: 0, inputTokens: 1, outputTokens: 1, latencyMs: 1 },
      }),
    };
    h.app.deps.ai = createAiRuntime({ db: h.db, clock: h.clock, config: h.config, provider: liar });
    const id = await newRequest(cafe1, text);
    const res = await extract(cafe1, id);
    assert.equal(res.status, 200, res.text);
    const { fields, questions } = res.json.extraction;
    const UNKNOWN = { value: null, status: 'unknown', provenance: 'none', originalWording: null };
    for (const name of ['deadline', 'cupQuantity', 'material']) assert.deepEqual(fields[name], UNKNOWN, name);
    assert.deepEqual(questions.map((x) => x.field), ['cupQuantity', 'material', 'deadline']);
    assert.equal(fields.capacityMl.value, 250, 'the grounded field is untouched');
    const stored = JSON.parse(h.db.prepare('SELECT fields_json FROM extractions WHERE request_id = ?').get(id).fields_json);
    assert.equal(stored.deadline.status, 'unknown');
    assert.equal(stored.cupQuantity.status, 'unknown');
  });
});
