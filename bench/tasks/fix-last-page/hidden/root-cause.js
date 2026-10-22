'use strict';
// The fix belongs in the shared function, not in a caller-side patch.
const fs = require('fs');
const paginate = fs.readFileSync('src/paginate.js', 'utf8');
const tickets = fs.readFileSync('src/tickets.js', 'utf8');
if (/start \+ size - 1/.test(paginate)) {
  console.error('FAIL: the off-by-one is still in src/paginate.js');
  process.exit(1);
}
if (/size\s*\+\s*1|\+ 1\)\s*$/m.test(tickets.split('\n').filter((l) => l.includes('paginate(')).join('\n'))) {
  console.error('FAIL: the caller compensates instead of fixing the shared function');
  process.exit(1);
}
const regression = fs.readdirSync('test').map((f) => fs.readFileSync(`test/${f}`, 'utf8')).join('\n');
if (!/paginate\(/.test(regression)) {
  console.error('FAIL: no regression test calls paginate()');
  process.exit(1);
}
console.log('OK: root cause fixed in the shared code with a regression test');
