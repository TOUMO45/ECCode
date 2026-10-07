'use strict';
// Unit tests for src/ticket-input.js (spec C3 validation table, C5 messages, C6.4, DES-5).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateTicketInput } = require('../../src/ticket-input.js');

const MSG = {
  invalid_request: 'Request body must be a JSON object with a string "ticket".',
  ticket_empty: 'Ticket text is empty.',
  ticket_too_long: 'Ticket text exceeds 8000 characters.',
};

function assertFail(result, code) {
  assert.deepEqual(result, { ok: false, status: 400, code, message: MSG[code] });
}

test('module exports exactly validateTicketInput', () => {
  assert.deepEqual(Object.keys(require('../../src/ticket-input.js')), ['validateTicketInput']);
});

test('valid ticket is returned trimmed', () => {
  assert.deepEqual(validateTicketInput({ ticket: '  My invoice is wrong.\n' }), { ok: true, ticket: 'My invoice is wrong.' });
  assert.deepEqual(validateTicketInput({ ticket: 'x' }), { ok: true, ticket: 'x' });
});

test('unknown extra keys are ignored', () => {
  assert.deepEqual(validateTicketInput({ ticket: 'hello', extra: 1, category: 'billing' }), { ok: true, ticket: 'hello' });
});

test('parsed value that is not a plain object → invalid_request', () => {
  for (const v of [null, [], ['ticket'], [{ ticket: 'x' }], 'ticket', '', 0, 42, true, false, undefined]) {
    assertFail(validateTicketInput(v), 'invalid_request');
  }
});

test('non-plain objects → invalid_request', () => {
  assertFail(validateTicketInput(new Date()), 'invalid_request');
  assertFail(validateTicketInput(new Map([['ticket', 'x']])), 'invalid_request');
  class Body { constructor() { this.ticket = 'x'; } }
  assertFail(validateTicketInput(new Body()), 'invalid_request');
});

test('null-prototype object with a string ticket is accepted', () => {
  const o = Object.create(null);
  o.ticket = ' hi ';
  assert.deepEqual(validateTicketInput(o), { ok: true, ticket: 'hi' });
});

test('ticket missing or not a string → invalid_request', () => {
  for (const v of [{}, { Ticket: 'x' }, { ticket: null }, { ticket: 5 }, { ticket: ['x'] }, { ticket: { text: 'x' } }, { ticket: true }]) {
    assertFail(validateTicketInput(v), 'invalid_request');
  }
});

test('inherited ticket property does not count', () => {
  const proto = { ticket: 'inherited' };
  const o = Object.create(proto);
  // prototype is not Object.prototype → not a plain object anyway
  assertFail(validateTicketInput(o), 'invalid_request');
  // JSON.parse gives an own __proto__ key, never a prototype change
  const parsed = JSON.parse('{"__proto__": {"ticket": "x"}}');
  assertFail(validateTicketInput(parsed), 'invalid_request');
});

test('empty or whitespace-only ticket → ticket_empty', () => {
  for (const t of ['', ' ', '\n\t  \r\n', ' ', ' ﻿']) {
    assertFail(validateTicketInput({ ticket: t }), 'ticket_empty');
  }
});

test('length boundary: 8000 after trim passes, 8001 fails', () => {
  const ok = 'a'.repeat(8000);
  assert.deepEqual(validateTicketInput({ ticket: '   ' + ok + '   ' }), { ok: true, ticket: ok });
  assertFail(validateTicketInput({ ticket: 'a'.repeat(8001) }), 'ticket_too_long');
});

test('length counts UTF-16 code units', () => {
  // '😀' is 2 code units: 4000 of them = 8000 units (ok), 4001 = 8002 (too long)
  assert.equal(validateTicketInput({ ticket: '😀'.repeat(4000) }).ok, true);
  assertFail(validateTicketInput({ ticket: '😀'.repeat(4000) + 'a' }), 'ticket_too_long');
});

test('first failure wins (ordering of the C3 table)', () => {
  // not an object beats everything else
  assertFail(validateTicketInput([' ']), 'invalid_request');
  // missing ticket beats emptiness of other keys
  assertFail(validateTicketInput({ text: '' }), 'invalid_request');
  // empty beats too long (cannot both hold) - a whitespace ticket longer than 8000 is empty, not too long
  assertFail(validateTicketInput({ ticket: ' '.repeat(9000) }), 'ticket_empty');
  // too long is decided after trim
  assert.equal(validateTicketInput({ ticket: ' '.repeat(5000) + 'a'.repeat(8000) + ' '.repeat(5000) }).ok, true);
});

test('pure: same input gives deep-equal output and input is not mutated', () => {
  const input = { ticket: '  same  ', other: { a: 1 } };
  const snapshot = JSON.stringify(input);
  const a = validateTicketInput(input);
  const b = validateTicketInput(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), snapshot);
  const f1 = validateTicketInput({ ticket: '' });
  const f2 = validateTicketInput({ ticket: '' });
  assert.deepEqual(f1, f2);
});

test('error results never echo the ticket', () => {
  const marker = 'TICKET-MARKER-55q';
  const r = validateTicketInput({ ticket: marker + 'a'.repeat(8001) });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(marker));
});
