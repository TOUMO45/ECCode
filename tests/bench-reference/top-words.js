'use strict';
// Reference solution for bench/suites/followup/top-words (run inside the sandbox).
const fs = require('fs');
const src = fs.readFileSync('src/text.js', 'utf8').replace('module.exports = { words, readingMinutes };', [
  '/** The n most frequent words as [word, count], most frequent first, ties alphabetical. */',
  'function topWords(text, n) {',
  '  const counts = new Map();',
  '  for (const w of words(text)) counts.set(w, (counts.get(w) || 0) + 1);',
  '  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);',
  '}',
  '',
  'module.exports = { words, readingMinutes, topWords };',
].join('\n'));
fs.writeFileSync('src/text.js', src);
fs.appendFileSync('src/text.test.js', "\ntest('topWords', () => {\n  assert.deepStrictEqual(require('./text').topWords('b a b', 1), [['b', 2]]);\n});\n");
