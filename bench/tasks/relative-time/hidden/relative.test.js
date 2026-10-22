'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatRelative } = require('../src/format');
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = 1700000000000;

test('hidden: formatRelative', () => {
  assert.strictEqual(formatRelative(now - 10000, now), 'just now');
  assert.strictEqual(formatRelative(now - MIN, now), '1 minute ago');
  assert.strictEqual(formatRelative(now - 5 * MIN, now), '5 minutes ago');
  assert.strictEqual(formatRelative(now + 2 * MIN, now), 'in 2 minutes');
  assert.strictEqual(formatRelative(now - 3 * HOUR - 10 * MIN, now), '3 hours ago');
  assert.strictEqual(formatRelative(now + HOUR, now), 'in 1 hour');
  assert.strictEqual(formatRelative(now - 3 * DAY, now), '3 days ago');
  assert.strictEqual(formatRelative(now + 10 * DAY, now), 'in 10 days');
});
