// Request body readers with byte caps enforced while streaming.
//   readJsonBody:  JSON, at most 65,536 bytes (413 PAYLOAD_TOO_LARGE), 400 INVALID_JSON
//   readRawBody:   bytes with a caller-chosen cap (uploads, webhooks)
//   canonicalJson: stable serialisation (sorted keys, no whitespace)
import { AppError } from './envelope.js';

export const JSON_BODY_LIMIT = 65536;
export const IMAGE_BODY_LIMIT = 5242880;
// After a refusal the rest of the body is read and discarded, up to this much,
// so the client can still receive the error before the connection closes.
const DRAIN_LIMIT = 4 * 1024 * 1024;

function declaredLength(req) {
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  if (!/^\d{1,15}$/.test(raw)) throw new AppError(400, 'BAD_REQUEST');
  return Number(raw);
}

function tooLarge() {
  // The connection is not reusable once part of the body went unread.
  return new AppError(413, 'PAYLOAD_TOO_LARGE', { headers: { Connection: 'close' } });
}

export function readRawBody(req, { limit }) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('readRawBody needs a byte limit');
  return new Promise((resolve, reject) => {
    let length;
    try {
      length = declaredLength(req);
    } catch (err) {
      reject(err);
      return;
    }
    if (length !== null && length > limit) {
      drain(req);
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      req.removeListener('data', onData);
      fn(value);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        finish(reject, tooLarge());
        drain(req);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => finish(resolve, Buffer.concat(chunks, total)));
    req.once('error', () => finish(reject, new AppError(400, 'BAD_REQUEST')));
    req.once('aborted', () => finish(reject, new AppError(400, 'BAD_REQUEST')));
  });
}

function drain(req) {
  let seen = 0;
  req.on('data', (chunk) => {
    seen += chunk.length;
    if (seen > DRAIN_LIMIT) req.destroy();
  });
  req.on('error', () => {});
  req.resume();
}

// Deepest nesting of objects and arrays a request body may have (SEC-B-3). Real bodies are 3-4 levels deep.
export const JSON_MAX_DEPTH = 32;

// True when the JSON text nests deeper than maxDepth. One pass over the text with no recursion,
// skipping string contents, so a hostile body is refused before it is parsed.
export function jsonNestsDeeperThan(text, maxDepth = JSON_MAX_DEPTH) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i += 1; // backslash: skip the escaped character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > maxDepth) return true;
    } else if (c === 0x7d || c === 0x5d) {
      depth -= 1;
    }
  }
  return false;
}

function isJsonContentType(header) {
  if (typeof header !== 'string') return false;
  const media = header.split(';')[0].trim().toLowerCase();
  return media === 'application/json';
}

// Returns the parsed body, or {} when the body is empty. A non-empty body must
// be application/json (415 otherwise) and valid JSON (400 INVALID_JSON).
export async function readJsonBody(req, { limit = JSON_BODY_LIMIT } = {}) {
  const buf = await readRawBody(req, { limit });
  if (buf.length === 0) return {};
  if (!isJsonContentType(req.headers['content-type'])) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new AppError(400, 'INVALID_JSON');
  }
  if (jsonNestsDeeperThan(text)) {
    throw new AppError(422, 'VALIDATION_FAILED', { details: { fields: [{ field: 'body', rule: `depth:${JSON_MAX_DEPTH}` }] } });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, 'INVALID_JSON');
  }
}

// Like readJsonBody, but the body must be a JSON object (422 otherwise).
export async function readJsonObject(req, options) {
  const body = await readJsonBody(req, options);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(422, 'VALIDATION_FAILED', { details: { fields: [{ field: 'body', rule: 'object' }] } });
  }
  return body;
}

// Throws TypeError for a non-finite number or for nesting deeper than JSON_MAX_DEPTH (never a stack overflow).
export function canonicalJson(value, depth = 1) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson cannot encode a non-finite number');
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
  }
  if (depth > JSON_MAX_DEPTH) throw new TypeError('canonicalJson input is nested too deeply');
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v, depth + 1)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`).join(',')}}`;
}
