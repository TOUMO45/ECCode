// Body reader: total size capped while streaming (spec 3.1, 9).
import { ApiError } from './envelope.js';
import { LIMITS } from '../api/contract-schemas.js';

export const MAX_BODY_BYTES = LIMITS.bodyBytes;

export function hasBody(req) {
  const cl = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined) return true;
  return cl !== undefined && cl !== '0';
}

function isJsonType(ct) {
  if (typeof ct !== 'string') return false;
  const m = /^\s*application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.exec(ct);
  return m !== null;
}

/** Read the raw body, enforcing the cap on Content-Length and while streaming. */
export function readRaw(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const cl = req.headers['content-length'];
    if (cl !== undefined) {
      if (!/^\d{1,15}$/.test(cl)) return reject(new ApiError('VALIDATION_FAILED', { details: { fields: [{ path: 'Content-Length', message: 'is invalid' }] } }));
      if (Number(cl) > limit) return reject(new ApiError('PAYLOAD_TOO_LARGE'));
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (e) => { if (!done) { done = true; req.removeAllListeners('data'); reject(e); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) return fail(new ApiError('PAYLOAD_TOO_LARGE'));
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => fail(new ApiError('INVALID_JSON')));
    req.on('aborted', () => fail(new ApiError('INVALID_JSON')));
  });
}

/**
 * Parse a JSON body. Empty body -> {}. A non-empty body must be
 * application/json (415) and valid UTF-8 JSON (400 INVALID_JSON).
 */
export async function readJson(req, limit = MAX_BODY_BYTES) {
  if (!hasBody(req)) return {};
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  }
  if (!isJsonType(req.headers['content-type'])) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  const raw = await readRaw(req, limit);
  if (raw.length === 0) return {};
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new ApiError('INVALID_JSON');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('INVALID_JSON');
  }
}

/** Discard an unread request body, destroying the socket if it exceeds `limit`. */
export function drainLimited(req, limit = MAX_BODY_BYTES) {
  if (req.readableEnded || req.destroyed) return;
  let n = 0;
  req.on('data', (c) => {
    n += c.length;
    if (n > limit) req.destroy();
  });
  req.on('error', () => {});
  req.resume();
}
