'use strict';
// The JSON-Schema subset the greenfield layer uses for its artifact shapes and, later, for API responses.
// Zero dependencies. Stated limit (L-GF-6): only the keywords below are interpreted; any other keyword that
// is not an annotation or an `x-` extension is REPORTED as unsupported, never silently ignored, so a schema
// cannot look stricter than it is.

const MAX_DEPTH = 64;

const SUPPORTED = new Set([
  'type', 'nullable', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'format', 'allOf', 'anyOf', 'oneOf', '$ref',
]);
// Keywords that carry no validation meaning (or hold sub-schemas reachable only through $ref).
const ANNOTATIONS = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'example', 'examples', 'deprecated',
  'readOnly', 'writeOnly', 'discriminator', 'xml', 'externalDocs', 'definitions', '$defs',
]);

const FORMATS = {
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const regexCache = new Map();

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(t, v) {
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (t === 'null') return v === null;
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === t;
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let node = root;
  const pointer = ref.slice(1);
  if (pointer === '') return node;
  if (!pointer.startsWith('/')) return undefined;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !has(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function node(schema, value, path, ctx, depth, refsHere) {
  const out = ctx.errors;
  const err = (message, p = path) => out.push({ path: p, message });
  if (depth > MAX_DEPTH) {
    if (!ctx.depthReported) { ctx.depthReported = true; err(`schema depth exceeded (${MAX_DEPTH})`); }
    return;
  }
  if (schema === true || schema === undefined) return;
  if (schema === false) return err('no value is allowed here');
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return err('the schema is not an object');

  for (const k of Object.keys(schema)) {
    if (!SUPPORTED.has(k) && !ANNOTATIONS.has(k) && !k.startsWith('x-')) err(`unsupported keyword ${k}`);
  }

  if (has(schema, '$ref')) {
    const ref = schema.$ref;
    if (refsHere.has(ref)) return err(`$ref cycle at ${ref}`);
    const target = resolveRef(ctx.root, ref);
    if (target === undefined) return err(`unresolved $ref ${ref}`);
    const next = new Set(refsHere);
    next.add(ref);
    node(target, value, path, ctx, depth + 1, next);
  }

  if (value === null && schema.nullable === true) return;

  if (has(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) return err(`expected ${types.join(' or ')}, got ${typeName(value)}`);
  }
  if (has(schema, 'enum') && !(Array.isArray(schema.enum) && schema.enum.some((e) => canonical(e) === canonical(value)))) err('value not in enum');
  if (has(schema, 'const') && canonical(schema.const) !== canonical(value)) err('value differs from const');

  if (typeof value === 'string') {
    if (has(schema, 'minLength') || has(schema, 'maxLength')) {
      const n = Array.from(value).length;
      if (has(schema, 'minLength') && n < schema.minLength) err(`string shorter than minLength ${schema.minLength}`);
      if (has(schema, 'maxLength') && n > schema.maxLength) err(`string longer than maxLength ${schema.maxLength}`);
    }
    if (has(schema, 'pattern')) {
      let re = regexCache.get(schema.pattern);
      if (re === undefined) {
        try { re = new RegExp(schema.pattern, 'u'); } catch { re = null; }
        regexCache.set(schema.pattern, re);
      }
      if (re === null) err(`invalid pattern ${schema.pattern}`);
      else if (!re.test(value)) err(`string does not match pattern ${schema.pattern}`);
    }
    if (has(schema, 'format') && FORMATS[schema.format] && !FORMATS[schema.format](value)) err(`string is not a valid ${schema.format} (format)`);
  }

  if (typeof value === 'number') {
    if (has(schema, 'minimum') && value < schema.minimum) err(`number below minimum ${schema.minimum}`);
    if (has(schema, 'maximum') && value > schema.maximum) err(`number above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (has(schema, 'minItems') && value.length < schema.minItems) err(`fewer than minItems ${schema.minItems}`);
    if (has(schema, 'maxItems') && value.length > schema.maxItems) err(`more than maxItems ${schema.maxItems}`);
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of value) {
        const key = canonical(item);
        if (seen.has(key)) { err('array items are not unique (uniqueItems)'); break; }
        seen.add(key);
      }
    }
    if (has(schema, 'items')) value.forEach((item, i) => node(schema.items, item, `${path}/${i}`, ctx, depth + 1, new Set()));
  } else if (value !== null && typeof value === 'object') {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) if (!has(value, k)) err(`missing required property "${k}"`);
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [k, sub] of Object.entries(props)) {
      if (has(value, k)) node(sub, value[k], `${path}/${k}`, ctx, depth + 1, new Set());
    }
    if (has(schema, 'additionalProperties')) {
      for (const k of Object.keys(value)) {
        if (has(props, k)) continue;
        if (schema.additionalProperties === false) err(`additional property "${k}" not allowed`, `${path}/${k}`);
        else if (schema.additionalProperties !== true) node(schema.additionalProperties, value[k], `${path}/${k}`, ctx, depth + 1, new Set());
      }
    }
  }

  const sub = (s) => {
    const inner = { root: ctx.root, errors: [], depthReported: ctx.depthReported };
    node(s, value, path, inner, depth + 1, new Set(refsHere));
    if (inner.depthReported) ctx.depthReported = true;
    return inner.errors;
  };
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) out.push(...sub(s));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => sub(s).length === 0)) err(`anyOf: matched none of ${schema.anyOf.length}`);
  if (Array.isArray(schema.oneOf)) {
    const n = schema.oneOf.filter((s) => sub(s).length === 0).length;
    if (n !== 1) err(`oneOf: matched ${n} of ${schema.oneOf.length}, exactly one is required`);
  }
}

/** Validate `value` against `schema`. Returns [{ path, message }]; empty means valid. `opts.root` resolves local $ref (default: the schema). */
function validate(schema, value, opts = {}) {
  const ctx = { root: opts.root !== undefined ? opts.root : schema, errors: [], depthReported: false };
  node(schema, value, '', ctx, 0, new Set());
  return ctx.errors;
}

module.exports = { validate, resolveRef, canonical, SUPPORTED, ANNOTATIONS, MAX_DEPTH };
