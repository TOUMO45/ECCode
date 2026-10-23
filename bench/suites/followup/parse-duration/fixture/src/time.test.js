'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatDuration } = require('./time');

test('formatDuration', () => {
  assert.strictEqual(formatDuration(3910000), '1h 5m 10s');
  assert.strictEqual(formatDuration(0), '0s');
});
