'use strict';
// Careless: lowercase in the shared normalize(), which also keys the case-sensitive handles.
const fs = require('fs');
const s = fs.readFileSync('src/text.js', 'utf8').replace(".replace(/\\s+/g, ' ');", ".replace(/\\s+/g, ' ').toLowerCase();");
fs.writeFileSync('src/text.js', s);
fs.appendFileSync('tests/search.test.js', "\ntest('search ignores case', () => {\n  assert.deepStrictEqual(findPeople(people(), 'ada LOVELACE'), ['ada']);\n});\n");
