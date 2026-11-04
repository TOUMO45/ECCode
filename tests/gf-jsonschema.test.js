'use strict';
// The JSON-Schema subset the greenfield layer validates artifacts and (later) API responses with.
// Zero dependencies, like the engine. An unsupported keyword is reported, never silently ignored (L-GF-6).
const test = require('node:test');
const assert = require('node:assert');
const { validate } = require('../lib/greenfield/jsonschema');

const ok = (schema, value, opts) => assert.deepStrictEqual(validate(schema, value, opts), []);
const bad = (schema, value, pathWanted, textWanted, opts) => {
  const errs = validate(schema, value, opts);
  assert.ok(errs.length >= 1, `expected an error for ${JSON.stringify(value)}`);
  if (pathWanted !== undefined) assert.ok(errs.some((e) => e.path === pathWanted), `no error at ${pathWanted}: ${JSON.stringify(errs)}`);
  if (textWanted) assert.ok(errs.some((e) => e.message.includes(textWanted)), `no error mentioning "${textWanted}": ${JSON.stringify(errs)}`);
  return errs;
};

test('type: each primitive accepts its own and refuses others; integer is not a float; arrays of types', () => {
  ok({ type: 'string' }, 'a');
  bad({ type: 'string' }, 1, '', 'string');
  ok({ type: 'integer' }, 3);
  bad({ type: 'integer' }, 3.5, '', 'integer');
  ok({ type: 'number' }, 3.5);
  bad({ type: 'number' }, '3', '');
  ok({ type: 'boolean' }, false);
  ok({ type: 'null' }, null);
  ok({ type: 'array' }, []);
  bad({ type: 'array' }, {}, '');
  bad({ type: 'object' }, [], '');
  ok({ type: ['string', 'null'] }, null);
  bad({ type: ['string', 'null'] }, 4, '');
});

test('nullable, enum, const', () => {
  ok({ type: 'string', nullable: true }, null);
  bad({ type: 'string' }, null, '');
  ok({ enum: ['a', 'b'] }, 'a');
  bad({ enum: ['a', 'b'] }, 'c', '', 'enum');
  ok({ const: 7 }, 7);
  bad({ const: 7 }, 8, '', 'const');
});

test('object: required, properties, additionalProperties (false and schema); paths point at the offender', () => {
  const s = { type: 'object', required: ['a'], properties: { a: { type: 'string', minLength: 3 }, n: { type: 'object', properties: { z: { type: 'integer' } } } }, additionalProperties: false };
  ok(s, { a: 'abc', n: { z: 1 } });
  bad(s, {}, '', 'required');
  bad(s, { a: 'xy' }, '/a', 'minLength');
  bad(s, { a: 'abc', extra: 1 }, '/extra', 'additional');
  bad(s, { a: 'abc', n: { z: 'q' } }, '/n/z', 'integer');
  ok({ type: 'object', additionalProperties: { type: 'integer' } }, { x: 1, y: 2 });
  bad({ type: 'object', additionalProperties: { type: 'integer' } }, { x: 1, y: 'no' }, '/y', 'integer');
});

test('array: items, minItems, maxItems, uniqueItems', () => {
  ok({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }, ['a']);
  bad({ type: 'array', items: { type: 'string' } }, ['a', 3], '/1', 'string');
  bad({ type: 'array', minItems: 1 }, [], '', 'minItems');
  bad({ type: 'array', maxItems: 1 }, [1, 2], '', 'maxItems');
  bad({ type: 'array', uniqueItems: true }, [{ a: 1 }, { a: 1 }], '', 'unique');
  ok({ type: 'array', uniqueItems: true }, [{ a: 1 }, { a: 2 }]);
});

test('string and number bounds, pattern, format', () => {
  bad({ type: 'string', maxLength: 2 }, 'abc', '', 'maxLength');
  ok({ type: 'string', pattern: '^AC-[0-9]+$' }, 'AC-12');
  bad({ type: 'string', pattern: '^AC-[0-9]+$' }, 'ac-1', '', 'pattern');
  bad({ type: 'integer', minimum: 1 }, 0, '', 'minimum');
  bad({ type: 'integer', maximum: 5 }, 6, '', 'maximum');
  ok({ type: 'string', format: 'email' }, 'a@b.co');
  bad({ type: 'string', format: 'email' }, 'not-an-email', '', 'format');
  ok({ type: 'string', format: 'uuid' }, '123e4567-e89b-12d3-a456-426614174000');
  bad({ type: 'string', format: 'uuid' }, '123', '', 'format');
  ok({ type: 'string', format: 'date-time' }, '2026-11-04T10:00:00Z');
  bad({ type: 'string', format: 'date-time' }, 'yesterday', '', 'format');
  ok({ type: 'string', format: 'some-unknown-format' }, 'anything'); // a format is an annotation unless known
});

test('allOf, anyOf, oneOf', () => {
  ok({ allOf: [{ type: 'object' }, { required: ['a'] }] }, { a: 1 });
  bad({ allOf: [{ type: 'object' }, { required: ['a'] }] }, {}, '', 'required');
  ok({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 3);
  bad({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, true, '', 'anyOf');
  ok({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 'x');
  bad({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 3, '', 'oneOf'); // matches both
});

test('$ref: local pointers resolve against the root; unresolved and cyclic refs are reported, not crashed on', () => {
  const root = { definitions: { id: { type: 'integer', minimum: 1 } }, type: 'object', properties: { id: { $ref: '#/definitions/id' } } };
  ok(root, { id: 2 });
  bad(root, { id: 0 }, '/id', 'minimum');
  bad({ $ref: '#/definitions/nope' }, 1, '', 'unresolved');
  const cyc = { $ref: '#/a', a: { $ref: '#/a' } };
  bad(cyc, 1, '', 'cycle');
  // a recursive structure over finite data terminates
  const tree = { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#' } } } };
  ok(tree, { kids: [{ kids: [{ kids: [] }] }] });
  // an explicit root for a sub-schema
  ok({ $ref: '#/components/schemas/T' }, 'x', { root: { components: { schemas: { T: { type: 'string' } } } } });
});

test('unsupported keywords are reported; annotations and x- extensions are allowed', () => {
  const errs = bad({ type: 'object', patternProperties: { '^a': { type: 'string' } } }, {}, '', 'unsupported keyword patternProperties');
  assert.ok(errs.length === 1);
  for (const k of ['not', 'if', 'multipleOf', 'minProperties', 'propertyNames', 'dependentRequired']) {
    bad({ [k]: {} }, {}, '', `unsupported keyword ${k}`);
  }
  ok({ type: 'string', title: 't', description: 'd', default: 'x', example: 'e', examples: ['e'], deprecated: false, 'x-gf-public': true, $comment: 'c', $schema: 'x', $id: 'y' }, 'q');
});

test('hostile and large input: deep nesting is bounded, 10^5 items validate fast, prototype keys are ordinary data', () => {
  let deep = { type: 'null' };
  for (let i = 0; i < 200; i++) deep = { type: 'object', properties: { a: deep } };
  let value = null;
  for (let i = 0; i < 200; i++) value = { a: value };
  const errs = validate(deep, value);
  assert.ok(errs.some((e) => /depth/.test(e.message)), 'a schema deeper than the cap is reported');
  const big = Array.from({ length: 100000 }, (_, i) => i);
  const t0 = Date.now();
  ok({ type: 'array', items: { type: 'integer' } }, big);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  ok({ type: 'object', required: ['__proto__'] }, JSON.parse('{"__proto__": 1}'));
  bad({ type: 'object', required: ['constructor'] }, {}, '', 'required'); // inherited properties do not count
});
