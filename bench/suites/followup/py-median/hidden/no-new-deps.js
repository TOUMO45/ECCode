'use strict';
const fs = require('fs');
const text = fs.readFileSync('pyproject.toml', 'utf8');
const m = text.match(/dependencies\s*=\s*\[([^\]]*)\]/);
if (!m || m[1].trim() !== '') {
  console.error('FAIL: a dependency was added for a stdlib-sized task');
  process.exit(1);
}
console.log('OK: no dependencies');
