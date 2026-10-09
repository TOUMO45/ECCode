import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, compile, checkSchema } from '../../../src/lib/schema.js';
import { loadConfig, ConfigError } from '../../../src/config.js';
import {
  requests, responses, errorResponse, errorDetails, ERRORS, notesSchemaFor,
} from '../../../src/api/contract-schemas.js';

test('validator: types, required, additionalProperties, nested paths', () => {
  const s = {
    type: 'object', additionalProperties: false, required: ['a'],
    properties: { a: { type: 'integer', minimum: 1, maximum: 5 }, b: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 2 } } },
  };
  assert.ok(validate(s, { a: 3, b: ['x'] }).valid);
  assert.deepEqual(validate(s, {}).errors, [{ path: 'a', message: 'is required' }]);
  assert.equal(validate(s, { a: 1.5 }).valid, false);
  assert.equal(validate(s, { a: 6 }).valid, false);
  assert.equal(validate(s, { a: 1, extra: 1 }).errors[0].path, 'extra');
  assert.equal(validate(s, { a: 1, b: ['x', 'y', 'z'] }).valid, false);
  assert.equal(validate(s, { a: 1, b: ['xyz'] }).errors[0].path, 'b[0]');
  assert.equal(validate(s, [1]).valid, false);
  assert.equal(validate(s, null).valid, false);
});

test('validator: enum, pattern, type unions, NaN/Infinity rejected', () => {
  assert.equal(validate({ enum: ['a'] }, 'b').valid, false);
  assert.equal(validate({ type: 'string', pattern: '^a+$' }, 'aab').valid, false);
  assert.ok(validate({ type: ['integer', 'null'] }, null).valid);
  assert.equal(validate({ type: 'number' }, NaN).valid, false);
  assert.equal(validate({ type: 'integer' }, '1').valid, false);
});

test('validator: caps errors at 20, does not mutate, __proto__ key is data', () => {
  const s = { type: 'array', items: { type: 'integer' } };
  assert.equal(validate(s, Array(100).fill('x')).errors.length, 20);
  const input = JSON.parse('{"__proto__": 1, "a": 1}');
  const copy = JSON.stringify(input);
  const r = validate({ type: 'object', additionalProperties: false, properties: { a: {} } }, input);
  assert.equal(r.valid, false);
  assert.equal(JSON.stringify(input), copy);
});

test('compile rejects unknown keywords and bad types', () => {
  assert.throws(() => compile({ type: 'string', minLenght: 1 }), /unsupported/);
  assert.throws(() => checkSchema({ type: 'strng' }), /bad type/);
  assert.throws(() => checkSchema({ pattern: '(' }));
});

test('config defaults and validation', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.dbPath, './data/groundwork.db');
  assert.equal(c.cookieSecure, false);
  assert.equal(c.cli.timeoutMs, 90000);
  assert.equal(c.anthropic.model, 'claude-haiku-5-5');
  assert.deepEqual(c.cli.envPass, []);
  const d = loadConfig({ PORT: '8080', GW_COOKIE_SECURE: '1', GW_CLI_ENV_PASS: 'A, B,bad name,' });
  assert.equal(d.port, 8080);
  assert.equal(d.cookieSecure, true);
  assert.deepEqual(d.cli.envPass, ['A', 'B']);
  assert.throws(() => loadConfig({ PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
  assert.throws(() => loadConfig({ GW_ENABLE_FAKE: 'yes' }), ConfigError);
  assert.throws(() => loadConfig({ GW_LOG: 'x' }), ConfigError);
});

test('contract: requests accept spec examples and reject extras', () => {
  assert.ok(validate(requests.login, { username: 'a.b-c_1', password: 'x' }).valid);
  assert.equal(validate(requests.login, { username: 'a b', password: 'x' }).valid, false);
  assert.equal(validate(requests.login, { username: 'a', password: 'x', role: 'lead' }).valid, false);
  assert.equal(validate(requests.createUser, { username: 'u', displayName: 'U', password: 'short', role: 'lead' }).valid, false);
  assert.ok(validate(requests.createIncident, { title: 't', severity: 'SEV2', startedAt: '2026-10-08T20:40:54.602Z', description: '' }).valid);
  assert.equal(validate(requests.createIncident, { title: 't', severity: 'SEV2', startedAt: '2026-10-08T20:40:54.602Z', status: 'x' }).valid, false);
  assert.ok(validate(notesSchemaFor({ format: 'json' }), { format: 'json', content: [{ time: '10:00', author: 'a', text: 't' }] }).valid);
  assert.equal(validate(notesSchemaFor({ format: 'json' }), { format: 'json', content: [] }).valid, false);
  assert.ok(validate(notesSchemaFor({ format: 'text' }), { format: 'text', content: '10:00 a: t' }).valid);
  assert.equal(validate(notesSchemaFor({ format: 'xml' }), { format: 'xml', content: 'x' }).valid, false);
  assert.ok(validate(requests.generateDraft, {}).valid);
  assert.equal(validate(requests.generateDraft, { provider: 'gpt' }).valid, false);
  assert.ok(validate(requests.editStatement, { expectedVersion: 1, cites: [] }).valid);
  assert.equal(validate(requests.editStatement, { expectedVersion: 1, cites: Array(21).fill(1) }).valid, false);
  assert.equal(validate(requests.editStatement, { text: 'x' }).valid, false);
  assert.equal(validate(requests.editStatement, { expectedVersion: 1, status: 'verified' }).valid, false);
});

test('contract: responses and error envelope', () => {
  const user = { id: 1, username: 'u', displayName: 'U', role: 'lead', teamId: 1, teamName: 'Platform' };
  assert.ok(validate(responses.login, { user, csrfToken: 'a.b' }).valid);
  assert.equal(validate(responses.login, { user: { ...user, role: 'root' }, csrfToken: 'a.b' }).valid, false);
  assert.ok(validate(responses.health, { status: 'ok', version: '1.0.0', schemaVersion: 2 }).valid);
  assert.ok(validate(responses.audit, { entries: [], nextBefore: null }).valid);
  const env = { error: { code: 'NOT_FOUND', message: 'Not found', requestId: '0123456789abcdef' } };
  assert.ok(validate(errorResponse, env).valid);
  assert.equal(validate(errorResponse, { error: { ...env.error, code: 'NOPE' } }).valid, false);
  assert.equal(validate(errorResponse, { error: { ...env.error, stack: 'x' } }).valid, false);
  assert.ok(validate(errorDetails.STALE_VERSION, { currentVersion: 3 }).valid);
  assert.ok(validate(errorDetails.NOTES_INVALID, { lines: [{ line: 2, message: 'm' }], total: 1 }).valid);
});

test('contract: ERRORS table matches spec statuses', () => {
  assert.equal(ERRORS.INVALID_JSON.status, 400);
  assert.equal(ERRORS.CSRF_FAILED.status, 403);
  assert.equal(ERRORS.METHOD_NOT_ALLOWED.status, 405);
  assert.equal(ERRORS.RATE_LIMITED.status, 429);
  assert.equal(ERRORS.PROVIDER_BUSY.status, 503);
  assert.equal(ERRORS.PROVIDER_TIMEOUT.status, 504);
  assert.equal(ERRORS.INTERNAL.message, 'Something went wrong');
  assert.equal(Object.keys(ERRORS).length, 25);
});
