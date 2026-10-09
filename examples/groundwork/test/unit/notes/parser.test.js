import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotes } from '../../../src/notes/parser.js';

const text = (content) => parseNotes({ format: 'text', content });

test('parses HH:MM, HH:MM:SS, ISO and bracketed forms', () => {
  const r = text('14:05 alice: restarted db\n[14:06:30] bob: saw errors\n2026-10-08T14:07:09.5Z carol: rolled back\n[2026-10-08 14:08] dan x: ok: fine');
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.map((l) => [l.n, l.time, l.ts, l.author, l.text]), [
    [1, '14:05', null, 'alice', 'restarted db'],
    [2, '14:06', null, 'bob', 'saw errors'],
    [3, '14:07', '2026-10-08T14:07:09.5Z', 'carol', 'rolled back'],
    [4, '14:08', '2026-10-08 14:08', 'dan x', 'ok: fine'],
  ]);
});

test('blank lines do not consume numbers; errors use physical line numbers', () => {
  const ok = text('\n14:05 a: x\n\n\n14:06 b: y\n');
  assert.deepEqual(ok.lines.map((l) => l.n), [1, 2]);
  const bad = text('14:05 a: x\n\n\nnot a note\n\n25:00 b: y\n14:09 c: \u0001z');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => e.line), [4, 6, 7]);
  assert.equal(bad.total, 3);
});

test('CRLF input is accepted', () => {
  assert.equal(text('14:05 a: x\r\n14:06 b: y\r\n').lines.length, 2);
});

test('limits: 2000 lines ok, 2001 rejected; text 2000 ok, 2001 rejected', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => `10:00 a: line ${i}`).join('\n');
  assert.equal(text(mk(2000)).ok, true);
  const over = text(mk(2001));
  assert.equal(over.ok, false);
  assert.equal(over.errors[0].line, 2001);
  assert.equal(text(`10:00 a: ${'x'.repeat(2000)}`).ok, true);
  assert.equal(text(`10:00 a: ${'x'.repeat(2001)}`).ok, false);
  assert.equal(text(`10:00 ${'a'.repeat(65)}: hi`).ok, false);
});

test('error list is capped at 20 with the true total', () => {
  const r = text(Array.from({ length: 30 }, () => 'junk').join('\n'));
  assert.equal(r.errors.length, 20);
  assert.equal(r.total, 30);
});

test('invalid times and dates are rejected', () => {
  for (const t of ['24:00', '12:60', '2026-02-30T10:00Z', '2026-10-08T25:00Z']) {
    assert.equal(text(`${t} a: x`).ok, false, t);
  }
  assert.equal(text('00:00 a: x').ok, true);
  assert.equal(text('23:59:59 a: x').ok, true);
});

test('control characters rejected, tab allowed', () => {
  assert.equal(text('10:00 a: x\u0007y').ok, false);
  assert.equal(text('10:00 a: x\ty').ok, true);
});

test('empty input is rejected', () => {
  assert.equal(text('  \n\n').ok, false);
  assert.equal(parseNotes({ format: 'json', content: [] }).ok, false);
});

test('json format with index+1 error lines', () => {
  const r = parseNotes({ format: 'json', content: [
    { time: '14:05', author: 'a', text: 'x' },
    { time: '99:99', author: 'a', text: 'x' },
    { time: '14:05', author: '', text: 'x' },
    'nope',
    { time: '14:05', author: 'a', text: 'x', extra: 1 },
  ] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3, 4, 5]);
  const good = parseNotes({ format: 'json', content: [{ time: '2026-10-08T01:02:03Z', author: 'a', text: 'x' }] });
  assert.deepEqual(good.lines, [{ n: 1, time: '01:02', ts: '2026-10-08T01:02:03Z', author: 'a', text: 'x' }]);
});

test('unknown format and wrong content type rejected', () => {
  assert.equal(parseNotes({ format: 'xml', content: '' }).ok, false);
  assert.equal(parseNotes({ format: 'text', content: [] }).ok, false);
  assert.equal(parseNotes(null).ok, false);
});

test('re-parse is idempotent and does not mutate input', () => {
  const input = { format: 'json', content: [{ time: '14:05', author: ' a ', text: ' x ' }] };
  const snap = structuredClone(input);
  assert.deepEqual(parseNotes(input), parseNotes(input));
  assert.deepEqual(input, snap);
});
