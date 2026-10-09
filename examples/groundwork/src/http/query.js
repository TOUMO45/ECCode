// Query-string parsing against a contract schema: whitelisted keys only,
// no duplicates, integers parsed strictly.
import { ApiError } from './envelope.js';
import { validate } from '../lib/schema.js';

export function parseQuery(searchParams, schema) {
  const out = {};
  const fields = [];
  const props = schema?.properties || {};
  const seen = new Set();
  for (const [k, v] of searchParams) {
    const p = k.slice(0, 80);
    if (seen.has(k)) { fields.push({ path: p, message: 'must not be repeated' }); continue; }
    seen.add(k);
    if (!Object.hasOwn(props, k)) { fields.push({ path: p, message: 'is not allowed' }); continue; }
    if (props[k].type === 'integer') {
      out[k] = /^\d{1,10}$/.test(v) ? Number(v) : v; // non-numeric stays a string and fails validation
    } else {
      out[k] = v;
    }
  }
  if (fields.length) throw new ApiError('VALIDATION_FAILED', { details: { fields: fields.slice(0, 20) } });
  if (schema) {
    const r = validate(schema, out);
    if (!r.valid) throw validationError(r.errors);
  }
  return out;
}

export function validationError(errors) {
  return new ApiError('VALIDATION_FAILED', {
    details: { fields: errors.slice(0, 20).map((e) => ({ path: String(e.path).slice(0, 100), message: e.message })) },
  });
}
