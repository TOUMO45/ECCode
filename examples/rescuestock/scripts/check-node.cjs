/* RescueStock Node version gate (F-TR-4).
 *
 * Runs with no flags before every npm script that passes a version-specific
 * flag to node. Node parses its command-line flags before any script runs, so
 * a check inside the application cannot be reached on a Node that rejects the
 * flag. This file is CommonJS in ES5 syntax on purpose, so that any Node that
 * can start can parse it. Do not add modern syntax here.
 */
'use strict';

var FLOOR = [22, 13, 0];
var FLOOR_TEXT = '22.13';

function parse(version) {
  var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function meetsFloor(version) {
  var v = parse(version);
  if (!v) return false;
  for (var i = 0; i < 3; i++) {
    if (v[i] > FLOOR[i]) return true;
    if (v[i] < FLOOR[i]) return false;
  }
  return true;
}

function message(version) {
  return 'RescueStock needs Node >= ' + FLOOR_TEXT + ' (found ' + version + '). See README.';
}

function check(version) {
  if (meetsFloor(version)) return { ok: true, message: '' };
  return { ok: false, message: message(version) };
}

module.exports = { check: check, meetsFloor: meetsFloor, message: message, FLOOR_TEXT: FLOOR_TEXT };

if (require.main === module) {
  var result = check(process.versions.node);
  if (!result.ok) {
    process.stderr.write(result.message + '\n');
    process.exitCode = 1;
  }
}
