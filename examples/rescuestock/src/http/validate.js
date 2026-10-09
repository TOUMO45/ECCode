// Hand-written input validators. Every validator takes a raw value and returns
// {ok: true, value} or {ok: false, rule}. Unknown body fields are dropped,
// numbers must be safe integers, strings are NFC-normalised and length-checked
// in code points. Failures become 422 VALIDATION_FAILED with details.fields.
import { AppError } from './envelope.js';

const ok = (value) => ({ ok: true, value });
const bad = (rule) => ({ ok: false, rule });

export function int(min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  return (value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return bad('integer');
    if (value < min || value > max) return bad(`range:${min}..${max}`);
    return ok(value);
  };
}

export function str(min = 0, max = 4000, pattern = null) {
  return (value) => {
    if (typeof value !== 'string') return bad('string');
    const text = value.normalize('NFC');
    const length = Array.from(text).length;
    if (length < min || length > max) return bad(`length:${min}..${max}`);
    if (pattern && !pattern.test(text)) return bad('pattern');
    return ok(text);
  };
}

export function enumOf(...values) {
  return (value) => (typeof value === 'string' && values.includes(value) ? ok(value) : bad(`enum:${values.join('|')}`));
}

export function bool() {
  return (value) => (typeof value === 'boolean' ? ok(value) : bad('boolean'));
}

// ISO-8601 UTC with milliseconds: 2026-10-20T07:00:00.000Z
export function ts() {
  return (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return bad('timestamp');
    const ms = Date.parse(value);
    return Number.isNaN(ms) || new Date(ms).toISOString() !== value ? bad('timestamp') : ok(value);
  };
}

// LocalDateTime: YYYY-MM-DDTHH:MM (interpreted in Asia/Amman by the caller)
export function localDateTime() {
  return (value) => {
    const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value) : null;
    if (!m) return bad('localDateTime');
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
    const same =
      date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d &&
      date.getUTCHours() === h && date.getUTCMinutes() === mi;
    return same ? ok(value) : bad('localDateTime');
  };
}

// Validates an object against a spec of field validators. A spec entry is a
// validator function (required) or {check, optional, nullable}. Returns a new
// object with only the spec's fields; throws 422 listing every failing field.
export function validateObject(input, spec) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  const fields = [];
  for (const [field, entry] of Object.entries(spec)) {
    const rule = typeof entry === 'function' ? { check: entry } : entry;
    const present = Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined;
    if (!present) {
      if (!rule.optional) fields.push({ field, rule: 'required' });
      continue;
    }
    if (source[field] === null && rule.nullable) {
      out[field] = null;
      continue;
    }
    const result = rule.check(source[field]);
    if (result.ok) out[field] = result.value;
    else fields.push({ field, rule: result.rule });
  }
  if (fields.length > 0) throw new AppError(422, 'VALIDATION_FAILED', { details: { fields } });
  return out;
}

// A positive-integer id from a path or query string. Anything else is a 400.
export function idParam(text) {
  if (typeof text !== 'string' || !/^[1-9]\d{0,14}$/.test(text)) throw new AppError(400, 'BAD_REQUEST');
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new AppError(400, 'BAD_REQUEST');
  return n;
}
