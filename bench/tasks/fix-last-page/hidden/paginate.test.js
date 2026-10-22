'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { paginate } = require('../src/paginate');

test('hidden: pages are complete', () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  assert.deepStrictEqual(paginate(items, 1, 3), [1, 2, 3]);
  assert.deepStrictEqual(paginate(items, 2, 3), [4, 5, 6]);
  assert.deepStrictEqual(paginate(items, 3, 3), [7]);
  assert.deepStrictEqual(paginate(items, 4, 3), []);
  assert.deepStrictEqual(paginate([], 1, 3), []);
});
