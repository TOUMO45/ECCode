import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_KEYS, MAX_STRING, cleanString, createLogger } from '../../../src/log.js';
import { fixedClock } from '../../../src/clock.js';

function capture(options = {}) {
  const lines = [];
  const log = createLogger({ write: (line) => lines.push(line), clock: fixedClock(Date.UTC(2026, 9, 20, 7, 30, 0)), ...options });
  return { lines, log, entries: () => lines.map((l) => JSON.parse(l)) };
}

test('NFR6: every log line is one JSON object with ts, level, msg and requestId', () => {
  const { log, lines, entries } = capture({ requestId: 'boot-0001' });
  log.info('http.request', { status: 200 });
  log.warn('auth.throttled', {});
  log.error('http.error', { code: 'INTERNAL' });
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(line.endsWith('\n'));
    assert.equal(line.trim().split('\n').length, 1);
  }
  const [a, b, c] = entries();
  assert.equal(a.ts, '2026-10-20T07:30:00.000Z');
  assert.deepEqual([a.level, b.level, c.level], ['info', 'warn', 'error']);
  assert.deepEqual([a.msg, b.msg, c.msg], ['http.request', 'auth.throttled', 'http.error']);
  for (const e of [a, b, c]) assert.equal(e.requestId, 'boot-0001');
});

test('NFR6: a line without a request id still gets one, and child loggers use their own', () => {
  const { log, entries } = capture();
  log.info('reconcile.tick');
  const child = log.child('rc-abc123');
  child.info('reconcile.tick');
  child.info('reconcile.tick', { requestId: 'override-77' });
  const [root, tick, override] = entries();
  assert.match(root.requestId, /^sys-[0-9a-f]{8}$/);
  assert.equal(tick.requestId, 'rc-abc123');
  assert.equal(override.requestId, 'override-77');
  // An unusable request id is replaced, never written as given.
  child.info('x', { requestId: 'bad id\nwith newline' });
  assert.equal(entries()[3].requestId, 'rc-abc123');
});

test('T21: keys outside the allow-list are dropped', () => {
  const { log, entries } = capture();
  log.info('provider.call', {
    status: 200,
    password: 'hunter2',
    token: 'abc',
    authorization: 'Bearer x',
    body: '{"a":1}',
    payer: { email: 'x@example.com' },
    rawText: 'I need 200 cups',
    ts: 'forged',
    level: 'forged',
    msg: 'forged',
    code: 'OK',
  });
  const entry = entries()[0];
  assert.equal(entry.status, 200);
  assert.equal(entry.code, 'OK');
  for (const dropped of ['password', 'token', 'authorization', 'body', 'payer', 'rawText']) assert.ok(!(dropped in entry), dropped);
  assert.equal(entry.msg, 'provider.call');
  assert.equal(entry.level, 'info');
  assert.equal(entry.ts, '2026-10-20T07:30:00.000Z');
  assert.doesNotMatch(JSON.stringify(entry), /hunter2|x@example\.com|200 cups/);
});

test('T21: the allow-list is exactly the Observability list (plus port)', () => {
  const spec = [
    'route', 'method', 'status', 'durationMs', 'userId', 'role', 'requestRef', 'planVersionId', 'reservationId', 'supplierOrderId',
    'paymentOperationId', 'providerCallId', 'operationKey', 'kind', 'providerStatus', 'httpStatus', 'code', 'attempt', 'epoch',
    'executorId', 'provider', 'model', 'costUsd', 'latencyMs', 'schemaOk', 'counts',
  ];
  for (const key of spec) assert.ok(ALLOWED_KEYS.has(key), key);
  assert.deepEqual([...ALLOWED_KEYS].filter((k) => !spec.includes(k)), ['port']);
});

test('T21: string values are truncated to 120 characters', () => {
  const { log, entries } = capture();
  log.info('x', { route: 'r'.repeat(500), code: 'c'.repeat(120), kind: 'k'.repeat(121) });
  const e = entries()[0];
  assert.equal(e.route.length, MAX_STRING);
  assert.equal(e.code.length, 120);
  assert.equal(e.kind.length, 120);
  // Truncation counts characters, not UTF-16 units, so no surrogate pair is cut in half.
  assert.equal(cleanString('\u{1F600}'.repeat(200)), '\u{1F600}'.repeat(120));
});

test('T21: control characters are stripped, so a value cannot forge a log line', () => {
  const { log, lines, entries } = capture();
  log.info('x', {
    route: 'a\nb\r\nc\td\u0000e\u001bf\u007fg\u0085h\u2028i\u2029j',
    code: '{"level":"error","msg":"forged"}\n{"msg":"second line"}',
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].trim().split('\n').length, 1, 'still exactly one physical line');
  const e = entries()[0];
  assert.equal(e.route, 'abcdefghij');
  assert.equal(entries().length, 1);
  assert.doesNotMatch(lines[0], /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/);
  assert.equal(cleanString('line1\nline2'), 'line1line2');
});

test('T21: msg is cleaned the same way', () => {
  const { log, entries } = capture();
  log.info('evil\nmsg\u0000'.repeat(40));
  const e = entries()[0];
  assert.ok(e.msg.length <= MAX_STRING);
  assert.doesNotMatch(e.msg, /\n|\u0000/);
});

test('values: numbers must be finite, booleans and null pass, objects and arrays are dropped except counts', () => {
  const { log, entries } = capture();
  log.info('x', {
    durationMs: 12.5,
    latencyMs: Infinity,
    attempt: NaN,
    schemaOk: true,
    epoch: null,
    role: { nested: 'object' },
    model: ['a', 'b'],
    provider: () => 'fn',
    counts: { plans: 2, rejected: 3, bad: 'text', worse: NaN },
  });
  const e = entries()[0];
  assert.equal(e.durationMs, 12.5);
  assert.ok(!('latencyMs' in e));
  assert.ok(!('attempt' in e));
  assert.equal(e.schemaOk, true);
  assert.equal(e.epoch, null);
  assert.ok(!('role' in e) && !('model' in e) && !('provider' in e));
  assert.deepEqual(e.counts, { plans: 2, rejected: 3 });
});

test('counts accepts only plain objects of numbers, capped in size', () => {
  const { log, entries } = capture();
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
  log.info('x', { counts: many });
  log.info('x', { counts: new Map([['a', 1]]) });
  log.info('x', { counts: [1, 2] });
  const [first, second, third] = entries();
  assert.equal(Object.keys(first.counts).length, 20);
  assert.ok(!('counts' in second));
  assert.ok(!('counts' in third));
});

test('the logger never throws, even when the sink or the fields misbehave', () => {
  const throwing = createLogger({ write: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => throwing.info('x', { status: 1 }));
  const { log, entries } = capture();
  const hostile = { get status() { throw new Error('getter'); } };
  assert.doesNotThrow(() => log.info('x', hostile));
  assert.doesNotThrow(() => log.info('x', null));
  assert.doesNotThrow(() => log.info('x', 'a string'));
  assert.equal(entries().filter((e) => e.msg === 'x').length >= 2, true);
});
