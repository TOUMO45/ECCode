'use strict';
// Reference solution for bench/suites/followup/parse-duration (run inside the sandbox).
const fs = require('fs');
const src = fs.readFileSync('src/time.js', 'utf8').replace('module.exports = { UNITS, formatDuration };', [
  '/** "1h30m", "45s", "1h5m10s" to milliseconds; null for anything else. */',
  'function parseDuration(text) {',
  '  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(String(text));',
  '  if (!m || !text) return null;',
  '  return Number(m[1] || 0) * UNITS.h + Number(m[2] || 0) * UNITS.m + Number(m[3] || 0) * UNITS.s;',
  '}',
  '',
  'module.exports = { UNITS, formatDuration, parseDuration };',
].join('\n'));
fs.writeFileSync('src/time.js', src);
fs.appendFileSync('src/time.test.js', "\ntest('parseDuration', () => {\n  assert.strictEqual(require('./time').parseDuration('1m'), 60000);\n});\n");
