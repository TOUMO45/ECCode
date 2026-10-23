'use strict';
const test = require('node:test');
const assert = require('node:assert');
const directory = require('../src/directory');

test('register and look up by handle', () => {
  const dir = directory.create();
  directory.register(dir, ' ada ', 'Ada Lovelace');
  assert.strictEqual(directory.lookup(dir, 'ada').name, 'Ada Lovelace');
  assert.throws(() => directory.register(dir, 'ada', 'Someone Else'), /taken/);
});
