'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pageCount } = require('../src/paginate');

test('pageCount', () => {
  assert.strictEqual(pageCount(10, 3), 4);
});
