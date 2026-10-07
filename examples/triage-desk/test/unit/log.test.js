'use strict';
// Unit tests for src/log.js (spec C6.2, D1.6, DES-1, DES-6; Security T6).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLogger } = require('../../src/log.js');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQUEST_KEYS = ['t', 'event', 'rid', 'method', 'route', 'status', 'ms', 'errorCode', 'ticketLength', 'source',
  'fallbackReason', 'injectionSuspected', 'redactions', 'upstreamStatus', 'detail', 'usage'];

function capture() {
  const lines = [];
  const log = createLogger((l) => lines.push(l));
  return { log, lines, records: () => lines.map((l) => JSON.parse(l)) };
}

test('writes exactly one single-line JSON string per call (no trailing newline passed to write)', () => {
  const { log, lines } = capture();
  log.request({ rid: 'a1b2c3d4', method: 'GET', route: '/api/health', status: 200, ms: 1 });
  log.event('warning', { code: 'custom_base_url' });
  log.error({ rid: 'a1b2c3d4', errorCode: 'internal_error', errorName: 'TypeError' });
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.equal(typeof l, 'string');
    assert.ok(!l.includes('\n'), 'single line');
    JSON.parse(l);
  }
});

test('default writer writes to stdout with a newline', () => {
  const original = process.stdout.write;
  const out = [];
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try {
    createLogger().event('warning', { code: 'non_loopback_host' });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith('\n'));
  assert.equal(JSON.parse(out[0]).code, 'non_loopback_host');
});

test('request record: full D1.6 key set in order, triage fields copied', () => {
  const { log, records } = capture();
  log.request({
    rid: 'a1b2c3d4', method: 'POST', route: '/api/triage', status: 200, ms: 12, errorCode: null,
    ticketLength: 345, source: 'fallback', fallbackReason: 'no_api_key', injectionSuspected: false,
    redactions: { email: 1, card: 0, phone: 2 }, upstreamStatus: null, detail: null, usage: null,
  });
  const [r] = records();
  assert.deepEqual(Object.keys(r), REQUEST_KEYS);
  assert.match(r.t, ISO);
  assert.deepEqual({ ...r, t: 'T' }, {
    t: 'T', event: 'request', rid: 'a1b2c3d4', method: 'POST', route: '/api/triage', status: 200, ms: 12,
    errorCode: null, ticketLength: 345, source: 'fallback', fallbackReason: 'no_api_key', injectionSuspected: false,
    redactions: { email: 1, card: 0, phone: 2 }, upstreamStatus: null, detail: null, usage: null,
  });
});

test('request record: missing fields are null; live fields copied', () => {
  const { log, records } = capture();
  log.request({ rid: 'deadbeef', method: 'GET', route: '/', status: 200, ms: 0 });
  log.request({
    rid: 'deadbeef', method: 'POST', route: '/api/triage', status: 200, ms: 900, ticketLength: 10, source: 'model',
    fallbackReason: null, injectionSuspected: true, redactions: { email: 0, card: 1, phone: 0 }, upstreamStatus: 200,
    detail: 'invalid:summary_v1,reply_v2', usage: { inputTokens: 512, outputTokens: 64 },
  });
  const [a, b] = records();
  assert.deepEqual(Object.keys(a), REQUEST_KEYS);
  for (const k of REQUEST_KEYS.slice(7)) assert.equal(a[k], null, k);
  assert.equal(b.source, 'model');
  assert.equal(b.upstreamStatus, 200);
  assert.equal(b.detail, 'invalid:summary_v1,reply_v2');
  assert.deepEqual(b.usage, { inputTokens: 512, outputTokens: 64 });
  assert.equal(b.injectionSuspected, true);
});

test('allowlist drops unknown fields (ticket text, headers, url, key, message, stack)', () => {
  const { log, lines } = capture();
  const marker = 'LOG-MARKER-q7';
  log.request({
    rid: 'a1b2c3d4', method: 'POST', route: '/api/triage', status: 200, ms: 3,
    ticket: marker, text: marker, summary: marker, suggestedReply: marker, url: '/api/triage?' + marker,
    host: marker + '.example', headers: { host: marker }, apiKey: marker, message: marker, stack: marker,
    redactions: { email: 0, card: 0, phone: 0, sample: marker },
    usage: { inputTokens: 1, outputTokens: 2, raw: marker },
  });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(marker), 'no unknown field reaches the log');
  const r = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(r), REQUEST_KEYS);
  assert.deepEqual(r.redactions, { email: 0, card: 0, phone: 0 });
  assert.deepEqual(r.usage, { inputTokens: 1, outputTokens: 2 });
});

test('allowlisted keys with content-bearing values are dropped to null or normalised', () => {
  const { log, lines } = capture();
  const marker = 'Leak me please 4111 1111 1111 1111';
  log.request({
    rid: marker, method: marker, route: marker, status: marker, ms: marker, errorCode: marker,
    ticketLength: marker, source: marker, fallbackReason: marker, injectionSuspected: marker,
    redactions: marker, upstreamStatus: marker, detail: marker, usage: marker,
  });
  assert.ok(!lines[0].includes('Leak me'));
  const r = JSON.parse(lines[0]);
  assert.equal(r.method, 'OTHER');
  assert.equal(r.route, 'other');
  for (const k of ['rid', 'status', 'ms', 'errorCode', 'ticketLength', 'source', 'fallbackReason', 'injectionSuspected',
    'redactions', 'upstreamStatus', 'detail', 'usage']) {
    assert.equal(r[k], null, k);
  }
});

test('method is one of the D1.6 set or OTHER; route is a known path or other', () => {
  const { log, records } = capture();
  for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'PROPFIND', 'get']) {
    log.request({ method: m, route: '/' });
  }
  const methods = records().map((r) => r.method);
  assert.deepEqual(methods, ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'OTHER', 'OTHER', 'OTHER']);
  const { log: log2, records: rec2 } = capture();
  for (const p of ['/', '/index.html', '/app.js', '/styles.css', '/api/health', '/api/triage', '/../package.json', '/favicon.ico']) {
    log2.request({ method: 'GET', route: p });
  }
  assert.deepEqual(rec2().map((r) => r.route),
    ['/', '/index.html', '/app.js', '/styles.css', '/api/health', '/api/triage', 'other', 'other']);
});

test('error event carries only rid, errorCode and errorName (no message or stack)', () => {
  const { log, lines, records } = capture();
  const err = new SyntaxError('Unexpected token S in JSON at position 0: "SECRET TICKET TEXT"');
  log.error({ rid: 'a1b2c3d4', errorCode: 'internal_error', errorName: err.name, message: err.message, stack: err.stack, error: err });
  const [r] = records();
  assert.deepEqual(Object.keys(r), ['t', 'event', 'rid', 'errorCode', 'errorName']);
  assert.deepEqual({ ...r, t: 'T' }, { t: 'T', event: 'error', rid: 'a1b2c3d4', errorCode: 'internal_error', errorName: 'SyntaxError' });
  assert.ok(!lines[0].includes('SECRET'));
  assert.ok(!lines[0].includes('Unexpected token'));
  assert.ok(!lines[0].includes('at '), 'no stack frames');
});

test('error event: a non-identifier errorName is not copied verbatim', () => {
  const { log, lines, records } = capture();
  log.error({ rid: 'a1b2c3d4', errorCode: 'internal_error', errorName: 'Error: ticket says hello world' });
  assert.ok(!lines[0].includes('hello'));
  assert.equal(records()[0].errorName, 'Error');
});

test('listening event carries baseUrlCustom and no URL', () => {
  const { log, lines, records } = capture();
  log.event('listening', {
    host: '127.0.0.1', port: 3000, mode: 'live', model: 'claude-haiku-5-5', timeoutMs: 20000, maxTokens: 2048,
    baseUrlCustom: true, baseUrl: 'https://gateway.example/secret-path', apiKey: 'test-key-FAKE', url: 'http://x',
  });
  const [r] = records();
  assert.deepEqual(Object.keys(r), ['t', 'event', 'host', 'port', 'mode', 'model', 'timeoutMs', 'maxTokens', 'baseUrlCustom']);
  assert.deepEqual({ ...r, t: 'T' }, {
    t: 'T', event: 'listening', host: '127.0.0.1', port: 3000, mode: 'live', model: 'claude-haiku-5-5',
    timeoutMs: 20000, maxTokens: 2048, baseUrlCustom: true,
  });
  assert.ok(!lines[0].includes('gateway.example'));
  assert.ok(!lines[0].includes('test-key-FAKE'));
  assert.ok(!lines[0].includes('http'));
});

test('listening event in fallback mode: model null, baseUrlCustom false', () => {
  const { log, records } = capture();
  log.event('listening', { host: '::1', port: 0, mode: 'fallback', model: null, timeoutMs: 300, maxTokens: 256, baseUrlCustom: false });
  const [r] = records();
  assert.equal(r.mode, 'fallback');
  assert.equal(r.model, null);
  assert.equal(r.baseUrlCustom, false);
  assert.equal(r.host, '::1');
});

test('warning event carries only code', () => {
  const { log, records } = capture();
  log.event('warning', { code: 'non_loopback_host', host: '0.0.0.0', message: 'exposed' });
  log.event('warning', { code: 'custom_base_url', baseUrl: 'https://gateway.example' });
  const rs = records();
  for (const r of rs) assert.deepEqual(Object.keys(r), ['t', 'event', 'code']);
  assert.deepEqual(rs.map((r) => r.code), ['non_loopback_host', 'custom_base_url']);
});

test('warning event with an unknown code writes code null', () => {
  const { log, records } = capture();
  log.event('warning', { code: 'something else entirely' });
  assert.equal(records()[0].code, null);
});

test('event() refuses unknown event names instead of serialising them', () => {
  const { log, lines } = capture();
  assert.throws(() => log.event('ticket', { text: 'x' }), TypeError);
  assert.throws(() => log.event('request', {}), TypeError);
  assert.equal(lines.length, 0);
});

test('fields argument may be omitted or non-object', () => {
  const { log, records } = capture();
  log.request();
  log.request(null);
  log.event('warning');
  log.error('boom');
  const rs = records();
  assert.equal(rs.length, 4);
  assert.equal(rs[0].event, 'request');
  assert.equal(rs[3].event, 'error');
  assert.equal(rs[3].errorName, null);
});

test('t is the current time in ISO format', () => {
  const { log, records } = capture();
  const before = Date.now();
  log.request({});
  const after = Date.now();
  const t = Date.parse(records()[0].t);
  assert.ok(t >= before - 1 && t <= after + 1);
});
