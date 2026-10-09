'use strict';
// Re-review probe for 4fc7e87: the tokenizer without a platform branch, the F-1 cases, bash escapes,
// and the quoted CI-131 target as the Windows runner's path.win32 would resolve it.
// Run: node probe-tokenizer-4fc7e87.js <worktree root of 4fc7e87>
const path = require('path');
const g = require(path.join(process.argv[2], 'scripts', 'hooks', 'guard.js'));
const words = (s) => g.splitCommands(s).map((ws) => ws.map((w) => w.text));
const show = (s) => console.log(JSON.stringify(s), '->', JSON.stringify(words(s)));
console.log('== tokenizer on 4fc7e87 (__setPlatform exported:', typeof g.__setPlatform, ')');
for (const s of [
  'echo x > .eccode/drafts/.\\./state.json',
  'echo x > .eccode/drafts/.\\./.\\./src/server.js',
  'echo x > src/api/.\\./core/x.js',
  'cd /tmp && echo x > "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\eccode-outside-X\\notes.txt"',
  'cd /tmp && echo x > C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\eccode-outside-X\\notes.txt',
  'echo a\\ b', 'echo \\$x', 'a \\\\ b', 'echo a \\\nb', 'find . -exec rm {} \\;',
  'echo x > "C:\\Users\\me dir\\.eccode\\memory\\records\\x.json"',
  'node "C:\\proj\\.claude\\eccode\\bin\\eccode.js" gate reopen design --actor user --resolution ok',
]) show(s);
const root = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\eccode-proj-A';
console.log('\n== CI 131 on the runner, quoted target, path.win32:');
const t = words('cd /tmp && echo x > "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\eccode-outside-X\\notes.txt"')[1][3];
console.log('target:', t, '| isAbsolute:', path.win32.isAbsolute(t), '| rel from project:', path.win32.relative(root, path.win32.resolve(root, t)).split('\\').join('/'));
console.log('ECCODE_WORD on target:', g.ECCODE_WORD.test(t), '| eccodeActors:', JSON.stringify(g.eccodeActors(`cd /tmp && echo x > "${t}"`)));
console.log('\n== the .\\. targets as bash and the guard now both read them, resolved with path.win32 and path.posix:');
for (const s of ['echo x > .eccode/drafts/.\\./state.json', 'echo x > .eccode/drafts/.\\./.\\./src/server.js', 'echo x > src/api/.\\./core/x.js']) {
  const w = words(s)[0][3];
  console.log(JSON.stringify(w), '-> win32:', path.win32.relative(root, path.win32.resolve(root, w)).split('\\').join('/'), '| posix:', path.posix.relative('/p', path.posix.resolve('/p', w)));
}
