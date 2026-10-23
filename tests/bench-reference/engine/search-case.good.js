'use strict';
// Good: search folds case on its own words; the shared normalize() keeps case for handles.
const fs = require('fs');
let s = fs.readFileSync('src/search.js', 'utf8');
s = s.replace("const { tokens } = require('./text');", "const { tokens } = require('./text');\n\n/** Search compares words without case; handles elsewhere stay case-sensitive. */\nconst words = (s) => tokens(s).map((w) => w.toLowerCase());");
s = s.replace('for (const word of tokens(doc.text))', 'for (const word of words(doc.text))').replace('const words = tokens(query);', 'const terms = words(query);').replace('if (!words.length) return [];', 'if (!terms.length) return [];').replace('for (const word of words) {', 'for (const word of terms) {');
fs.writeFileSync('src/search.js', s);
fs.appendFileSync('tests/search.test.js', "\ntest('search ignores case', () => {\n  assert.deepStrictEqual(findPeople(people(), 'ada LOVELACE'), ['ada']);\n});\n");
