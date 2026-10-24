'use strict';
const test = require('node:test');
const assert = require('node:assert');
const directory = require('../src/directory');
const { normalize } = require('../src/text');

test('handles stay case-sensitive: Ada and ada are two people', () => {
  const dir = directory.create();
  directory.register(dir, 'ada', 'Ada Lovelace');
  directory.register(dir, 'Ada', 'Ada Byron');
  assert.strictEqual(directory.lookup(dir, 'Ada').name, 'Ada Byron');
  assert.strictEqual(directory.lookup(dir, 'ada').name, 'Ada Lovelace');
  assert.strictEqual(directory.lookup(dir, 'ADA'), null);
  assert.strictEqual(directory.all(dir).length, 2);
});

test('names keep their case and handles are still trimmed', () => {
  const dir = directory.create();
  const p = directory.register(dir, '  Grace ', 'Grace Hopper');
  assert.deepStrictEqual(p, { handle: 'Grace', name: 'Grace Hopper' });
  assert.throws(() => directory.register(dir, 'Grace', 'x'), /taken/);
});

test('normalize keeps its contract', () => {
  assert.strictEqual(normalize('  Ada   Lovelace '), 'Ada Lovelace');
});
