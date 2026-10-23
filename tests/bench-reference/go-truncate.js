'use strict';
// Reference solution for bench/suites/followup/go-truncate (run inside the sandbox).
const fs = require('fs');
fs.appendFileSync('text.go', [
  '',
  '// Truncate shortens s to at most max runes, ending with "…" when it cut anything.',
  'func Truncate(s string, max int) string {',
  '\tif max < 1 {',
  '\t\treturn ""',
  '\t}',
  '\tif RuneLen(s) <= max {',
  '\t\treturn s',
  '\t}',
  '\treturn string([]rune(s)[:max-1]) + "…"',
  '}',
  '',
].join('\n'));
fs.appendFileSync('text_test.go', '\nfunc TestTruncate(t *testing.T) {\n\tif Truncate("hello", 3) != "he…" {\n\t\tt.Fatal("truncate broken")\n\t}\n}\n');
