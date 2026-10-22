'use strict';
// A Map does this in a few lines; a library for it is the bloat this measures.
const pkg = require('../package.json');
const n = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length;
if (n > 0) {
  console.error(`FAIL: ${n} dependenc(ies) added for a Map-sized task`);
  process.exit(1);
}
console.log('OK: no dependencies');
