'use strict';
// The standard library covers this task; a dependency for it is the bloat this measures.
const text = require('fs').readFileSync(require('path').join(__dirname, '..', 'pyproject.toml'), 'utf8');
if (!/dependencies = \[\]/.test(text)) {
  console.error('FAIL: a dependency was added for a standard-library task');
  process.exit(1);
}
console.log('OK: no dependencies');
