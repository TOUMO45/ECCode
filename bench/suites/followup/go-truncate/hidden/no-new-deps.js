'use strict';
const fs = require('fs');
if (/require/.test(fs.readFileSync('go.mod', 'utf8'))) {
  console.error('FAIL: a module dependency was added for a standard-library task');
  process.exit(1);
}
console.log('OK: no dependencies');
