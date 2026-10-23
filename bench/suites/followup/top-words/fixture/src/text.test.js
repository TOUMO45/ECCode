'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { words, readingMinutes } = require('./text');

test('words', () => {
  assert.deepStrictEqual(words("It's a dog-eat-dog day!"), ["it's", 'a', 'dog', 'eat', 'dog', 'day']);
});

test('readingMinutes', () => {
  assert.strictEqual(readingMinutes('short'), 1);
});
