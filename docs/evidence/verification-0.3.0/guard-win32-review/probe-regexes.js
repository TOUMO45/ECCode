'use strict';
// Review probe 1: RECORD_FILES / RECORD_AREA (via SHELL_WRITE, read from the source) / ECCODE_WORD against adversarial strings.
// Run: node docs/evidence/verification-0.3.0/guard-win32-review/probe-regexes.js
const path = require('path');
const fs = require('fs');
const GUARD = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'hooks', 'guard.js');
const g = require(GUARD);
const src = fs.readFileSync(GUARD, 'utf8');
const RECORD_AREA = new RegExp(/const RECORD_AREA = String\.raw`([^`]*)`/.exec(src)[1]);

let fails = 0;
function check(label, re, s, expect) {
  const got = re.test(s);
  const ok = got === expect;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(12)} expect=${String(expect).padEnd(5)} got=${String(got).padEnd(5)} ${JSON.stringify(s)}`);
}

console.log('== RECORD_FILES (path as the Edit tool / checkEdit sees it) — expect=true means "record, deny"');
const recordTrue = [
  '.eccode/state.json',
  '.eccode\\state.json',
  'C:\\Users\\me\\.eccode\\memory\\records\\x.json',
  'C:/Users/me/.eccode/memory/records/x.json',
  'C:\\Users\\me/.eccode\\memory/records\\x.json', // mixed separators
  'C:\\\\Users\\\\me\\\\.eccode\\\\memory\\\\records\\\\x.json', // doubled backslashes (quoted program)
  '\\\\server\\share\\.eccode\\state.json', // UNC
  '~/.eccode/memory/records/x.json',
  '/home/me/.eccode/events.jsonl',
  '.eccode//state.json',
  '.eccode/reviews/rev-1.json',
  '.eccode\\reviews\\rev-1.json',
  '.eccode/reviews/draftsX/a.json',
  '.eccode/reviews/drafts', // the directory itself (no trailing separator): matched as record (pre-existing)
  '.eccode/.lock',
  '.eccode/improvements/x.json',
  '.eccode/evidence/x.log',
  '.eccode/handoffs/x.json',
  '.eccode/delivery/x.json',
  'a/b/.eccode/config.json',
  'C:\\Users\\me with space\\.eccode\\state.json',
  '.eccode/memory/', // the memory directory with trailing separator
];
for (const s of recordTrue) check('RECORD_FILES', g.RECORD_FILES, s, true);
const recordFalse = [
  '.eccode/drafts/x.json',
  '.eccode\\drafts\\x.json',
  '.eccode/reviews/drafts/a.json',
  '.eccode\\reviews\\drafts\\a.json',
  '.eccode/artifacts/arch.md',
  'src/eccode/state.json',
  '.eccodex/state.json',
  'my.eccode/state.json',
  '.ECCODE/state.json', // uppercase: not matched (Windows FS is case-insensitive — see findings)
  '.eccode/State.json',
  '.eccode%2Fstate.json', // URL-encoded
  '.eccode/state.json.', // trailing dot
  '.eccode/memory', // the directory itself, no trailing separator (pre-existing: not matched)
  '.eccode',
  '.eccode/STATE.JSON',
  'eccode/memory/x.json',
  '.eccode-backup/state.json',
  '.eccode/states.json',
  '.eccode/eventsXjsonl',
  '.eccode/memory-notes/x.json',
];
for (const s of recordFalse) check('RECORD_FILES', g.RECORD_FILES, s, false);

console.log('\n== RECORD_AREA as the raw-command check uses it (SHELL_WRITE = write verb + [^|;&]* + RECORD_AREA)');
const SHELL_WRITE = new RegExp(String.raw`(>|\btee\b|\b(?:sed|perl)\s+(?:-\w+\s+)*-\w*i|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bdd\b|\bln\b|\binstall\b|\brsync\b|\btouch\b)[^|;&]*${RECORD_AREA.source}`);
const rawTrue = [
  'echo x > C:\\Users\\me\\.eccode\\memory\\records\\x.json',
  'echo x > "C:\\Users\\me with space\\.eccode\\memory\\records\\x.json"',
  'echo x > .eccode\\\\state.json',
  'echo x > \\\\server\\share\\.eccode\\state.json',
  'echo x > $HOME\\.eccode\\memory\\records\\x.json',
  'echo x > %USERPROFILE%\\.eccode\\memory\\records\\x.json',
  'echo x > ~/.eccode/memory/records/x.json',
  'cp a.json ..\\other\\.eccode\\state.json',
  'echo x > .\\.eccode\\state.json',
  'echo x > C:/Users/me/.eccode/memory\\records/x.json',
  "node -e \"require('fs').writeFileSync('C:\\\\Users\\\\me\\\\.eccode\\\\state.json','{}')\"".replace(/writeFileSync.*/, 'x') + ' > .eccode\\\\\\\\state.json', // quadrupled
  'echo x > my.eccode/state.json', // pre-existing FP: RECORD_AREA has no left anchor in SHELL_WRITE
];
for (const s of rawTrue) check('SHELL_WRITE', SHELL_WRITE, s, true);
const rawFalse = [
  'echo x > .eccode/drafts/x.json',
  'echo x > .eccode\\drafts\\x.json',
  'echo x > .eccode/reviews/drafts/x.json',
  'echo x > src/eccode/state.json',
  'echo x > .eccode/./state.json', // NOT matched by the raw check: path normalisation escape (pre-existing, see findings)
  'echo x > .eccode/drafts/../state.json', // same
  'echo x > .eccode/drafts/.\\./state.json', // same, Git-Bash form (bash reads .\. as ..)
  'echo x > .ECCODE/state.json', // uppercase
  'echo x > .eccode%2Fstate.json',
  'cat .eccode/state.json',
  'echo x > .eccodex/state.json',
];
for (const s of rawFalse) check('SHELL_WRITE', SHELL_WRITE, s, false);

console.log('\n== ECCODE_WORD (command word that is the CLI)');
const wordTrue = ['eccode', 'eccode.js', 'bin/eccode.js', './bin/eccode.js', 'C:\\proj\\.claude\\eccode\\bin\\eccode.js', 'C:/proj/bin/eccode.js', '\\\\server\\share\\eccode', '/usr/local/bin/eccode', '.claude\\eccode\\bin\\eccode.js', 'node_modules/.bin/eccode'];
for (const s of wordTrue) check('ECCODE_WORD', g.ECCODE_WORD, s, true);
const wordFalse = [
  'myeccode.js', 'eccode.cmd', 'eccode.ps1', 'eccode.exe', 'ECCODE', 'Eccode.js', 'eccode.JS', 'eccodex', 'eccode/', 'eccode.js.bak', 'src/eccode/index.js', 'eccode-cli', 'C:\\eccode\\eccode.cmd', 'eccode.js ', ' eccode',
];
for (const s of wordFalse) check('ECCODE_WORD', g.ECCODE_WORD, s, false);

console.log(`\n${fails} unexpected result(s) (every line above is tagged with the reviewer's expectation; "ok" lines marked pre-existing in comments are documented residuals, not approvals).`);
process.exit(fails ? 1 : 0);
