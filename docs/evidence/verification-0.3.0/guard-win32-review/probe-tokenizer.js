'use strict';
// Review probe 2: the win32 branch of splitCommands, compared with what bash (Git Bash on Windows) does.
// Run: node docs/evidence/verification-0.3.0/guard-win32-review/probe-tokenizer.js
const path = require('path');
const GUARD = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'hooks', 'guard.js');
const g = require(GUARD);
const words = (src) => g.splitCommands(src).map((ws) => ws.map((w) => (w.dynamic ? `${w.text}<dyn>` : w.text)));

let fails = 0;
function expect(platform, src, want, note = '') {
  g.__setPlatform(platform);
  const got = words(src);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${platform}] ${JSON.stringify(src)}\n       -> ${JSON.stringify(got)}${ok ? '' : `\n       want ${JSON.stringify(want)}`}${note ? `\n       ${note}` : ''}`);
}

console.log('== bash escapes must survive on win32');
expect('win32', 'echo a\\ b', [['echo', 'a b']]);
expect('win32', 'echo \\"x\\"', [['echo', '"x"']]);
expect('win32', 'echo \\$HOME', [['echo', '$HOME']], 'escaped $ is literal and not dynamic');
expect('win32', 'a \\\\ b', [['a', '\\', 'b']], 'doubled backslash = one literal');
expect('win32', 'echo a \\\nb', [['echo', 'a', 'b']], 'line continuation');
expect('win32', 'find . -exec rm {} \\;', [['find', '.', '-exec', 'rm', '{}', ';']], 'escaped ; does not split');
expect('win32', 'echo a\\|b', [['echo', 'a|b']]);
expect('win32', 'echo a\\&b', [['echo', 'a&b']]);
expect('win32', "echo \\'x\\'", [['echo', "'x'"]]);
expect('win32', 'echo \\#x', [['echo', '#x']]);
expect('win32', 'echo x\\>y', [['echo', 'x>y']]);
expect('win32', 'echo "C:\\Users\\me"', [['echo', 'C:\\Users\\me']], 'double quotes keep the backslash as bash does');
expect('win32', 'echo "a\\"b"', [['echo', 'a"b']]);
expect('win32', "echo 'C:\\x'", [['echo', 'C:\\x']]);
expect('win32', 'echo x > "C:\\Users\\me dir\\notes.txt"', [['echo', 'x', '>', 'C:\\Users\\me dir\\notes.txt']], 'quoted path with embedded space');

console.log('\n== native paths keep their separators on win32 only');
expect('win32', 'cd C:\\x && echo y > C:\\z\\file', [['cd', 'C:\\x'], ['echo', 'y', '>', 'C:\\z\\file']]);
expect('linux', 'cd C:\\x && echo y > C:\\z\\file', [['cd', 'C:x'], ['echo', 'y', '>', 'C:zfile']]);
expect('win32', 'echo x > C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\eccode-outside-ab\\notes.txt', [['echo', 'x', '>', 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\eccode-outside-ab\\notes.txt']], '~ and - are path chars');
expect('win32', 'echo x > \\\\server\\share\\.eccode\\state.json', [['echo', 'x', '>', '\\server\\share\\.eccode\\state.json']], 'UNC: the leading pair collapses to one (bash would too)');
expect('win32', 'echo x > .eccode\\\\state.json', [['echo', 'x', '>', '.eccode\\state.json']]);
expect('win32', 'echo x > $HOME\\.eccode\\state.json', [['echo', 'x', '>', '$HOME\\.eccode\\state.json<dyn>']]);
expect('win32', 'echo x > %USERPROFILE%\\.eccode\\state.json', [['echo', 'x', '>', '%USERPROFILE%\\.eccode\\state.json']], 'cmd-style variable: bash would not expand it');

console.log('\n== where the win32 reading and Git Bash disagree (bash drops a backslash before a path char)');
// Git Bash: `.\.` is `..`. The win32 tokenizer keeps `.\.`, which path.win32.resolve reads as two `.` segments.
for (const src of ['echo x > .eccode/drafts/.\\./state.json', 'echo x > .eccode/drafts/.\\./.\\./src/server.js', 'echo x > src/api/.\\./core/x.js']) {
  g.__setPlatform('win32');
  const target = words(src)[0][3];
  const bashTarget = target.replace(/\\(?=[A-Za-z0-9_.~-])/g, '');
  const root = 'C:\\proj';
  const guardSees = path.win32.relative(root, path.win32.resolve(root, target)).split('\\').join('/');
  const bashWrites = path.win32.relative(root, path.win32.resolve(root, bashTarget)).split('\\').join('/');
  console.log(`${JSON.stringify(src)}\n       guard (win32) resolves the target to: ${guardSees}\n       Git Bash actually writes:              ${bashWrites}${guardSees !== bashWrites ? '\n       MISMATCH: the guard judges a different file than the shell writes' : ''}`);
  fails += guardSees !== bashWrites ? 0 : 0; // reported, not counted: this is the finding
}
g.__setPlatform(process.platform);
console.log(`\n${fails} unexpected tokenizer result(s).`);
process.exit(fails ? 1 : 0);
