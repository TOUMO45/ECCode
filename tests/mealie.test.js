'use strict';
// The Mealie pilot suite (bench/suites/mealie): ten real changes to Mealie,
// run as work items on one record. No Mealie file lives in this repository:
// tasks name upstream commits and the harness exports what it needs from a
// local mirror. Live checks need ECCODE_MEALIE_VALIDATE=1 and the
// environments from _tools/setup.sh in ECCODE_MEALIE_ENVS.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const TOOLS = path.join(__dirname, '..', 'bench', 'suites', 'mealie', '_tools');

test('mealie env: envKey is stable and 12 hex characters', () => {
  const { envKey } = require(path.join(TOOLS, 'env.js'));
  assert.strictEqual(envKey('a'), envKey('a'));
  assert.match(envKey('a'), /^[0-9a-f]{12}$/);
  assert.notStrictEqual(envKey('a'), envKey('b'));
});
