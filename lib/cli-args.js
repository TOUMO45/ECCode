'use strict';
// Tiny argv parser: positionals, --flag value, --flag=value, --bool, repeatable
// flags become arrays, and everything after a bare "--" is kept verbatim.
// Any other flag given twice is refused: with "last one wins", a command could
// show one --actor to a reader (or the guard hook) and act as another.

const { EccodeError } = require('./util');

const REPEATABLE = new Set(['artifact', 'lesson', 'env', 'evidence']);
const BOOLEAN = new Set(['json', 'brief', 'all', 'history', 'force', 'dry-run', 'expect-fail', 'help', 'check-env', 'include-superseded', 'regression', 'no-hooks', 'no-usage', 'verify']);

function parseArgs(argv) {
  const out = { _: [], flags: {}, rest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (BOOLEAN.has(key)) {
        val = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        val = argv[++i];
      } else {
        val = true;
      }
      if (REPEATABLE.has(key)) (out.flags[key] = out.flags[key] || []).push(val);
      else if (Object.prototype.hasOwnProperty.call(out.flags, key)) throw new EccodeError('USAGE', `--${key} given more than once`);
      else out.flags[key] = val;
    } else {
      out._.push(a);
    }
  }
  return out;
}

module.exports = { parseArgs };
