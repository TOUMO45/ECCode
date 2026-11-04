'use strict';
// GF-CON-1: the structural OpenAPI check, the operation index, the request-field list the threat model must
// cover, and the differ the amendment classifier uses. Every refusal names the rule id.
const test = require('node:test');
const assert = require('node:assert');
const { validateOpenApi, operations, requestFields, diff, classify } = require('../lib/greenfield/openapi');

const json = (schema) => ({ content: { 'application/json': { schema } } });

function doc() {
  return {
    openapi: '3.0.3',
    info: { title: 'Tasks API', version: '1.0.0' },
    security: [{ bearer: [] }],
    paths: {
      '/healthz': { get: { operationId: 'health', 'x-gf-public': true, responses: { 200: { description: 'ok', ...json({ type: 'object' }) }, 429: { description: 'slow down', ...json({ $ref: '#/components/schemas/Error' }) } } } },
      '/tasks': {
        get: { operationId: 'listTasks', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'ok', ...json({ type: 'array', items: { $ref: '#/components/schemas/Task' } }) }, 401: { description: 'no', ...json({ $ref: '#/components/schemas/Error' }) } } },
        post: { operationId: 'createTask', requestBody: { required: true, ...json({ type: 'object', required: ['title'], properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, meta: { type: 'object', properties: { color: { type: 'string' } } } } }) }, responses: { 201: { description: 'made', ...json({ $ref: '#/components/schemas/Task' }) }, 422: { description: 'bad', ...json({ $ref: '#/components/schemas/Error' }) } } },
      },
      '/tasks/{taskId}': {
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
        delete: { operationId: 'deleteTask', responses: { 204: { description: 'gone' }, 404: { description: 'none', ...json({ $ref: '#/components/schemas/Error' }) } } },
      },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Task: { type: 'object', required: ['id', 'title'], properties: { id: { type: 'string' }, title: { type: 'string' } } },
        Error: { type: 'object', required: ['detail'], properties: { detail: { type: 'string' } } },
      },
    },
  };
}
const clone = (d) => JSON.parse(JSON.stringify(d));
const rules = (d) => validateOpenApi(d);

test('a valid document has no problem, and the index lists every operation with its facts', () => {
  assert.deepStrictEqual(rules(doc()), []);
  const ops = operations(doc());
  assert.deepStrictEqual(ops.map((o) => o.operationId).sort(), ['createTask', 'deleteTask', 'health', 'listTasks']);
  const del = ops.find((o) => o.operationId === 'deleteTask');
  assert.deepStrictEqual({ method: del.method, path: del.path, pathParams: del.pathParams, public: del.public }, { method: 'delete', path: '/tasks/{taskId}', pathParams: ['taskId'], public: false });
  assert.strictEqual(ops.find((o) => o.operationId === 'health').public, true);
  assert.deepStrictEqual(ops.find((o) => o.operationId === 'listTasks').security, [{ bearer: [] }]);
});

const REFUSALS = [
  ['an unsupported OpenAPI version', (d) => { d.openapi = '2.0'; }, /openapi/],
  ['a missing info.version', (d) => { delete d.info.version; }, /info\.version/],
  ['no paths', (d) => { d.paths = {}; }, /paths/],
  ['an unknown method key', (d) => { d.paths['/tasks'].fetch = { operationId: 'x', responses: {} }; }, /fetch/],
  ['a missing operationId', (d) => { delete d.paths['/tasks'].get.operationId; }, /operationId/],
  ['an operationId with a space', (d) => { d.paths['/tasks'].get.operationId = 'list tasks'; }, /operationId/],
  ['a duplicate operationId', (d) => { d.paths['/tasks'].post.operationId = 'listTasks'; }, /duplicate operationId listTasks/],
  ['an unresolved $ref', (d) => { d.paths['/tasks'].get.responses[200].content['application/json'].schema = { $ref: '#/components/schemas/Nope' }; }, /unresolved/],
  ['no success response', (d) => { delete d.paths['/tasks'].get.responses[200]; }, /2xx/],
  ['no error response', (d) => { delete d.paths['/tasks'].get.responses[401]; }, /4xx/],
  ['a 200 without a schema', (d) => { delete d.paths['/tasks'].get.responses[200].content; }, /schema/],
  ['a request body without a JSON schema', (d) => { d.paths['/tasks'].post.requestBody = { content: { 'text/plain': {} } }; }, /requestBody/],
  ['an operation with no security that is not public', (d) => { delete d.security; }, /security/],
  ['a security requirement naming an undefined scheme', (d) => { d.security = [{ ghost: [] }]; }, /ghost/],
];

for (const [name, mutate, text] of REFUSALS) {
  test(`GF-CON-1 refuses ${name}`, () => {
    const d = clone(doc());
    mutate(d);
    const problems = rules(d);
    assert.ok(problems.length >= 1, 'a problem is expected');
    assert.ok(problems.every((p) => p.rule === 'GF-CON-1'), JSON.stringify(problems));
    assert.ok(problems.some((p) => text.test(p.message)), `no problem matching ${text}: ${JSON.stringify(problems)}`);
  });
}

test('a $ref that is not local is GF-CON-1', () => {
  const d = clone(doc());
  d.paths['/tasks'].get.responses[200].content['application/json'].schema = { $ref: 'http://example.test/schema.json' };
  const problems = rules(d);
  assert.ok(problems.every((p) => p.rule === 'GF-CON-1') && problems.some((p) => /only local \$ref/.test(p.message)), JSON.stringify(problems));
});

test('a duplicate operationId is reported once, not once per use', () => {
  const d = clone(doc());
  d.paths['/tasks'].post.operationId = 'listTasks';
  d.paths['/tasks/{taskId}'].delete.operationId = 'listTasks';
  assert.strictEqual(rules(d).filter((p) => /duplicate operationId/.test(p.message)).length, 1);
});

test('input that is not a document does not crash the validator', () => {
  for (const bad of [null, [], 'x', 3, { openapi: '3.0.0' }]) {
    const problems = rules(bad);
    assert.ok(problems.length >= 1 && problems.every((p) => p.rule === 'GF-CON-1'));
  }
});

test('requestFields lists path, query and flattened body fields (the threat model must cover exactly these)', () => {
  const d = doc();
  assert.deepStrictEqual(requestFields(d, 'deleteTask'), ['path:taskId']);
  assert.deepStrictEqual(requestFields(d, 'listTasks'), ['query:limit']);
  assert.deepStrictEqual(requestFields(d, 'createTask').sort(), ['body:meta.color', 'body:tags', 'body:title']);
  assert.deepStrictEqual(requestFields(d, 'health'), []);
  assert.throws(() => requestFields(d, 'nope'), /unknown operationId nope/);
});

test('diff and classify: added is additive, removed or changed is breaking, identical is none', () => {
  const a = doc();
  const same = diff(a, clone(a));
  assert.deepStrictEqual(same, { added: [], removed: [], changed: [] });
  assert.strictEqual(classify(same), 'none');

  const added = clone(a);
  added.paths['/tasks/{taskId}'].get = { operationId: 'getTask', responses: { 200: { description: 'ok', ...json({ $ref: '#/components/schemas/Task' }) }, 404: { description: 'none', ...json({ $ref: '#/components/schemas/Error' }) } } };
  assert.deepStrictEqual(diff(a, added), { added: ['getTask'], removed: [], changed: [] });
  assert.strictEqual(classify(diff(a, added)), 'additive');

  const removed = clone(a);
  delete removed.paths['/tasks/{taskId}'].delete;
  assert.deepStrictEqual(diff(a, removed).removed, ['deleteTask']);
  assert.strictEqual(classify(diff(a, removed)), 'breaking');

  const changed = clone(a);
  changed.components.schemas.Task.required.push('owner'); // reaches listTasks and createTask through $ref
  changed.components.schemas.Task.properties.owner = { type: 'string' };
  assert.deepStrictEqual(diff(a, changed).changed.sort(), ['createTask', 'listTasks']);
  assert.strictEqual(classify(diff(a, changed)), 'breaking');

  const moved = clone(a);
  moved.paths['/jobs'] = moved.paths['/tasks'];
  delete moved.paths['/tasks'];
  assert.ok(diff(a, moved).changed.includes('listTasks'), 'the same operationId on another path is a change');
});

test('a 5 MB document validates in under 5 seconds', () => {
  const d = doc();
  for (let i = 0; i < 4000; i++) {
    d.components.schemas[`Bulk${i}`] = { type: 'object', properties: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`field${k}`, { type: 'string', description: 'x'.repeat(20) }])) };
  }
  assert.ok(JSON.stringify(d).length > 4.5e6, 'the fixture must be about 5 MB');
  const t0 = Date.now();
  assert.deepStrictEqual(rules(d), []);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});
