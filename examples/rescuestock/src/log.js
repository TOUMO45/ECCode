// JSON-lines logger. One line per event: {ts, level, msg, requestId, ...allowListed}.
// Keys outside the allow-list are dropped. String values are truncated to 120
// characters and control characters are stripped. Bodies, tokens, payer data
// and free text never reach a log line because they cannot pass the allow-list.
import { randomBytes } from 'node:crypto';
import { systemClock } from './clock.js';

export const ALLOWED_KEYS = Object.freeze(
  new Set([
    'route', 'method', 'status', 'durationMs', 'userId', 'role', 'requestRef', 'planVersionId',
    'reservationId', 'supplierOrderId', 'paymentOperationId', 'providerCallId', 'operationKey',
    'kind', 'providerStatus', 'httpStatus', 'code', 'attempt', 'epoch', 'executorId', 'provider',
    'model', 'costUsd', 'latencyMs', 'schemaOk', 'counts',
    // Not in the spec's list: the "listening" line must carry the bound port for the test harness.
    'port',
  ]),
);

export const MAX_STRING = 120;
const MAX_COUNT_KEYS = 20;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// C0 and C1 controls, DEL, and the Unicode line and paragraph separators.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function cleanString(value) {
  const stripped = String(value).replace(CONTROL_CHARS, '');
  const chars = Array.from(stripped);
  return chars.length > MAX_STRING ? chars.slice(0, MAX_STRING).join('') : stripped;
}

function cleanValue(key, value) {
  if (value === null) return { ok: true, value: null };
  switch (typeof value) {
    case 'string':
      return { ok: true, value: cleanString(value) };
    case 'number':
      return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    case 'boolean':
      return { ok: true, value };
    case 'object': {
      if (key !== 'counts' || Array.isArray(value)) return { ok: false };
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return { ok: false };
      const out = {};
      let n = 0;
      for (const [k, v] of Object.entries(value)) {
        if (n >= MAX_COUNT_KEYS) break;
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        out[cleanString(k)] = v;
        n += 1;
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: false };
  }
}

export function generateLogRequestId(prefix = 'sys') {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

function cleanRequestId(value, fallback) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : fallback;
}

// write(line) receives one complete line including the trailing newline.
export function createLogger({ write, clock = systemClock, requestId } = {}) {
  const sink = write || ((line) => process.stdout.write(line));
  const baseId = cleanRequestId(requestId, generateLogRequestId('sys'));

  function make(defaultId) {
    function emit(level, msg, fields) {
      try {
        const f = fields && typeof fields === 'object' ? fields : {};
        const line = {
          ts: new Date(clock.now()).toISOString(),
          level,
          msg: cleanString(msg),
          requestId: cleanRequestId(f.requestId, defaultId),
        };
        for (const key of Object.keys(f)) {
          if (!ALLOWED_KEYS.has(key)) continue;
          const cleaned = cleanValue(key, f[key]);
          if (cleaned.ok) line[key] = cleaned.value;
        }
        sink(`${JSON.stringify(line)}\n`);
      } catch {
        // Logging must never break the caller; a failed line is dropped.
      }
    }
    return {
      debug: (msg, fields) => emit('debug', msg, fields),
      info: (msg, fields) => emit('info', msg, fields),
      warn: (msg, fields) => emit('warn', msg, fields),
      error: (msg, fields) => emit('error', msg, fields),
      child(childRequestId) {
        return make(cleanRequestId(childRequestId, defaultId));
      },
    };
  }

  return make(baseId);
}

export function silentLogger() {
  return createLogger({ write: () => {} });
}
