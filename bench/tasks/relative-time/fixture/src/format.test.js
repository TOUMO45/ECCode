'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { plural, formatDate } = require('./format');

test('plural', () => {
  assert.strictEqual(plural(1, 'day'), '1 day');
  assert.strictEqual(plural(3, 'day'), '3 days');
});

test('formatDate', () => {
  assert.strictEqual(formatDate(0), '1970-01-01');
});
