'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalize } = require('./text');

test('normalize', () => {
  assert.strictEqual(normalize('  A  B\tC '), 'a b c');
});
