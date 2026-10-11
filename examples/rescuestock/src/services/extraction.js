// Extraction service (spec: Customer routes image / extract, AI / LLM Design, Security T9 T12 T16, Retention).
//
//   createAiRuntime(...)              the provider (fake whenever RS_TEST_OFFLINE=1) and the model gate, built once per app
//   detectImageMime(bytes)            PNG / JPEG / WebP by magic bytes, else null
//   readUploadBody(req, {...})        streams an upload with a byte cap (413) and a deadline (FU-2)
//   saveImage(ctx, user, id, {...})   POST /api/requests/:id/image: random 128-bit name, .tmp then rename, mode 0600
//   readStoredImage(ctx, user, id)    GET  /api/requests/:id/image
//   extractRequest(ctx, user, id)     POST /api/requests/:id/extract: gate -> provider (outside any transaction) -> normalise
//   normaliseExtraction(...)          post-validation rules: ranges, grounding, image wording, non-USD budget
//   takeModelFault(db)                reads and decrements the fake_model:* row of fault_flags (the fake never touches tables)
//
// The model's answer is a proposal and data only. It is stored in extractions.fields_json (FieldValue per core field, key
// order of the spec, with the reserved key `__meta` holding addressedToAssistant) and shown to the buyer; nothing in it can
// name a permission, an amount, a supplier or a plan version, and the buyer confirms every field (SEC-8).
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isoFromMs } from '../clock.js';
import { createFakeProvider, FAKE_FAULTS } from '../ai/fake.js';
import { createGate, gateLimitsFromConfig, microUsdOfUsage } from '../ai/gate.js';
import { PROMPT_VERSION } from '../ai/prompt.js';
import { ProviderError, assertExtractionProvider, selectProvider, toDegraded } from '../ai/provider.js';
import {
  FIELD_NAMES as WIRE_FIELDS, budgetUsdToCents, normalizeForCompare, renderQuestions, unknownExtraction, validateExtraction,
} from '../ai/schema.js';
import { localToUtcMs, localDay } from '../domain/time.js';
import { IMAGE_BODY_LIMIT } from '../http/body.js';
import { AppError, adoptAppError } from '../http/envelope.js';
import { UPLOAD_REQUEST_TIMEOUT_MS } from '../http/server.js';
import { recordAudit } from './audit.js';
import { findOwnedRequest, renderExtraction } from './view.js';

export const MAX_IMAGE_BYTES = IMAGE_BODY_LIMIT;
export const IMAGE_EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });
export const IMAGE_FILE_PATTERN = /^[0-9a-f]{32}\.(?:png|jpg|webp)$/;
export const TMP_DIR_NAME = '.tmp';
export const MAX_WORDING_CHARS = 80;
export const DEFAULT_UPLOAD_DEADLINE_MS = UPLOAD_REQUEST_TIMEOUT_MS;
export const FAULT_PREFIX = 'fake_model:';

// The wire name of a field (budgetUsd) and the name the buyer confirms (budgetCents).
const STORED_NAME = Object.freeze({
  productType: 'productType', cupQuantity: 'cupQuantity', lidQuantity: 'lidQuantity', capacityMl: 'capacityMl', diameterMm: 'diameterMm',
  material: 'material', deadline: 'deadline', budgetUsd: 'budgetCents', maxPickups: 'maxPickups',
});
const RANGES = Object.freeze({
  cupQuantity: [1, 100000], lidQuantity: [1, 100000], capacityMl: [30, 2000], diameterMm: [40, 150], maxPickups: [1, 5], budgetCents: [100, 100000000],
});
const NON_USD = /\b(?:jod|jd|eur|euros?|gbp|sar|aed|kwd|egp|dinars?|dirhams?|riyals?|pounds?)\b|دينار|دنانير|درهم|ريال|يورو|جنيه|[€£¥]/iu;

const SQL_LIVE_IMAGE = 'SELECT id, file_name, mime_detected, bytes, sha256, created_at FROM images WHERE request_id = ?';

// ------------------------------------------------------------------ files

export function uploadRoot(config) {
  return resolve(config.uploadDir);
}

// data/uploads/<file_name>.<png|jpg|webp>; the name is server generated (32 hex) and re-checked here.
export function imageFilePath(config, fileName, mime) {
  const ext = Object.hasOwn(IMAGE_EXTENSIONS, mime) ? IMAGE_EXTENSIONS[mime] : null;
  if (typeof fileName !== 'string' || !/^[0-9a-f]{32}$/.test(fileName) || ext === null) throw new RangeError('not a stored image name');
  return join(uploadRoot(config), `${fileName}.${ext}`);
}

// Removes a file and ignores "it is already gone"; any other failure is reported to the caller as false.
export async function unlinkQuiet(path) {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    return err?.code === 'ENOENT';
  }
}

export async function removeImageFiles(config, images) {
  let failed = 0;
  for (const image of images) {
    let path;
    try {
      path = imageFilePath(config, image.file_name, image.mime_detected);
    } catch {
      failed += 1;
      continue;
    }
    if (!(await unlinkQuiet(path))) failed += 1;
  }
  return failed;
}

// PNG 89 50 4E 47 0D 0A 1A 0A, JPEG FF D8 FF, WebP "RIFF" xxxx "WEBP" (T12). The detected type must equal the declared one.
export function detectImageMime(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return null;
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

// "image/png; charset=x" -> "image/png" (lower case), anything else -> null.
export function declaredImageMime(header) {
  if (typeof header !== 'string') return null;
  const media = header.split(';')[0].trim().toLowerCase();
  return Object.hasOwn(IMAGE_EXTENSIONS, media) ? media : null;
}

// ------------------------------------------------------------------ the upload body

// After a refusal the rest of an honest oversize body (up to the cap plus this slack) is read and discarded so the client can
// still read the 413; a body that is clearly hostile is cut off (the connection is closed).
const DRAIN_SLACK = 1024 * 1024;
const DRAIN_LIMIT = MAX_IMAGE_BYTES + DRAIN_SLACK;

function drain(req) {
  let seen = 0;
  req.on('data', (chunk) => {
    seen += chunk.length;
    if (seen > DRAIN_LIMIT) req.destroy();
  });
  req.on('error', () => {});
  req.resume();
}

// Declared Content-Length: required (400 BAD_REQUEST when absent, chunked or malformed), above the cap -> 413 before any byte is read.
export function declaredUploadLength(req, limit = MAX_IMAGE_BYTES) {
  const raw = req.headers['content-length'];
  if (raw === undefined || req.headers['transfer-encoding'] !== undefined || !/^\d{1,15}$/.test(raw)) {
    throw new AppError(400, 'BAD_REQUEST', { headers: { Connection: 'close' } });
  }
  const length = Number(raw);
  if (length > limit) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', { headers: length > limit + DRAIN_SLACK ? { Connection: 'close' } : undefined });
  }
  return length;
}

/**
 * Reads the upload with the cap enforced while streaming (413) and a deadline for the whole body (FU-2, T12): the spec's
 * allowance for an upload is 60 s (UPLOAD_REQUEST_TIMEOUT_MS). A body that is not complete by then ends as 400 BAD_REQUEST
 * (details.reason = UPLOAD_TIMEOUT) and the connection is closed. Nothing is written to disk by this function.
 */
export function readUploadBody(req, { limit = MAX_IMAGE_BYTES, deadlineMs = DEFAULT_UPLOAD_DEADLINE_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    let timer = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onError);
      fn(value);
    };
    function onData(chunk) {
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        finish(reject, new AppError(413, 'PAYLOAD_TOO_LARGE'));
        drain(req);
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      finish(resolvePromise, Buffer.concat(chunks, total));
    }
    function onError() {
      chunks.length = 0;
      finish(reject, new AppError(400, 'BAD_REQUEST'));
    }
    timer = setTimeout(() => {
      chunks.length = 0;
      finish(reject, new AppError(400, 'BAD_REQUEST', { details: { reason: 'UPLOAD_TIMEOUT' }, headers: { Connection: 'close' } }));
      drain(req);
    }, deadlineMs);
    timer.unref?.();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onError);
  });
}

// ------------------------------------------------------------------ saving and serving an image

export async function saveImage(ctx, user, requestId, { mime, bytes }) {
  const { db, clock, config } = ctx;
  const ext = IMAGE_EXTENSIONS[mime];
  const root = uploadRoot(config);
  const tmpDir = join(root, TMP_DIR_NAME);
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const name = randomBytes(16).toString('hex'); // 128 bits
  const tmpPath = join(tmpDir, name);
  const finalPath = join(root, `${name}.${ext}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  let placed = false;
  try {
    await writeFile(tmpPath, bytes, { flag: 'wx', mode: 0o600 });
    await rename(tmpPath, finalPath);
    placed = true;
    const outcome = db.tx(() => {
      findOwnedRequest(db, user.id, requestId); // the request may have been deleted while the body streamed
      const old = db.prepare(SQL_LIVE_IMAGE).get(requestId) ?? null;
      if (old) db.prepare('DELETE FROM images WHERE id = ?').run(old.id);
      const now = isoFromMs(clock.now());
      const id = Number(
        db
          .prepare('INSERT INTO images (request_id, file_name, mime_detected, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(requestId, name, mime, bytes.length, sha256, now).lastInsertRowid,
      );
      recordAudit(db, clock, {
        actorUserId: user.id, actorRole: user.role, action: 'image.upload', entityType: 'image', entityId: id, outcome: 'ok',
        detail: { requestId, bytes: bytes.length, replaced: old !== null }, requestId: ctx.requestId,
      });
      return { id, old };
    });
    if (outcome.old) await removeImageFiles(config, [outcome.old]);
    return { image: { id: outcome.id, mime, bytes: bytes.length, sha256 } };
  } catch (err) {
    await unlinkQuiet(tmpPath);
    if (placed) await unlinkQuiet(finalPath);
    throw err;
  }
}

// GET /api/requests/:id/image: { mime, bytes: Buffer } or throws 404 (no image, or the file is gone).
export async function readStoredImage(ctx, user, requestId) {
  const { db, config } = ctx;
  findOwnedRequest(db, user.id, requestId);
  const row = db.prepare(SQL_LIVE_IMAGE).get(requestId);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  try {
    return { mime: row.mime_detected, bytes: await readFile(imageFilePath(config, row.file_name, row.mime_detected)) };
  } catch (err) {
    if (err?.code === 'ENOENT') throw new AppError(404, 'NOT_FOUND');
    throw err;
  }
}

// ------------------------------------------------------------------ provider and gate

// The fake's faults. A fault_flags row `fake_model:<fault>` with `remaining` N affects the next N calls (NULL until cleared);
// this function reads and decrements it so the adapter never has to touch a service table. Returns the fault or null.
export function takeModelFault(db) {
  return db.tx(() => {
    const rows = db.prepare("SELECT name, remaining FROM fault_flags WHERE name GLOB 'fake_model:*' ORDER BY created_at, name").all();
    for (const row of rows) {
      const fault = row.name.slice(FAULT_PREFIX.length);
      if (!FAKE_FAULTS.includes(fault)) continue;
      if (row.remaining !== null && row.remaining <= 0) {
        db.prepare('DELETE FROM fault_flags WHERE name = ?').run(row.name);
        continue;
      }
      if (row.remaining !== null) {
        if (row.remaining <= 1) db.prepare('DELETE FROM fault_flags WHERE name = ?').run(row.name);
        else db.prepare('UPDATE fault_flags SET remaining = remaining - 1 WHERE name = ?').run(row.name);
      }
      return fault;
    }
    return null;
  });
}

/**
 * createAiRuntime({ db, clock, config, provider?, factories?, imageMap?, imageMapPath? }) -> { provider, selection, gate }
 *   provider    an ExtractionProvider to use as is (tests)
 *   factories   { cli?: () => provider | null, anthropic?: () => provider | null } for selectProvider; the fake is built here
 *   imageMap    the fake's sha256 -> canned output map (tests inject it; default test/fixtures/extraction/fake-image-map.json)
 * With RS_TEST_OFFLINE=1 (config.testOffline) the provider is always the fake (selectProvider).
 */
export function createAiRuntime({ db, clock, config, provider = null, factories = {}, imageMap, imageMapPath }) {
  const makeFake = () =>
    createFakeProvider({ costMicroUsd: config.fakeModelCostMicroUsd ?? 0, imageMap, imageMapPath, faults: () => takeModelFault(db), clock });
  const selection = provider
    ? { provider: assertExtractionProvider(provider), requested: provider.id, source: provider.id, fellBack: false, reason: null }
    : selectProvider(config, { fake: makeFake, cli: factories.cli, anthropic: factories.anthropic });
  const gate = createGate({ db, clock, limits: gateLimitsFromConfig(config) });
  return Object.freeze({ provider: selection.provider, selection, gate });
}

// Calls the provider once with a watchdog: a provider that ignores its AbortSignal still ends at RS_MODEL_TIMEOUT_MS, and the
// call is then charged at the cap (a call that timed out may still have been billed).
async function callProvider(provider, input, { timeoutMs, capMicroUsd }) {
  const controller = new AbortController();
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError('PROVIDER_TIMEOUT', { usage: { costMicroUsd: capMicroUsd } }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.extract({ ...input, signal: controller.signal }), watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ post-validation normalisation (SEC-7)

const DIGIT = '[\\d٠-٩۰-۹]';
const URL_SCHEME = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/gu;
const URL_WWW = /\bwww\.\S+/giu;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/gu;
const PHONE_RUN = new RegExp(`(?:\\+|00)?${DIGIT}(?:[\\d٠-٩۰-۹\\s().-]{5,}${DIGIT})`, 'gu');

const digitCount = (text) => (text.match(new RegExp(DIGIT, 'gu')) ?? []).length;
const takeCodePoints = (text, n) => Array.from(text).slice(0, n).join('');

/**
 * Wording read from a photo (SEC-7): URLs, e-mail addresses and phone-number runs (7 or more digits with separators) are
 * removed, the rest is cut to 80 characters, and a result with no letter or digit left is null.
 */
export function sanitizeImageWording(text) {
  if (typeof text !== 'string') return null;
  let t = text.normalize('NFC');
  t = t.replace(URL_SCHEME, ' ').replace(URL_WWW, ' ').replace(EMAIL, ' ');
  t = t.replace(PHONE_RUN, (run) => (digitCount(run) >= 7 ? ' ' : run));
  t = takeCodePoints(t.replace(/\s+/gu, ' ').trim(), MAX_WORDING_CHARS).trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : null;
}

const unknownValue = () => ({ value: null, status: 'unknown', provenance: 'none', originalWording: null });

function inRange(name, value) {
  const range = Object.hasOwn(RANGES, name) ? RANGES[name] : null;
  return range === null || (Number.isSafeInteger(value) && value >= range[0] && value <= range[1]);
}

// A deadline "HH:MM" gets the request's Asia/Amman day; a full local date-time must be a real time in the zone.
function localDeadline(value, requestDay) {
  const full = /^\d{2}:\d{2}$/.test(value) ? `${requestDay}T${value}` : value;
  try {
    localToUtcMs(full);
  } catch {
    return null;
  }
  return full;
}

// A user_text field must be quoted from the request text, whatever its kind. This runs d1's validateExtraction with the request
// text on ONE field of an otherwise all-unknown output, so the field is downgraded to unknown and the rest of the answer is
// kept. d1's rules decide: the quote has to occur in the text (NOT_QUOTED, every field kind), and a numeric value has to occur
// in its own quote as digits of either script or as a number word, with the quote aligned to whole numbers in the text
// (NUMBER_NOT_IN_INPUT: a quote with no digits grounds nothing, and "250" is not grounded by "2500"; TR-D-1, TR-D-12, TR-D-14).
// This is the single place that checks the quote, so removing it is seen by the non-numeric tests as well.
function quoteGrounded(wire, field, text) {
  const probe = unknownExtraction();
  probe.fields[wire] = { value: field.value, provenance: 'user_text', originalWording: field.originalWording };
  return validateExtraction(probe, { text }).ok === true;
}

// Provenance "image" is a claim that the value is legibly printed on the package, so the server accepts it only for what a
// package can carry: the product type, the material, the capacity and the diameter. The quantities, the pickup limit, the
// deadline and the budget are never on a photo; an image claim for them is downgraded to unknown and asked (TR-D-11,
// dec-mv35aank-0169ec16), whatever the photo is and whatever an injected label says. Anything not listed here is refused.
export const IMAGE_PROVENANCE_FIELDS = Object.freeze(['productType', 'material', 'capacityMl', 'diameterMm']);

// A deadline quoted from the text must carry its time as written (TR-D-13). The wire form is HH:MM or YYYY-MM-DDTHH:MM, so the
// time is the last five characters. In the text it is "H:MM" or "HH:MM" (digits of either script, folded by normalizeForCompare)
// or an hour with am/pm ("11 am", "11:30 p.m."). A time counts only when it is aligned like a number (not part of a longer
// digit run such as 111:30, nor of 11:305 or 1.11:30) and when it lies inside an occurrence of the quote in the text. "for the
// weekend" carries no time, so any deadline claimed from it is unknown. This is implemented here, not in d1's validator, which
// treats the deadline as a plain string. The date part of a full date-time is not matched (a relative "tomorrow" cannot be
// matched without a calendar); the buyer confirms it.
const CLOCK_TOKEN = /(?<![\d.,:])(\d{1,2}):([0-5]\d)(?!\d|[.,:]\d)/gu;
const MERIDIEM_TOKEN = /(?<![\d.,:])(\d{1,2})(?::([0-5]\d))?\s?([ap])\.?m\.?(?![\p{L}\d])/giu;

function timesInText(textNorm) {
  const found = [];
  for (const m of textNorm.matchAll(MERIDIEM_TOKEN)) {
    const hour12 = Number(m[1]);
    if (hour12 < 1 || hour12 > 12) continue;
    const hour = (hour12 % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
    found.push({ start: m.index, end: m.index + m[0].length, hhmm: `${String(hour).padStart(2, '0')}:${m[2] ?? '00'}` });
  }
  const meridiem = found.slice();
  for (const m of textNorm.matchAll(CLOCK_TOKEN)) {
    const hour = Number(m[1]);
    const inside = meridiem.some((t) => m.index >= t.start && m.index < t.end); // "12:15 a.m." is read once, as 00:15
    if (hour <= 23 && !inside) found.push({ start: m.index, end: m.index + m[0].length, hhmm: `${String(hour).padStart(2, '0')}:${m[2]}` });
  }
  return found;
}

function deadlineTimeInQuote(value, quote, textNorm) {
  if (typeof value !== 'string' || quote === '') return false;
  const wanted = value.slice(-5);
  const times = timesInText(textNorm).filter((t) => t.hhmm === wanted);
  for (let at = textNorm.indexOf(quote); at !== -1; at = textNorm.indexOf(quote, at + 1)) {
    if (times.some((t) => t.start >= at && t.end <= at + quote.length)) return true;
  }
  return false;
}

/**
 * normaliseExtraction(output, { text, requestDay, hasImage }) -> { fields, questions, addressedToAssistant, downgraded }
 * `output` is a validated ExtractionOutput. Each rule downgrades ONE field to unknown, adds its question, and never rejects
 * the whole output (spec: Post-validation normalisation):
 *   ranges (quantities 1-100000, capacity 30-2000 ml, diameter 40-150 mm, pickups 1-5, budget 1-1,000,000 USD);
 *   grounding (a user_text quote must be a substring of the request text after NFC, whitespace and digit folding, for every field;
 *     a number must be in its own quote, aligned to whole numbers; a deadline's time must be in its quote);
 *   image provenance only for productType, material, capacityMl and diameterMm (IMAGE_PROVENANCE_FIELDS);
 *   image provenance without an image; a currency other than USD in the wording (budget unknown, "state it in US dollars");
 *   image wording stripped of URLs, e-mail addresses and phone runs and cut to 80 characters.
 * `fields` is keyed by the confirmed names (budgetUsd becomes budgetCents); `questions` is Question[] from server templates.
 */
export function normaliseExtraction(output, { text, requestDay, hasImage }) {
  const textNorm = normalizeForCompare(text);
  const fields = {};
  const downgraded = [];
  for (const wire of WIRE_FIELDS) {
    const name = STORED_NAME[wire];
    const f = output.fields[wire];
    fields[name] = unknownValue();
    if (f.provenance === 'none' || f.value === null) continue;

    let value = f.value;
    let wording = null;
    let ok = true;
    if (f.provenance === 'user_text') {
      ok = quoteGrounded(wire, f, text); // in the text; a number in its own quote, aligned to whole numbers (TR-D-1, TR-D-12, TR-D-14)
      if (ok && wire === 'deadline') ok = deadlineTimeInQuote(value, normalizeForCompare(f.originalWording), textNorm); // TR-D-13
      wording = ok ? takeCodePoints(f.originalWording.replace(/\s+/gu, ' ').trim(), MAX_WORDING_CHARS) : null;
    } else if (f.provenance === 'image') {
      ok = hasImage === true && IMAGE_PROVENANCE_FIELDS.includes(wire); // TR-D-11: a package shows no quantity, limit, deadline or budget
      wording = ok ? sanitizeImageWording(f.originalWording) : null;
    } else {
      ok = false;
    }

    if (ok && wire === 'budgetUsd') {
      value = budgetUsdToCents(value);
      ok = value !== null && NON_USD.test(typeof f.originalWording === 'string' ? f.originalWording : '') === false;
    }
    if (ok && wire === 'deadline') {
      value = localDeadline(value, requestDay);
      ok = value !== null;
    }
    if (ok && !inRange(name, value)) ok = false;

    if (ok) fields[name] = { value, status: 'known', provenance: f.provenance, originalWording: wording };
    else downgraded.push(wire);
  }

  const asked = new Set([...output.questions, ...downgraded]);
  const stillUnknown = [...asked].filter((wire) => fields[STORED_NAME[wire]].status === 'unknown');
  return {
    fields,
    questions: renderQuestions(stillUnknown),
    addressedToAssistant: output.addressedToAssistant === true,
    downgraded,
  };
}

function degradedFields() {
  const out = {};
  for (const wire of WIRE_FIELDS) out[STORED_NAME[wire]] = unknownValue();
  return out;
}

// ------------------------------------------------------------------ storing a row

function costOf(usage) {
  try {
    return microUsdOfUsage(usage);
  } catch {
    return 0;
  }
}

// One extraction row (and the request's intake status, and an audit event) in ONE transaction. The provider call is over by now.
// A degraded row replaces a degraded row that is already the newest, so a loop of refused calls cannot grow the table.
function storeExtraction(ctx, user, request, row) {
  const { db, clock } = ctx;
  const now = isoFromMs(clock.now());
  const meta = { addressedToAssistant: row.addressedToAssistant === true };
  return db.tx(() => {
    findOwnedRequest(db, user.id, request.id); // deleted while the provider call was running -> 404, nothing stored
    if (row.degraded) {
      db.prepare(
        'DELETE FROM extractions WHERE degraded = 1 AND id = (SELECT MAX(id) FROM extractions WHERE request_id = ?) AND request_id = ?',
      ).run(request.id, request.id);
    }
    const id = Number(
      db
        .prepare(
          'INSERT INTO extractions (request_id, provider, model, prompt_version, schema_ok, error_code, degraded, simulated, latency_ms, ' +
            'cost_micro_usd, fields_json, questions_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          request.id, row.provider, row.model ?? null, PROMPT_VERSION, row.schemaOk ? 1 : 0, row.errorCode ?? null, row.degraded ? 1 : 0,
          row.simulated ? 1 : 0, Number.isSafeInteger(row.latencyMs) ? row.latencyMs : null, row.costMicroUsd, JSON.stringify({ ...row.fields, __meta: meta }),
          JSON.stringify(row.questions), now,
        ).lastInsertRowid,
    );
    if (!row.degraded) db.prepare("UPDATE rescue_requests SET intake_status = 'extracted' WHERE id = ? AND intake_status = 'draft'").run(request.id);
    recordAudit(db, clock, {
      actorUserId: user.id, actorRole: user.role, action: 'extraction.run', entityType: 'request', entityId: request.id, outcome: row.degraded ? 'failed' : 'ok',
      detail: { extractionId: id, provider: row.provider, degraded: row.degraded, schemaOk: row.schemaOk, errorCode: row.errorCode ?? '', costMicroUsd: row.costMicroUsd },
      requestId: ctx.requestId,
    });
    return renderExtraction(db.prepare('SELECT * FROM extractions WHERE id = ?').get(id));
  });
}

function storeDegraded(ctx, user, request, errorCode, { costMicroUsd = 0, latencyMs = null } = {}) {
  const provider = ctx.ai.provider;
  return storeExtraction(ctx, user, request, {
    provider: provider.id, model: provider.model, simulated: provider.simulated, schemaOk: false, degraded: true, errorCode, latencyMs, costMicroUsd,
    fields: degradedFields(), questions: [], addressedToAssistant: false,
  });
}

// ------------------------------------------------------------------ POST /api/requests/:id/extract

async function loadImageForModel(config, row) {
  if (!row) return null;
  try {
    return { bytes: await readFile(imageFilePath(config, row.file_name, row.mime_detected)), mime: row.mime_detected };
  } catch (err) {
    if (err?.code === 'ENOENT') return null; // swept or removed: the extraction continues from the text alone
    throw err;
  }
}

/**
 * extractRequest(ctx, user, requestId) -> { extraction: Extraction }
 * Order (NFR6): owner check (404) -> gate.run: rate (429 extract_upload), concurrency (429 model_concurrency), budget (503) ->
 * the provider call OUTSIDE any transaction -> settle. A refusal stores a degraded row, never calls the provider, and answers
 * 429 / 503 with details { degraded: true, extraction }. A provider failure, an invalid answer or a timeout is still 200 with a
 * degraded extraction (RS-03).
 */
export async function extractRequest(ctx, user, requestId) {
  const { db, config, ai, clock } = ctx;
  if (!ai?.provider || !ai?.gate) throw new TypeError('the application has no AI runtime');
  const request = findOwnedRequest(db, user.id, requestId);
  const imageRow = db.prepare(SQL_LIVE_IMAGE).get(requestId) ?? null;
  const image = await loadImageForModel(config, imageRow);
  const text = request.raw_text ?? '';
  const requestDay = localDay(Date.parse(request.created_at));
  const startedMs = clock.now();

  let failure = null;
  let result;
  try {
    result = await ai.gate.run({
      customerId: user.id,
      requestId,
      call: async () => {
        try {
          const answer = await callProvider(ai.provider, { text, image }, { timeoutMs: config.modelTimeoutMs, capMicroUsd: ai.gate.limits.callCapMicroUsd });
          const checked = validateExtraction(answer?.output); // structure only; grounding is a per-field rule below
          if (!checked.ok) throw new ProviderError('PROVIDER_BAD_OUTPUT', { usage: answer?.usage });
          try {
            microUsdOfUsage(answer.usage);
          } catch {
            throw new ProviderError('PROVIDER_BAD_OUTPUT', { usage: { costMicroUsd: ai.gate.limits.callCapMicroUsd } });
          }
          return { output: checked.value, usage: answer.usage };
        } catch (err) {
          failure = err;
          throw err;
        }
      },
    });
  } catch (err) {
    if (failure !== null && err === failure) {
      const degraded = toDegraded(err);
      ctx.log?.warn?.('extraction.degraded', { code: degraded.errorCode, provider: ai.provider.id, requestRef: requestId });
      return { extraction: storeDegraded(ctx, user, request, degraded.errorCode, { costMicroUsd: costOf(err?.usage), latencyMs: clock.now() - startedMs }) };
    }
    const refusal = adoptAppError(err);
    if (refusal && (refusal.code === 'RATE_LIMITED' || refusal.code === 'MODEL_BUDGET_EXHAUSTED')) {
      const code = refusal.code === 'RATE_LIMITED' ? 'PROVIDER_BUSY' : 'PROVIDER_UNAVAILABLE';
      const extraction = storeDegraded(ctx, user, request, code);
      throw new AppError(refusal.status, refusal.code, { details: { ...refusal.details, degraded: true, extraction }, headers: refusal.headers });
    }
    throw err;
  }

  const normalised = normaliseExtraction(result.output, { text, requestDay, hasImage: image !== null });
  const usage = result.usage ?? {};
  const extraction = storeExtraction(ctx, user, request, {
    provider: ai.provider.id, model: typeof usage.model === 'string' ? usage.model : ai.provider.model, simulated: ai.provider.simulated,
    schemaOk: true, degraded: false, errorCode: null, latencyMs: Number.isFinite(usage.latencyMs) ? Math.round(usage.latencyMs) : null,
    costMicroUsd: costOf(usage), fields: normalised.fields, questions: normalised.questions, addressedToAssistant: normalised.addressedToAssistant,
  });
  ctx.log?.info?.('extraction.done', { provider: ai.provider.id, model: ai.provider.model, schemaOk: true, requestRef: requestId, counts: { downgraded: normalised.downgraded.length } });
  return { extraction };
}
