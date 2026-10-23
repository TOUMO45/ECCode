'use strict';
const test = require('node:test');
const assert = require('node:assert');
const directory = require('../src/directory');
const { findPeople } = require('../src/app');

function people() {
  const dir = directory.create();
  directory.register(dir, 'ada', 'Ada Lovelace');
  directory.register(dir, 'grace', 'Grace Hopper');
  directory.register(dir, 'alan', 'Alan  Turing');
  return dir;
}

test('every word of the query must match', () => {
  assert.deepStrictEqual(findPeople(people(), 'Ada Lovelace'), ['ada']);
  assert.deepStrictEqual(findPeople(people(), 'Ada Hopper'), []);
});

test('whitespace in names and queries is collapsed', () => {
  assert.deepStrictEqual(findPeople(people(), '  Alan   Turing '), ['alan']);
});
