'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { byPriority } = require('./tickets');

test('byPriority', () => {
  assert.deepStrictEqual(byPriority([{ priority: 1 }, { priority: 5 }])[0].priority, 5);
});
