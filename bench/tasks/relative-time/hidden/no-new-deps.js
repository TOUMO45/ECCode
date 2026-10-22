'use strict';
// The platform has everything this task needs: any new dependency fails.
const pkg = require('../package.json');
const n = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length;
if (n > 0) {
  console.error(`FAIL: ${n} dependenc(ies) added for a task the platform covers`);
  process.exit(1);
}
console.log('OK: no dependencies');
