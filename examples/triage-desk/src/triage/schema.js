'use strict';
// Triage output contract: enums, the restricted JSON schema sent to the model (spec D2, NFR2), the AC9 schema
// keyword walker and the output validators V1-V4 (spec D4). Pure: no I/O, no clock, no randomness.
// Reference implementation and binding vectors: .eccode/artifacts/design/design-vectors.js (oneSentence, hasLink,
// norm, schemaOk), refined here by review finding DES-8 (Unicode-aware product-token mask).

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const CATEGORIES = Object.freeze(['billing', 'technical', 'account', 'feature_request', 'other']);
const URGENCIES = Object.freeze(['low', 'medium', 'high']);
const FALLBACK_REASONS = Object.freeze(['no_api_key', 'model_error', 'timeout', 'refusal', 'truncated', 'invalid_output']);

// Exactly the object in spec D2. Only type, properties, required, enum and additionalProperties are used; every
// length rule is enforced by validateTriage (V1, V4), never by the schema (unsupported keywords cause a 400).
const OUTPUT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['category', 'urgency', 'summary', 'suggestedReply'],
  properties: {
    category: { type: 'string', enum: [...CATEGORIES] },
    urgency: { type: 'string', enum: [...URGENCIES] },
    summary: { type: 'string' },
    suggestedReply: { type: 'string' },
  },
});

const TRIAGE_KEYS = Object.freeze(['category', 'urgency', 'summary', 'suggestedReply']);
const RESPONSE_KEYS = Object.freeze([...TRIAGE_KEYS, 'source', 'fallbackReason', 'injectionSuspected', 'model']);
const MAX_SUMMARY = 200;
const MAX_REPLY = 1200;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------- AC9 schema keyword walker

const ALLOWED_SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'enum', 'additionalProperties']);

/**
 * Recursive walk: false on any key outside the allowlist, on any `type: "object"` node whose additionalProperties
 * is not exactly false, and on any node or `properties` map that is not a plain object.
 * @returns {boolean}
 */
function checkSchemaKeywords(schema) {
  if (!isPlainObject(schema)) return false;
  for (const key of Object.keys(schema)) if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) return false;
  if (schema.type === 'object' && schema.additionalProperties !== false) return false;
  if (Object.hasOwn(schema, 'properties')) {
    if (!isPlainObject(schema.properties)) return false;
    for (const child of Object.values(schema.properties)) if (!checkSchemaKeywords(child)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- V1 single sentence

const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'inc', 'ltd', 'no', 'approx',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);

/** V1: trimmed, 1-200 characters, no CR/LF, ends with . ! or ?, no internal sentence boundary. */
function isSingleSentence(s) {
  if (typeof s !== 'string') return false;
  if (s !== s.trim() || s.length < 1 || s.length > MAX_SUMMARY) return false;
  if (/[\r\n]/.test(s)) return false;
  if (!/[.!?]$/.test(s)) return false;
  const boundary = /([A-Za-z.]*)[.!?]+["')\]]?\s+(?=[A-Z0-9])/g;
  let m;
  while ((m = boundary.exec(s)) !== null) {
    const word = m[1].toLowerCase().replace(/\.$/, '');
    if (!ABBREVIATIONS.has(word)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- V2 no links or email addresses

const TLD = 'com|net|org|io|co|ai|app|dev|info|biz|xyz|me|ly|gl|us|uk|de|eu|ru|cn|in|fr';

// ARCH-11 / DES-3 product-token mask, made Unicode-aware for DES-8:
// - Lookbehind: the token is not masked when it follows a letter, number or combining mark in any script
//   (\p{L}\p{N}\p{M}, e.g. "éasp.net", "١asp.net"), an invisible format character (\p{Cf}: soft hyphen,
//   zero-width joiner; IDNA mapping drops these, so "evil<SHY>asp.net" is the host "evilasp.net"), "_", or one of
//   . @ / : - (a host, email or URL continuation).
// - Tokens are matched case-insensitively for ASCII only, through explicit [xX] classes instead of the `i` flag:
//   with the `u` flag, `i` applies Unicode case folding, so U+017F LONG S would match "s" and "aſp.net" would be
//   masked, although the unmasked bare-domain rule rejects it.
// - Lookahead (DES-3): end of text, whitespace, , ; ! ? a closing quote or bracket, or a single '.' that ends the
//   text or precedes whitespace or a closing quote or bracket. DES-8 adds the curly closing quotes ’ and ”.
const PRODUCT_TOKENS = new RegExp(
  '(?<![\\p{L}\\p{N}\\p{M}\\p{Cf}_.@/:-])' +
  '(?:[aA][sS][pP]\\.[nN][eE][tT]|[aA][dD][oO]\\.[nN][eE][tT]|[vV][bB]\\.[nN][eE][tT]|[sS][oO][cC][kK][eE][tT]\\.[iI][oO])' +
  '(?=$|[\\s,;!?"\'’”)\\]]|\\.(?:$|[\\s"\'’”)\\]]))',
  'gu');

// The six brief rules, unchanged. Only the bare-domain rule sees the masked string. None is global, so test() is
// stateless.
const V2_RULES = Object.freeze([
  { id: 'scheme', re: /\b[a-z][a-z0-9+.-]*:\/\//i, masked: false },
  { id: 'www', re: /\bwww\./i, masked: false },
  { id: 'bare-domain', re: new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLD})\\b`, 'i'), masked: true },
  { id: 'host-path', re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S/i, masked: false },
  { id: 'email', re: /[^\s@]+@[^\s@]+\.[^\s@]+/, masked: false },
  { id: 'obfuscated-email', re: /\b[\w.+-]+\s*(?:\(at\)|\[at\]|\sat\s)\s*[\w-]+\s*(?:\(dot\)|\[dot\]|\sdot\s)\s*[a-z]{2,}\b/i, masked: false },
]);

/** V2: true when the string contains a URL, web address, bare domain or (obfuscated) email address (reject). */
function containsLinkOrEmail(s) {
  if (typeof s !== 'string') return false;
  const masked = s.replace(PRODUCT_TOKENS, 'product');
  return V2_RULES.some((rule) => rule.re.test(rule.masked ? masked : s));
}

// ---------------------------------------------------------------- V3 enum case policy

/** V3: trim + lower-case, then an exact enum match. Non-strings and non-members give null. */
function normaliseEnum(value, allowed) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return allowed.includes(key) ? key : null;
}

// ---------------------------------------------------------------- V4 + combined validators

function hasExactKeys(obj, keys) {
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(obj, k));
}

/** Text-field checks shared by validateTriage and validateResponse. Runs only on string values (types covers the rest). */
function textFieldErrors(summary, reply) {
  const errors = [];
  if (typeof summary === 'string') {
    if (!isSingleSentence(summary)) errors.push('summary_v1');
    if (containsLinkOrEmail(summary)) errors.push('summary_v2');
  }
  if (typeof reply === 'string') {
    if (reply.trim().length < 1 || reply.length > MAX_REPLY) errors.push('reply_length');
    if (containsLinkOrEmail(reply)) errors.push('reply_v2');
  }
  return errors;
}

/**
 * V3 + V4 + V1 + V2 on a parsed model object. Returns every applicable error code, in this fixed order:
 * keys, types, category, urgency, summary_v1, summary_v2, reply_length, reply_v2.
 * @returns {{ok:true, triage:{category:string, urgency:string, summary:string, suggestedReply:string}}
 *         | {ok:false, errors:string[]}}
 */
function validateTriage(obj) {
  if (!isPlainObject(obj)) return { ok: false, errors: ['keys'] };
  const errors = [];
  if (!hasExactKeys(obj, TRIAGE_KEYS)) errors.push('keys');
  if (!TRIAGE_KEYS.every((k) => typeof obj[k] === 'string')) errors.push('types');
  const category = normaliseEnum(obj.category, CATEGORIES);
  const urgency = normaliseEnum(obj.urgency, URGENCIES);
  if (category === null) errors.push('category');
  if (urgency === null) errors.push('urgency');
  errors.push(...textFieldErrors(obj.summary, obj.suggestedReply));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, triage: { category, urgency, summary: obj.summary, suggestedReply: obj.suggestedReply } };
}

/**
 * Full AC2 check of a TriageResponse (spec C3): exactly 8 keys in any order, strict lower-case enums (no
 * normalisation), V1/V2 on summary, length and V2 on suggestedReply, and source/fallbackReason/model consistency.
 * Error codes, in this fixed order: keys, types, category, urgency, summary_v1, summary_v2, reply_length,
 * reply_v2, source, fallbackReason, injectionSuspected, model.
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateResponse(resp) {
  if (!isPlainObject(resp)) return { ok: false, errors: ['keys'] };
  const errors = [];
  if (!hasExactKeys(resp, RESPONSE_KEYS)) errors.push('keys');
  if (!TRIAGE_KEYS.every((k) => typeof resp[k] === 'string')) errors.push('types');
  if (!CATEGORIES.includes(resp.category)) errors.push('category');
  if (!URGENCIES.includes(resp.urgency)) errors.push('urgency');
  errors.push(...textFieldErrors(resp.summary, resp.suggestedReply));

  const { source, fallbackReason, model } = resp;
  const sourceOk = source === 'model' || source === 'fallback';
  if (!sourceOk) errors.push('source');
  const reasonValueOk = fallbackReason === null || FALLBACK_REASONS.includes(fallbackReason);
  const reasonConsistent = !sourceOk || (source === 'model' ? fallbackReason === null : fallbackReason !== null);
  if (!reasonValueOk || !reasonConsistent) errors.push('fallbackReason');
  if (typeof resp.injectionSuspected !== 'boolean') errors.push('injectionSuspected');
  const modelValueOk = model === null || (typeof model === 'string' && model.length > 0);
  const modelConsistent = !sourceOk || (source === 'model' ? model !== null : model === null);
  if (!modelValueOk || !modelConsistent) errors.push('model');

  return { ok: errors.length === 0, errors };
}

module.exports = {
  CATEGORIES, URGENCIES, FALLBACK_REASONS, OUTPUT_SCHEMA,
  checkSchemaKeywords, isSingleSentence, containsLinkOrEmail, normaliseEnum, validateTriage, validateResponse,
};
