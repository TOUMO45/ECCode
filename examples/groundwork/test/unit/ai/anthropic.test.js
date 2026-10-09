import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAnthropicProvider } from '../../../src/ai/anthropic.js';
import { loadConfig } from '../../../src/config.js';
import { assertProvider } from '../../../src/ai/provider.js';

const draft = { summary: [{ text: 'First note: hi', cites: [1] }], impact: [], timeline: [], contributingFactors: [], actionItems: [] };
const ok = (text) => ({ status: 200, body: { id: 'm', model: 'claude-x', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } } });
let queue = [];
let seen = [];
let server;
let url;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const step = queue.shift() ?? ok(JSON.stringify(draft));
      const send = () => { res.writeHead(step.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(step.body)); };
      if (step.delay) setTimeout(send, step.delay); else send();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const mk = (over = {}, env = { ANTHROPIC_API_KEY: 'sk-test' }) => {
  queue = []; seen = [];
  const config = loadConfig({ GW_ANTHROPIC_URL: url });
  return createAnthropicProvider({ config, env, backoffMs: 5, ...over });
};
const input = { incident: { title: 'T', severity: 'SEV1', startedAt: 'x' }, lines: [{ n: 1, time: '10:00', author: 'a', text: 'hi' }] };

test('success: request shape, headers, usage', async () => {
  const p = mk();
  assertProvider(p);
  assert.equal(await p.available(), true);
  const r = await p.generate(input);
  assert.deepEqual(r.draft, draft);
  assert.equal(r.usage.inputTokens, 10);
  assert.equal(r.usage.model, 'claude-x');
  const s = seen[0];
  assert.equal(s.url, '/v1/messages');
  assert.equal(s.headers['x-api-key'], 'sk-test');
  assert.equal(s.headers['anthropic-version'], '2023-06-01');
  assert.equal(s.body.max_tokens, 4096);
  assert.equal(s.body.temperature, 0);
  assert.equal(s.body.model, 'claude-haiku-5-5');
  assert.equal(s.body.messages.length, 1);
  assert.match(s.body.messages[0].content, /^<<<GW_DATA_BEGIN id=/);
  assert.match(s.body.system, /DATA block/);
});

test('fenced JSON across several text blocks is accepted', async () => {
  const p = mk();
  queue = [{ status: 200, body: { content: [{ type: 'text', text: '```json\n' + JSON.stringify(draft).slice(0, 20) }, { type: 'text', text: JSON.stringify(draft).slice(20) + '\n```' }], usage: {} } }];
  assert.deepEqual((await p.generate(input)).draft, draft);
});

test('no key -> unavailable', async () => {
  const p = mk({}, {});
  assert.equal(await p.available(), false);
  await assert.rejects(p.generate(input), (e) => e.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(seen.length, 0);
});

test('500 then success retries with backoff; 429 maps to PROVIDER_BUSY when persistent', async () => {
  let p = mk();
  queue = [{ status: 500, body: {} }, ok(JSON.stringify(draft))];
  assert.equal((await p.generate(input)).usage.attempts, 2);
  p = mk();
  queue = [{ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} }];
  await assert.rejects(p.generate(input), (e) => e.code === 'PROVIDER_BUSY');
  assert.equal(seen.length, 3);
});

test('persistent 500 -> PROVIDER_UNAVAILABLE; 401 not retried', async () => {
  let p = mk();
  queue = [{ status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} }];
  await assert.rejects(p.generate(input), (e) => e.code === 'PROVIDER_UNAVAILABLE');
  p = mk();
  queue = [{ status: 401, body: {} }];
  await assert.rejects(p.generate(input), (e) => e.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(seen.length, 1);
});

test('slow response -> PROVIDER_TIMEOUT, no retry', async () => {
  const p = mk({ timeoutMs: 100 });
  queue = [{ ...ok('{}'), delay: 600 }];
  await assert.rejects(p.generate(input), (e) => e.code === 'PROVIDER_TIMEOUT');
  assert.equal(seen.length, 1);
});

test('malformed or schema-invalid output: one retry then PROVIDER_BAD_OUTPUT', async () => {
  const p = mk();
  queue = [ok('I cannot'), ok(JSON.stringify({ ...draft, status: 'verified' }))];
  await assert.rejects(p.generate(input), (e) => e.code === 'PROVIDER_BAD_OUTPUT');
  assert.equal(seen.length, 2);
});

test('connection refused -> PROVIDER_UNAVAILABLE and key never in logs', async () => {
  const recs = [];
  const config = loadConfig({ GW_ANTHROPIC_URL: 'http://127.0.0.1:1' });
  const p = createAnthropicProvider({ config, env: { ANTHROPIC_API_KEY: 'sk-leak' }, backoffMs: 1, log: (r) => recs.push(r) });
  await assert.rejects(p.generate(input), (e) => e.code === 'PROVIDER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(recs), /sk-leak/);
});
