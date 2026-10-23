'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { topWords, words } = require('../src/text');

test('hidden: topWords', () => {
  assert.deepStrictEqual(topWords('The cat and the hat. THE end!', 2), [['the', 3], ['and', 1]]);
  assert.deepStrictEqual(topWords('b a c b a', 3), [['a', 2], ['b', 2], ['c', 1]]);
  assert.deepStrictEqual(topWords('one', 5), [['one', 1]]);
  assert.deepStrictEqual(topWords('', 3), []);
  assert.strictEqual(typeof words, 'function', 'existing helper must survive');
});
