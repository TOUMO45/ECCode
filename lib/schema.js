'use strict';
// Minimal JSON-Schema subset validator (type, required, properties, enum,
// items, minItems, minLength, pattern, additionalProperties:false, oneOf of
// types). Kept in-house so the toolkit has zero runtime dependencies.

const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, '..', 'schemas');
const cache = new Map();

function loadSchema(name) {
  if (!cache.has(name)) {
    cache.set(name, JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8')));
  }
  return cache.get(name);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

function validate(schema, value, at = '$', errors = []) {
  if (schema.$ref) schema = loadSchema(schema.$ref);
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${at}: expected ${[].concat(schema.type).join('|')}, got ${typeOf(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: must be one of ${schema.enum.join(', ')} (got ${JSON.stringify(value)})`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) {
      errors.push(`${at}: must be at least ${schema.minLength} non-blank characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: must match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${at}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(`${at}.${key}: is required`);
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined) validate(sub, value[key], `${at}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${at}.${key}: unknown property`);
      }
    }
  }
  return errors;
}

/** Validate against a named schema in /schemas; returns an array of error strings. */
function validateNamed(name, value) {
  return validate(loadSchema(name), value);
}

module.exports = { validate, validateNamed, loadSchema };
