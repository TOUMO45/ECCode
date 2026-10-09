// Tiny JSON-schema subset validator (spec section 2):
// type, properties, required, additionalProperties, items, enum, minLength,
// maxLength, minimum, maximum, minItems, maxItems, pattern.
// Pure; never mutates input. Unknown keywords throw at compile time so a typo
// in a schema cannot silently disable a check.

const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern',
  'description', 'title',
]);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const MAX_ERRORS = 20;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v, t) {
  switch (t) {
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'null': return v === null;
    default: return typeof v === t;
  }
}

const regexCache = new WeakMap();

/** Throws TypeError if the schema uses unsupported keywords or bad types. */
export function checkSchema(schema, at = '#') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(`schema at ${at} must be an object`);
  }
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k)) throw new TypeError(`unsupported schema keyword "${k}" at ${at}`);
  }
  if (schema.type !== undefined) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of ts) if (!TYPES.has(t)) throw new TypeError(`bad type "${t}" at ${at}`);
  }
  if (schema.properties) {
    for (const [k, s] of Object.entries(schema.properties)) checkSchema(s, `${at}/${k}`);
  }
  if (schema.items) checkSchema(schema.items, `${at}/items`);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    checkSchema(schema.additionalProperties, `${at}/additionalProperties`);
  }
  if (schema.pattern !== undefined) new RegExp(schema.pattern, 'u');
  return schema;
}

function regexFor(schema) {
  let re = regexCache.get(schema);
  if (!re) {
    re = new RegExp(schema.pattern, 'u');
    regexCache.set(schema, re);
  }
  return re;
}

function join(path, key) {
  return path === '' ? key : `${path}.${key}`;
}

function walk(schema, value, path, errors) {
  if (errors.length >= MAX_ERRORS) return;
  const add = (p, message) => {
    if (errors.length < MAX_ERRORS) errors.push({ path: p, message });
  };

  if (schema.type !== undefined) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!ts.some((t) => matchesType(value, t))) {
      add(path, `must be ${ts.join(' or ')}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    add(path, `must be one of: ${schema.enum.join(', ')}`);
    return;
  }

  const t = typeOf(value);
  if (t === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) add(path, `must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) add(path, `must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !regexFor(schema).test(value)) add(path, 'has an invalid format');
  } else if (t === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(path, `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(path, `must be <= ${schema.maximum}`);
  } else if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(path, `must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(path, `must have at most ${schema.maxItems} items`);
    if (schema.items) {
      for (let i = 0; i < value.length && errors.length < MAX_ERRORS; i++) {
        walk(schema.items, value[i], `${path}[${i}]`, errors);
      }
    }
  } else if (t === 'object') {
    const props = schema.properties || {};
    for (const r of schema.required || []) {
      if (!Object.hasOwn(value, r)) add(join(path, r), 'is required');
    }
    for (const k of Object.keys(value)) {
      if (Object.hasOwn(props, k)) {
        walk(props[k], value[k], join(path, k), errors);
      } else if (schema.additionalProperties === false) {
        add(join(path, k), 'is not allowed');
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        walk(schema.additionalProperties, value[k], join(path, k), errors);
      }
    }
  }
}

/** Returns { valid, errors: [{path, message}] } (max 20 errors). */
export function validate(schema, value) {
  const errors = [];
  walk(schema, value, '', errors);
  return { valid: errors.length === 0, errors };
}

/** Check the schema once and return a validator function. */
export function compile(schema) {
  checkSchema(schema);
  return (value) => validate(schema, value);
}
