'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { dedupeById } = require('../src/tickets');

test('hidden: dedupeById keeps the last occurrence per id', () => {
  const out = dedupeById([
    { id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 1, v: 'c' }, { id: 3, v: 'd' }, { id: 2, v: 'e' },
  ]);
  assert.deepStrictEqual(out, [{ id: 1, v: 'c' }, { id: 2, v: 'e' }, { id: 3, v: 'd' }]);
  assert.deepStrictEqual(dedupeById([]), []);
  assert.deepStrictEqual(dedupeById([{ id: 7, v: 'x' }]), [{ id: 7, v: 'x' }]);
});
