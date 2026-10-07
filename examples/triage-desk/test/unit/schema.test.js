'use strict';
// Unit tests for src/triage/schema.js (spec C6.3, D2, D4; brief V1-V4, AC2, AC9 walker; review DES-3, DES-8).
// Vectors are copied verbatim from the brief (.eccode/artifacts/architecture/brief.md "Output validation rules")
// and from the approved design vectors (.eccode/artifacts/design/design-vectors.js). DES-8 vectors live here
// because design-vectors.js is an approved, hash-checked artifact and is not edited.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'triage', 'schema.js');
const schema = require(SCHEMA_PATH);
const {
  CATEGORIES, URGENCIES, FALLBACK_REASONS, OUTPUT_SCHEMA, checkSchemaKeywords, isSingleSentence,
  containsLinkOrEmail, normaliseEnum, validateTriage, validateResponse,
} = schema;

// ---------------------------------------------------------------- exports and constants (C6.3, D2)

test('exports exactly the C6.3 names', () => {
  assert.deepEqual(Object.keys(schema).sort(), [
    'CATEGORIES', 'FALLBACK_REASONS', 'OUTPUT_SCHEMA', 'URGENCIES', 'checkSchemaKeywords', 'containsLinkOrEmail',
    'isSingleSentence', 'normaliseEnum', 'validateResponse', 'validateTriage',
  ]);
  for (const fn of ['checkSchemaKeywords', 'isSingleSentence', 'containsLinkOrEmail', 'normaliseEnum',
    'validateTriage', 'validateResponse']) assert.equal(typeof schema[fn], 'function', fn);
});

test('enums have the C6.3 values and are frozen', () => {
  assert.deepEqual(CATEGORIES, ['billing', 'technical', 'account', 'feature_request', 'other']);
  assert.deepEqual(URGENCIES, ['low', 'medium', 'high']);
  assert.deepEqual(FALLBACK_REASONS, ['no_api_key', 'model_error', 'timeout', 'refusal', 'truncated', 'invalid_output']);
  for (const a of [CATEGORIES, URGENCIES, FALLBACK_REASONS]) {
    assert.ok(Object.isFrozen(a));
    assert.throws(() => { a.push('x'); }, TypeError);
  }
});

const D2_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['category', 'urgency', 'summary', 'suggestedReply'],
  properties: {
    category: { type: 'string', enum: ['billing', 'technical', 'account', 'feature_request', 'other'] },
    urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
    suggestedReply: { type: 'string' },
  },
};

function assertDeepFrozen(node, where) {
  assert.ok(Object.isFrozen(node), 'not frozen: ' + where);
  for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') assertDeepFrozen(v, where + '.' + k);
}

test('OUTPUT_SCHEMA equals D2 exactly and is deep-frozen', () => {
  assert.deepStrictEqual(OUTPUT_SCHEMA, D2_SCHEMA);
  assert.equal(JSON.stringify(OUTPUT_SCHEMA), JSON.stringify(D2_SCHEMA), 'same key order as D2');
  assertDeepFrozen(OUTPUT_SCHEMA, 'OUTPUT_SCHEMA');
  assert.throws(() => { OUTPUT_SCHEMA.properties.summary.maxLength = 200; }, TypeError);
  assert.throws(() => { OUTPUT_SCHEMA.properties.category.enum.push('refunds'); }, TypeError);
  assert.equal(OUTPUT_SCHEMA.properties.summary.maxLength, undefined);
});

// ---------------------------------------------------------------- AC9 schema keyword walker (D4)

test('checkSchemaKeywords accepts OUTPUT_SCHEMA and the D2 literal', () => {
  assert.equal(checkSchemaKeywords(OUTPUT_SCHEMA), true);
  assert.equal(checkSchemaKeywords(D2_SCHEMA), true);
});

test('checkSchemaKeywords self-check: rejects maxLength (AC9)', () => {
  const s = structuredClone(D2_SCHEMA);
  s.properties.summary.maxLength = 200;
  assert.equal(checkSchemaKeywords(s), false);
});

test('checkSchemaKeywords rejects every non-allowlisted keyword at any depth', () => {
  for (const kw of ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'maxItems', 'pattern', 'format',
    'description', 'items', '$ref', 'anyOf', 'default']) {
    const leaf = structuredClone(D2_SCHEMA);
    leaf.properties.suggestedReply[kw] = 1;
    assert.equal(checkSchemaKeywords(leaf), false, 'leaf ' + kw);
    const root = structuredClone(D2_SCHEMA);
    root[kw] = 1;
    assert.equal(checkSchemaKeywords(root), false, 'root ' + kw);
  }
});

test('checkSchemaKeywords rejects object nodes whose additionalProperties is not exactly false', () => {
  const missing = structuredClone(D2_SCHEMA); delete missing.additionalProperties;
  assert.equal(checkSchemaKeywords(missing), false);
  const asTrue = structuredClone(D2_SCHEMA); asTrue.additionalProperties = true;
  assert.equal(checkSchemaKeywords(asTrue), false);
  const asString = structuredClone(D2_SCHEMA); asString.additionalProperties = 'false';
  assert.equal(checkSchemaKeywords(asString), false);
  const nested = structuredClone(D2_SCHEMA);
  nested.properties.meta = { type: 'object', properties: { a: { type: 'string' } } };
  assert.equal(checkSchemaKeywords(nested), false, 'nested object without additionalProperties:false');
  const nestedDeep = structuredClone(D2_SCHEMA);
  nestedDeep.properties.meta = { type: 'object', additionalProperties: false,
    properties: { a: { type: 'string', pattern: '^x' } } };
  assert.equal(checkSchemaKeywords(nestedDeep), false, 'bad keyword two levels down');
  const nestedOk = structuredClone(D2_SCHEMA);
  nestedOk.properties.meta = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } };
  assert.equal(checkSchemaKeywords(nestedOk), true);
});

test('checkSchemaKeywords rejects non-object nodes and malformed properties', () => {
  for (const bad of [null, undefined, 'object', 3, [], [D2_SCHEMA]]) assert.equal(checkSchemaKeywords(bad), false);
  const badProps = structuredClone(D2_SCHEMA); badProps.properties = [];
  assert.equal(checkSchemaKeywords(badProps), false);
  const badChild = structuredClone(D2_SCHEMA); badChild.properties.summary = null;
  assert.equal(checkSchemaKeywords(badChild), false);
});

// ---------------------------------------------------------------- V1 (brief + D4/ARCH-11)

const V1_ACCEPT = [
  // brief
  'Customer was charged twice for the March invoice.',
  'Login fails on v2.1 of the iOS app.',
  'Mr. Lee cannot reset his password.',
  'User reports slow exports, e.g. CSV files over 10 MB.',
  'Customer asks whether the Pro plan supports SSO?',
  'Dr. Patel requests a refund for order No. 4412.',
  // D4 (ARCH-11)
  'Sync fails since Oct. 3 update.',
  'Customer was charged $10.50 twice.',
];
const V1_REJECT = [
  // brief
  'Payment failed. Customer wants a refund.',
  'Outage reported',
  'Line one.\nLine two.',
  '',
  'x'.repeat(200) + '.', // 201 characters
  'Refund requested! Please hurry.',
  ' Leading space.',
  // D4 (ARCH-11)
  'Customer on plan B. Wants refund.',
];

test('V1 accepts every accept vector', () => {
  for (const s of V1_ACCEPT) assert.equal(isSingleSentence(s), true, 'V1 should accept: ' + s);
});
test('V1 rejects every reject vector', () => {
  assert.equal(V1_REJECT[4].length, 201);
  for (const s of V1_REJECT) assert.equal(isSingleSentence(s), false, 'V1 should reject: ' + JSON.stringify(s.slice(0, 40)));
});
test('V1 edge cases: length bounds, CR, trailing space, every month abbreviation, non-strings', () => {
  assert.equal(isSingleSentence('x'.repeat(199) + '.'), true, '200 characters is allowed');
  assert.equal(isSingleSentence('.'), true);
  assert.equal(isSingleSentence('Line one.\rLine two.'), false);
  assert.equal(isSingleSentence('Trailing space. '), false);
  for (const m of ['Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec']) {
    assert.equal(isSingleSentence(`Billing changed on ${m}. 3 for the customer.`), true, m);
  }
  for (const a of ['etc', 'vs', 'i.e', 'Mrs', 'Ms', 'Inc', 'Ltd', 'approx']) {
    assert.equal(isSingleSentence(`Customer mentions ${a}. Something else here.`), true, a);
  }
  assert.equal(isSingleSentence('Customer mentions May. Something else here.'), false, 'May is a full word, not an abbreviation');
  for (const bad of [null, undefined, 3, ['a.'], { s: 'a.' }]) assert.equal(isSingleSentence(bad), false);
});

// ---------------------------------------------------------------- V2 (brief + D4 ARCH-11 + DES-3 + DES-8)

const V2_ACCEPT = [
  // brief
  'Thanks for reaching out; we are looking into the v2.1 crash.',
  'Please reply with your order number, e.g. 12345.',
  'We are looking at the issue now and will update you.',
  'Our team will review the Node.js error you saw.',
  'Sorry about the double charge; we will investigate.',
  // D4 ARCH-11 product-token mask
  'Customer reports ASP.NET errors after the update.',
  'Socket.io connections drop every minute.',
  'The VB.NET client and ADO.NET driver both fail.',
  // DES-3 sentence-final product tokens
  'Customer reports errors in ASP.NET.',
  'Customer reports a crash in VB.NET.',
  'Socket.io connections drop after the update to Socket.io.',
  'Customer uses ASP.NET, and it fails.',
  'Customer cannot connect via socket.io?',
  'The ADO.NET driver fails!',
];
const V2_REJECT = [
  // brief
  'Visit https://example.com for help.',
  'See www.example.com.',
  'Go to example.com to reset.',
  'Use example.zz/reset to continue.',
  'Mail support@example.com.',
  'Write to name at example dot com.',
  'Write to name [at] example [dot] com.',
  'Try ftp://files.example.zz now.',
  // D4 ARCH-11: the mask opens no hole
  'Go to evil-asp.net now.',
  'Go to asp.net.evil.com now.',
  'Go to my.socket.io now.',
  'Open socket.io/reset to continue.',
  'Open https://asp.net now.',
  'Mail admin@socket.io today.',
  'Go to socket.io.evil.ru now.',
  // DES-3: the relaxed lookahead still rejects host continuations
  'Go to asp.net.evil.com.',
  'Go to socket.io.evil.ru.',
  'Go to vb.net.x.co now.',
  'See asp.net..evil.com now.',
  'See asp.net.-evil.com now.',
  'Open asp.net./reset now.',
];

// DES-8 (rev-muynhokz-01357080; plan core-modules criterion 3): Unicode-aware lookbehind.
const DES8_REJECT = [
  'Go to éasp.net now.', // U+00E9 precomposed letter
  'Go to ñsocket.io now.', // U+00F1
  'Go to ١asp.net now.', // U+0661 Arabic-Indic digit one
];
// Additional rejects in the same class (a non-ASCII character glued to the token, which the brief baseline rejects):
const DES8_EXTRA_REJECT = [
  'Go to éasp.net now.', // decomposed e + U+0301 combining acute (\p{M})
  'Go to évb.net now.',
  'Go to ñado.net now.',
  'Go to ÄASP.NET now.', // upper-case Unicode letter before an upper-case token
  'Go to evil­asp.net now.', // soft hyphen (\p{Cf}) is dropped by IDNA mapping -> evilasp.net
  'Go to evil‍socket.io now.', // zero-width joiner (\p{Cf})
  'Go to aſp.net now.', // LATIN SMALL LETTER LONG S: must not be case-folded into the token "asp"
  'Go to ſocket.io now.',
];
const DES8_ACCEPT = [
  'See asp.net.” now.', // ” closing double quote after the sentence-final dot
  'See asp.net’ now.', // ’ closing single quote directly after the token
  'Customer wrote “ASP.NET” in the form.', // curly quotes around the token
  'Customer reports (Socket.io) errors.',
];

test('V2 accepts every accept vector (brief, ARCH-11, DES-3)', () => {
  for (const s of V2_ACCEPT) assert.equal(containsLinkOrEmail(s), false, 'V2 should accept: ' + s);
});
test('V2 rejects every reject vector (brief, ARCH-11, DES-3)', () => {
  for (const s of V2_REJECT) assert.equal(containsLinkOrEmail(s), true, 'V2 should reject: ' + s);
});
test('DES-8: a Unicode letter, mark or digit before a product token blocks the mask (reject)', () => {
  for (const s of DES8_REJECT) assert.equal(containsLinkOrEmail(s), true, 'V2 should reject: ' + s);
});
test('DES-8: further Unicode rejects (combining mark, format chars, long-s case folding)', () => {
  for (const s of DES8_EXTRA_REJECT) assert.equal(containsLinkOrEmail(s), true, 'V2 should reject: ' + JSON.stringify(s));
});
test('DES-8: curly closing quotes are accepted after a product token', () => {
  for (const s of DES8_ACCEPT) assert.equal(containsLinkOrEmail(s), false, 'V2 should accept: ' + s);
});
test('V2: the mask applies only to the bare-domain rule; the other five rules see the raw text', () => {
  assert.equal(containsLinkOrEmail('Use asp.net/reset now.'), true, 'host-path');
  assert.equal(containsLinkOrEmail('Open http://socket.io now.'), true, 'scheme');
  assert.equal(containsLinkOrEmail('Open www.asp.net now.'), true, 'www');
  assert.equal(containsLinkOrEmail('Mail a@asp.net now.'), true, 'email');
  assert.equal(containsLinkOrEmail('Write to admin at asp dot net now.'), true, 'obfuscated email');
});
test('V2 is stateless across calls (no lastIndex leakage from global regexes)', () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(containsLinkOrEmail('Customer reports ASP.NET errors after the update.'), false);
    assert.equal(containsLinkOrEmail('Go to example.com to reset.'), true);
  }
});
test('V2 treats non-strings as not containing a link (shape errors are V4)', () => {
  for (const v of [null, undefined, 3, {}]) assert.equal(containsLinkOrEmail(v), false);
});

// ---------------------------------------------------------------- V3 (brief + design)

test('V3 normaliseEnum: brief and design vectors', () => {
  assert.equal(normaliseEnum('Billing', CATEGORIES), 'billing');
  assert.equal(normaliseEnum('Feature_Request', CATEGORIES), 'feature_request');
  assert.equal(normaliseEnum('HIGH', URGENCIES), 'high');
  assert.equal(normaliseEnum(' HIGH ', URGENCIES), 'high');
  assert.equal(normaliseEnum('feature request', CATEGORIES), null);
  assert.equal(normaliseEnum('refunds', CATEGORIES), null);
  assert.equal(normaliseEnum(3, CATEGORIES), null);
  for (const v of [null, undefined, true, ['billing'], { v: 'billing' }, '']) assert.equal(normaliseEnum(v, CATEGORIES), null);
  for (const c of CATEGORIES) assert.equal(normaliseEnum(c, CATEGORIES), c);
});

// ---------------------------------------------------------------- validateTriage (V3+V4+V1+V2)

const GOOD = Object.freeze({
  category: 'billing', urgency: 'high',
  summary: 'Customer was charged twice for the March invoice.',
  suggestedReply: 'Thank you for contacting us. Could you share the invoice number so we can look into the duplicate charge?',
});

test('validateTriage accepts a valid object and returns the Triage in canonical key order', () => {
  const r = validateTriage({ ...GOOD });
  assert.deepStrictEqual(r, { ok: true, triage: { ...GOOD } });
  assert.deepEqual(Object.keys(r.triage), ['category', 'urgency', 'summary', 'suggestedReply']);
  const shuffled = validateTriage({ suggestedReply: GOOD.suggestedReply, summary: GOOD.summary, urgency: 'high', category: 'billing' });
  assert.deepEqual(Object.keys(shuffled.triage), ['category', 'urgency', 'summary', 'suggestedReply']);
});

test('validateTriage normalises enum case (V3, AC4 m)', () => {
  const r = validateTriage({ ...GOOD, category: 'Billing', urgency: 'HIGH' });
  assert.equal(r.ok, true);
  assert.equal(r.triage.category, 'billing');
  assert.equal(r.triage.urgency, 'high');
  assert.equal(validateTriage({ ...GOOD, category: ' Feature_Request ' }).triage.category, 'feature_request');
});

test('validateTriage error codes for AC4 j/k/l shaped outputs', () => {
  assert.deepStrictEqual(validateTriage({ ...GOOD, category: 'refunds' }), { ok: false, errors: ['category'] });
  assert.deepStrictEqual(validateTriage({ ...GOOD, urgency: 'critical' }), { ok: false, errors: ['urgency'] });
  assert.deepStrictEqual(validateTriage({ ...GOOD, suggestedReply: 'Please visit https://example.com for help.' }),
    { ok: false, errors: ['reply_v2'] });
  assert.deepStrictEqual(validateTriage({ ...GOOD, summary: 'Payment failed. Customer wants a refund.' }),
    { ok: false, errors: ['summary_v1'] });
  assert.deepStrictEqual(validateTriage({ ...GOOD, summary: 'Customer was told to go to example.com today.' }),
    { ok: false, errors: ['summary_v2'] });
});

test('validateTriage V4 shape: not a plain object gives keys', () => {
  for (const v of [null, undefined, 'x', 3, true, [], [GOOD]]) {
    assert.deepStrictEqual(validateTriage(v), { ok: false, errors: ['keys'] }, JSON.stringify(v));
  }
});

test('validateTriage V4 shape: missing or extra keys give keys', () => {
  const missing = { ...GOOD }; delete missing.suggestedReply;
  const r1 = validateTriage(missing);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.includes('keys'));
  const extra = validateTriage({ ...GOOD, confidence: 'high' });
  assert.deepStrictEqual(extra, { ok: false, errors: ['keys'] });
  const proto = validateTriage(JSON.parse('{"category":"billing","urgency":"high","summary":"A b.","suggestedReply":"Hi.","__proto__":{"x":1}}'));
  assert.deepStrictEqual(proto, { ok: false, errors: ['keys'] }, 'own __proto__ key from JSON.parse counts as an extra key');
});

test('validateTriage V4 types: every field must be a string', () => {
  const r = validateTriage({ ...GOOD, summary: 42 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('types'));
  const c = validateTriage({ ...GOOD, category: 3 });
  assert.deepStrictEqual(c, { ok: false, errors: ['types', 'category'] });
  const rep = validateTriage({ ...GOOD, suggestedReply: ['Hi.'] });
  assert.equal(rep.ok, false);
  assert.ok(rep.errors.includes('types'));
});

test('validateTriage V4 reply length: trimmed >= 1 and length <= 1200', () => {
  assert.deepStrictEqual(validateTriage({ ...GOOD, suggestedReply: '' }), { ok: false, errors: ['reply_length'] });
  assert.deepStrictEqual(validateTriage({ ...GOOD, suggestedReply: '   \n ' }), { ok: false, errors: ['reply_length'] });
  assert.equal(validateTriage({ ...GOOD, suggestedReply: 'x'.repeat(1200) }).ok, true);
  assert.deepStrictEqual(validateTriage({ ...GOOD, suggestedReply: 'x'.repeat(1201) }), { ok: false, errors: ['reply_length'] });
  assert.equal(validateTriage({ ...GOOD, suggestedReply: 'Hi' }).ok, true);
});

test('validateTriage returns every applicable error code in a fixed order', () => {
  const r = validateTriage({ category: 'refunds', urgency: 'urgent', summary: 'Two. Sentences at example.com.',
    suggestedReply: 'x'.repeat(1191) + ' www.a.com' }); // 1201 characters
  assert.deepStrictEqual(r, { ok: false, errors: ['category', 'urgency', 'summary_v1', 'summary_v2', 'reply_length', 'reply_v2'] });
});

test('validateTriage does not mutate its input and is deterministic', () => {
  const input = { ...GOOD, category: 'Billing' };
  const copy = { ...input };
  const a = validateTriage(input);
  const b = validateTriage(input);
  assert.deepStrictEqual(input, copy);
  assert.deepStrictEqual(a, b);
});

// ---------------------------------------------------------------- validateResponse (AC2, C3, D4)

const RESP_MODEL = Object.freeze({
  category: 'billing', urgency: 'high',
  summary: 'Customer was charged twice for the March invoice.',
  suggestedReply: 'Thank you for contacting us. Could you share the invoice number?',
  source: 'model', fallbackReason: null, injectionSuspected: false, model: 'claude-haiku-5-5',
});
const RESP_FALLBACK = Object.freeze({
  category: 'technical', urgency: 'medium',
  summary: 'Customer reports a medium-urgency technical issue.',
  suggestedReply: 'Thank you for reporting this. Could you tell us which version you are using?',
  source: 'fallback', fallbackReason: 'no_api_key', injectionSuspected: true, model: null,
});

test('validateResponse accepts valid model and fallback responses, every fallback reason, keys in any order', () => {
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL }), { ok: true, errors: [] });
  assert.deepStrictEqual(validateResponse({ ...RESP_FALLBACK }), { ok: true, errors: [] });
  for (const reason of FALLBACK_REASONS) {
    assert.deepStrictEqual(validateResponse({ ...RESP_FALLBACK, fallbackReason: reason }), { ok: true, errors: [] }, reason);
  }
  const reversed = Object.fromEntries(Object.entries(RESP_MODEL).reverse());
  assert.deepStrictEqual(validateResponse(reversed), { ok: true, errors: [] });
});

test('validateResponse: exactly 8 keys', () => {
  for (const v of [null, undefined, 'x', 3, []]) assert.deepStrictEqual(validateResponse(v), { ok: false, errors: ['keys'] });
  const seven = { ...RESP_MODEL }; delete seven.model;
  assert.ok(validateResponse(seven).errors.includes('keys'));
  assert.ok(validateResponse({ ...RESP_MODEL, extra: 1 }).errors.includes('keys'));
  assert.equal(validateResponse({ ...RESP_MODEL, extra: 1 }).ok, false);
});

test('validateResponse: strict lower-case enums, no normalisation', () => {
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, category: 'Billing' }), { ok: false, errors: ['category'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, urgency: 'HIGH' }), { ok: false, errors: ['urgency'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, urgency: ' high' }), { ok: false, errors: ['urgency'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, category: 'refunds' }), { ok: false, errors: ['category'] });
});

test('validateResponse: summary V1/V2 and reply length/V2', () => {
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, summary: 'Outage reported' }), { ok: false, errors: ['summary_v1'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, summary: 'See www.example.com.' }), { ok: false, errors: ['summary_v2'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, suggestedReply: ' ' }), { ok: false, errors: ['reply_length'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, suggestedReply: 'x'.repeat(1201) }), { ok: false, errors: ['reply_length'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, suggestedReply: 'Mail support@example.com.' }), { ok: false, errors: ['reply_v2'] });
  assert.ok(validateResponse({ ...RESP_MODEL, summary: 7 }).errors.includes('types'));
});

test('validateResponse: source and fallbackReason consistency (fallbackReason null iff source = model)', () => {
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, source: 'ai' }), { ok: false, errors: ['source'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, fallbackReason: 'timeout' }), { ok: false, errors: ['fallbackReason'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_FALLBACK, fallbackReason: null }), { ok: false, errors: ['fallbackReason'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_FALLBACK, fallbackReason: 'provider_threw' }), { ok: false, errors: ['fallbackReason'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_FALLBACK, fallbackReason: 'Timeout' }), { ok: false, errors: ['fallbackReason'] });
});

test('validateResponse: model consistent with source (string iff model, null iff fallback)', () => {
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, model: null }), { ok: false, errors: ['model'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, model: '' }), { ok: false, errors: ['model'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, model: 5 }), { ok: false, errors: ['model'] });
  assert.deepStrictEqual(validateResponse({ ...RESP_FALLBACK, model: 'claude-haiku-5-5' }), { ok: false, errors: ['model'] });
});

test('validateResponse: injectionSuspected must be a boolean', () => {
  for (const v of ['false', 0, 1, null, undefined]) {
    assert.deepStrictEqual(validateResponse({ ...RESP_MODEL, injectionSuspected: v }), { ok: false, errors: ['injectionSuspected'] }, String(v));
  }
});

test('validateResponse collects several errors at once', () => {
  const r = validateResponse({ ...RESP_FALLBACK, category: 'Technical', fallbackReason: null, injectionSuspected: 'yes', model: 'x' });
  assert.deepStrictEqual(r, { ok: false, errors: ['category', 'fallbackReason', 'injectionSuspected', 'model'] });
});

// ---------------------------------------------------------------- purity (C6: pure CommonJS)

test('schema.js is pure CommonJS: strict mode, no requires, no I/O, clock or randomness', () => {
  const src = fs.readFileSync(SCHEMA_PATH, 'utf8');
  assert.match(src, /^'use strict';/);
  assert.match(src, /module\.exports\s*=/);
  assert.doesNotMatch(src, /\bimport\s|export\s/);
  assert.doesNotMatch(src, /\brequire\s*\(/, 'schema.js has no dependencies');
  assert.doesNotMatch(src, /\b(process|Date|Math\.random|fetch|setTimeout|console|globalThis)\b/);
});
