'use strict';
// The standard library covers this task; a dependency for it is the bloat this measures.
const pkg = require('../package.json');
const n = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length;
if (n > 0) {
  console.error(`FAIL: ${n} dependenc(ies) added for a standard-library task`);
  process.exit(1);
}
console.log('OK: no dependencies');
