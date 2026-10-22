'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { slugify, normalize } = require('../src/text');

test('hidden: slugify', () => {
  assert.strictEqual(slugify('  Hello,  World! '), 'hello-world');
  assert.strictEqual(slugify('Rust & Go: a 2026 review'), 'rust-go-a-2026-review');
  assert.strictEqual(slugify('---'), '');
  assert.strictEqual(typeof normalize, 'function', 'existing helper must survive');
});
