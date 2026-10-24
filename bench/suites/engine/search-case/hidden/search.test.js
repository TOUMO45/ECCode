'use strict';
const test = require('node:test');
const assert = require('node:assert');
const directory = require('../src/directory');
const { findPeople } = require('../src/app');
const { buildIndex, search } = require('../src/search');

function people() {
  const dir = directory.create();
  directory.register(dir, 'ada', 'Ada Lovelace');
  directory.register(dir, 'grace', 'Grace Hopper');
  directory.register(dir, 'Ada', 'Ada Byron');
  return dir;
}

test('search ignores case in the query and in names', () => {
  assert.deepStrictEqual(findPeople(people(), 'ada lovelace'), ['ada']);
  assert.deepStrictEqual(findPeople(people(), 'LOVELACE'), ['ada']);
  assert.deepStrictEqual(findPeople(people(), 'grace HOPPER'), ['grace']);
});

test('results are the original handles, in index order', () => {
  assert.deepStrictEqual(findPeople(people(), 'ADA'), ['ada', 'Ada']);
});

test('every word must still match', () => {
  assert.deepStrictEqual(findPeople(people(), 'ada hopper'), []);
});

test('the index API keeps working on its own', () => {
  const index = buildIndex([{ id: 1, text: 'Red Fox' }, { id: 2, text: 'red panda' }]);
  assert.deepStrictEqual(search(index, 'RED'), [1, 2]);
  assert.deepStrictEqual(search(index, 'fox'), [1]);
  assert.deepStrictEqual(search(index, '   '), []);
});
