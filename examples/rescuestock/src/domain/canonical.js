// Canonical JSON and sha256, used for planHash, offersHash and request fingerprints.
// Canonical form: object keys sorted by UTF-16 code unit, no whitespace, arrays keep their order, strings and
// numbers as JSON.stringify writes them. Values JSON cannot represent exactly (undefined, functions, symbols,
// NaN, Infinity, BigInt, Date, Map, Set, class instances) are refused, never silently dropped, so two different
// inputs cannot collapse to one hash.
import { createHash } from 'node:crypto';

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function write(value, path, seen) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonical JSON cannot represent a non-finite number at ${path}`);
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object': {
      if (seen.has(value)) throw new TypeError(`canonical JSON cannot represent a cycle at ${path}`);
      seen.add(value);
      let out;
      if (Array.isArray(value)) {
        const items = [];
        for (let i = 0; i < value.length; i += 1) {
          if (!(i in value)) throw new TypeError(`canonical JSON cannot represent a sparse array at ${path}[${i}]`);
          items.push(write(value[i], `${path}[${i}]`, seen));
        }
        out = `[${items.join(',')}]`;
      } else if (isPlainObject(value)) {
        const parts = [];
        for (const key of Object.keys(value).sort()) {
          parts.push(`${JSON.stringify(key)}:${write(value[key], `${path}.${key}`, seen)}`);
        }
        out = `{${parts.join(',')}}`;
      } else {
        throw new TypeError(`canonical JSON cannot represent a non-plain object at ${path}`);
      }
      seen.delete(value);
      return out;
    }
    default:
      throw new TypeError(`canonical JSON cannot represent ${typeof value} at ${path}`);
  }
}

export function canonicalJson(value) {
  return write(value, '$', new Set());
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// 64 lowercase hex characters (type `Hash` in the contracts).
export function canonicalHash(value) {
  return sha256Hex(canonicalJson(value));
}
