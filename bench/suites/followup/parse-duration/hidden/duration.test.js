'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseDuration, formatDuration } = require('../src/time');

test('hidden: parseDuration', () => {
  assert.strictEqual(parseDuration('1h30m'), 5400000);
  assert.strictEqual(parseDuration('45s'), 45000);
  assert.strictEqual(parseDuration('2h'), 7200000);
  assert.strictEqual(parseDuration('1h5m10s'), 3910000);
  for (const bad of ['', 'h', '1x', '30m1h', '1.5h', '1h1h', ' 1h', 'abc']) assert.strictEqual(parseDuration(bad), null, JSON.stringify(bad));
  assert.strictEqual(formatDuration(parseDuration('1h5m10s')), '1h 5m 10s', 'existing helper must survive');
});
